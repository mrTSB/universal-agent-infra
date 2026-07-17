"""Install-level scenarios for the published Aeon Python SDK.

The parent process uses only the standard library. It creates a clean virtual
environment, performs a non-editable pip install, starts a local HTTP contract
server, and launches this file again with the installed interpreter.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_DIR = ROOT / "python"


class ScenarioState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.tools: Dict[str, Dict[str, Any]] = {}
        self.agents: Dict[str, Dict[str, Any]] = {}
        self.objectives: Dict[str, Dict[str, Any]] = {}
        self.agent_requests: List[Dict[str, Any]] = []
        self.objective_requests: List[Dict[str, Any]] = []
        self.messages: List[Dict[str, Any]] = []
        self.config_updates: List[Dict[str, Any]] = []
        self.summary_invalidations = 0
        self._next_tool = 1
        self._next_agent = 1
        self._next_objective = 1

    def create_tool(self, body: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            tool_id = f"tool-{self._next_tool}"
            self._next_tool += 1
            tool = {
                **body,
                "id": tool_id,
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z",
            }
            self.tools[tool_id] = tool
            return tool.copy()

    def create_agent(self, body: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            agent_id = f"run-{self._next_agent}"
            self._next_agent += 1
            agent = {
                "id": agent_id,
                "task": body.get("task", ""),
                "status": "running",
                "createdAt": "2026-01-01T00:00:00Z",
                "url": f"/agents/{agent_id}",
                "turnCount": 0,
                "totalCostUsd": 0.0,
                "workspacePath": f"/tmp/aeon/{agent_id}",
            }
            self.agents[agent_id] = agent
            self.agent_requests.append(body)
            return agent.copy()

    def create_objective(self, body: Dict[str, Any]) -> Dict[str, Any]:
        with self.lock:
            objective_id = f"objective-{self._next_objective}"
            self._next_objective += 1
            steps = [
                {
                    "id": f"step-{index}",
                    "objectiveId": objective_id,
                    "title": step["title"],
                    "status": "pending",
                }
                for index, step in enumerate(body.get("playbook", {}).get("steps", []), 1)
            ]
            approval = {
                "id": f"approval-{self._next_objective}",
                "objectiveId": objective_id,
                "status": "pending",
                "risk": "high",
                "summary": "Approve scenario action",
            }
            objective = {
                **body,
                "id": objective_id,
                "status": "waiting",
                "cycleCount": 1,
                "totalCostUsd": 0.01,
                "totalTurns": 1,
                "result": None,
                "lastError": None,
                "plan": steps,
                "events": [{"type": "objective.created", "payload": {}}],
                "memories": [{"kind": "episodic", "content": "First cycle complete"}],
                "actions": [{"tool": "lookup_weather", "status": "waiting_approval"}],
                "outcomes": [],
                "approvals": [approval],
                "createdAt": "2026-01-01T00:00:00Z",
            }
            self.objectives[objective_id] = objective
            self.objective_requests.append(body)
            return objective.copy()


def _handler_for(state: ScenarioState):
    class ScenarioHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, _format: str, *args: Any) -> None:
            pass

        def _read_json(self) -> Dict[str, Any]:
            length = int(self.headers.get("Content-Length", "0"))
            if not length:
                return {}
            return json.loads(self.rfile.read(length).decode("utf-8"))

        def _reply(self, body: Any, status: int = 200) -> None:
            payload = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def _not_found(self) -> None:
            self._reply({"error": "Not found"}, 404)

        def do_GET(self) -> None:
            path = urlparse(self.path).path
            if path == "/api/v1/objectives":
                with state.lock:
                    objectives = [objective.copy() for objective in state.objectives.values()]
                self._reply(objectives)
                return
            if path.startswith("/api/v1/objectives/"):
                parts = path.strip("/").split("/")
                objective_id = parts[3]
                with state.lock:
                    objective = state.objectives.get(objective_id)
                if not objective:
                    self._not_found()
                    return
                if len(parts) == 4:
                    self._reply(objective)
                    return
                resources = ("plan", "events", "memories", "actions", "outcomes", "approvals")
                if len(parts) == 5 and parts[4] in resources:
                    self._reply(objective.get(parts[4], []))
                    return
            if path == "/api/config":
                self._reply({
                    "keys": {
                        "ANTHROPIC_API_KEY": True,
                        "OPENROUTER_API_KEY": False,
                    }
                })
                return
            if path == "/api/tools":
                with state.lock:
                    tools = [tool.copy() for tool in state.tools.values()]
                self._reply(tools)
                return
            if path.startswith("/api/tools/"):
                tool_id = path.rsplit("/", 1)[-1]
                with state.lock:
                    tool = state.tools.get(tool_id)
                self._reply(tool) if tool else self._not_found()
                return
            if path == "/api/agents":
                with state.lock:
                    agents = [agent.copy() for agent in state.agents.values()]
                self._reply(agents)
                return
            if path.startswith("/api/agents/"):
                parts = path.strip("/").split("/")
                agent_id = parts[2]
                with state.lock:
                    agent = state.agents.get(agent_id)
                if not agent:
                    self._not_found()
                    return
                if len(parts) == 4 and parts[3] == "analytics":
                    self._reply({
                        "agentId": agent_id,
                        "turns": [{"turn": 1, "toolCount": 1}],
                        "totals": {"turns": agent["turnCount"]},
                    })
                    return
                if len(parts) == 4 and parts[3] == "ai-summary":
                    self._reply({"status": "complete", "summary": "Scenario completed."})
                    return
                if len(parts) == 4 and parts[3] == "artifacts":
                    self._reply({
                        "files": [{"path": "weather.md", "status": "new", "size_bytes": 42}],
                        "total_files": 1,
                        "total_size_bytes": 42,
                        "workspace": agent["workspacePath"],
                    })
                    return
                if len(parts) == 3:
                    self._reply(agent)
                    return
            self._not_found()

        def do_POST(self) -> None:
            path = urlparse(self.path).path
            body = self._read_json()
            if path == "/api/v1/objectives":
                self._reply(state.create_objective(body), 201)
                return
            if path.startswith("/api/v1/objectives/"):
                parts = path.strip("/").split("/")
                objective_id = parts[3]
                with state.lock:
                    objective = state.objectives.get(objective_id)
                if not objective:
                    self._not_found()
                    return
                if len(parts) == 5 and parts[4] == "events":
                    event = {
                        "id": f"event-{len(objective['events']) + 1}",
                        "objectiveId": objective_id,
                        **body,
                    }
                    with state.lock:
                        objective["events"].insert(0, event)
                        objective["status"] = "queued"
                    self._reply(event, 201)
                    return
                if len(parts) == 5 and parts[4] in ("pause", "resume", "cancel"):
                    statuses = {"pause": "waiting", "resume": "queued", "cancel": "cancelled"}
                    with state.lock:
                        objective["status"] = statuses[parts[4]]
                        if parts[4] == "cancel":
                            objective["result"] = body.get("reason")
                    self._reply(objective)
                    return
                if len(parts) == 7 and parts[4] == "approvals" and parts[6] == "resolve":
                    approval_id = parts[5]
                    with state.lock:
                        approval = next(
                            (item for item in objective["approvals"] if item["id"] == approval_id),
                            None,
                        )
                        if approval:
                            approval["status"] = body["status"]
                            approval["note"] = body.get("note")
                    self._reply(approval) if approval else self._not_found()
                    return
            if path == "/api/config":
                with state.lock:
                    state.config_updates.append(body)
                self._reply({"ok": True})
                return
            if path == "/api/tools":
                self._reply(state.create_tool(body), 201)
                return
            if path.endswith("/toggle") and path.startswith("/api/tools/"):
                tool_id = path.strip("/").split("/")[2]
                with state.lock:
                    tool = state.tools.get(tool_id)
                    if tool:
                        tool["enabled"] = not tool.get("enabled", True)
                        updated = tool.copy()
                    else:
                        updated = None
                self._reply(updated) if updated else self._not_found()
                return
            if path == "/api/agents":
                self._reply(state.create_agent(body), 201)
                return
            if path.startswith("/api/agents/"):
                parts = path.strip("/").split("/")
                agent_id = parts[2]
                with state.lock:
                    agent = state.agents.get(agent_id)
                if not agent:
                    self._not_found()
                    return
                if len(parts) == 4 and parts[3] == "resume":
                    with state.lock:
                        agent["status"] = "running"
                    self._reply({"id": agent_id, "status": "running", "resumed": True})
                    return
                if len(parts) == 4 and parts[3] == "replay":
                    replay = state.create_agent({"task": agent["task"], "replayOf": agent_id})
                    self._reply({
                        "id": replay["id"],
                        "status": replay["status"],
                        "replayed": True,
                        "originalId": agent_id,
                    })
                    return
                if len(parts) == 3:
                    text = body.get("text")
                    if not isinstance(text, str) or not text.strip():
                        self._reply({"error": "text is required"}, 400)
                        return
                    with state.lock:
                        state.messages.append(body)
                        agent["status"] = "stopped"
                        agent["turnCount"] = 2
                        agent["totalCostUsd"] = 0.0123
                    self._reply({"delivered": True})
                    return
            self._not_found()

        def do_PUT(self) -> None:
            path = urlparse(self.path).path
            if not path.startswith("/api/tools/"):
                self._not_found()
                return
            tool_id = path.rsplit("/", 1)[-1]
            body = self._read_json()
            with state.lock:
                tool = state.tools.get(tool_id)
                if tool:
                    tool.update(body)
                    updated = tool.copy()
                else:
                    updated = None
            self._reply(updated) if updated else self._not_found()

        def do_DELETE(self) -> None:
            path = urlparse(self.path).path
            if path.endswith("/ai-summary") and path.startswith("/api/agents/"):
                with state.lock:
                    state.summary_invalidations += 1
                self._reply({"invalidated": True})
                return
            if path.startswith("/api/tools/"):
                tool_id = path.rsplit("/", 1)[-1]
                with state.lock:
                    removed = state.tools.pop(tool_id, None)
                self._reply({"deleted": True}) if removed else self._not_found()
                return
            if path.startswith("/api/agents/"):
                agent_id = path.rsplit("/", 1)[-1]
                with state.lock:
                    agent = state.agents.get(agent_id)
                    if agent:
                        agent["status"] = "stopped"
                self._reply({"id": agent_id, "stopped": True}) if agent else self._not_found()
                return
            self._not_found()

    return ScenarioHandler


def _run(command: List[str], **kwargs: Any) -> subprocess.CompletedProcess:
    result = subprocess.run(command, text=True, capture_output=True, **kwargs)
    if result.returncode != 0:
        raise AssertionError(
            f"Command failed ({result.returncode}): {' '.join(command)}\n"
            f"stdout:\n{result.stdout}\nstderr:\n{result.stderr}"
        )
    return result


def _installed_scenario(server: str) -> None:
    from importlib.metadata import version

    import aeon
    from aeon import (
        AeonClient,
        Agent,
        Budget,
        HAIKU,
        JsonSchemaProperty,
        MemoryConfig,
        Objective,
        Playbook,
        PlaybookStep,
        Policy,
        RetryPolicy,
        Runtime,
        Swarm,
        Task,
        ToolInputSchema,
    )
    from aeon.swarm import SubAgent
    from aeon.tools import HttpTool

    source_root = Path(os.environ["AEON_SOURCE_ROOT"]).resolve()
    installed_module = Path(aeon.__file__).resolve()
    assert source_root not in installed_module.parents, installed_module
    assert version("aeon-agents") == aeon.__version__ == "0.1.0"

    client = AeonClient(server)
    assert client.get_config().keys == {
        "ANTHROPIC_API_KEY": True,
        "OPENROUTER_API_KEY": False,
    }
    client.set_config(OPENROUTER_API_KEY="test-key")

    schema = ToolInputSchema(
        properties={"query": JsonSchemaProperty("string", "Location to look up")},
        required=["query"],
    )
    low_level_tool = client.create_tool(
        "temporary_lookup",
        "A low-level client CRUD scenario",
        {"type": "http", "url": "http://example.invalid/lookup", "method": "POST"},
        schema,
    )
    assert client.get_tool(low_level_tool.id).name == "temporary_lookup"
    assert client.update_tool(low_level_tool.id, enabled=False).enabled is False
    assert client.toggle_tool(low_level_tool.id).enabled is True
    client.delete_tool(low_level_tool.id)

    tool = HttpTool(
        name="lookup_weather",
        description="Look up deterministic weather data",
        url="http://weather.test/current",
        method="GET",
        params={"city": ("string", "City name", True)},
    )
    agent = Agent(
        name="weather-agent",
        models=[HAIKU],
        tools=[tool],
        max_cost=1.5,
        max_steps=4,
        server=server,
    )
    task = Task(
        "Create a concise weather report for Seattle.",
        context="The audience is planning a bicycle commute.",
        success_criteria=["Mention temperature", "Recommend whether to carry rain gear"],
    )
    run = agent.run(task)
    assert run.status == "running"
    run.send("Use Celsius and finish the report.")
    result = run.wait(timeout=2, poll_interval=0.01)
    assert result == {
        "id": run.id,
        "status": "stopped",
        "turns": 2,
        "cost_usd": 0.0123,
        "workspace": f"/tmp/aeon/{run.id}",
    }
    assert agent.inspect(run.id) == result
    assert run.analytics()["totals"]["turns"] == 2
    assert run.summary()["summary"] == "Scenario completed."
    run.invalidate_summary()
    assert run.artifacts()["files"][0]["path"] == "weather.md"

    runtime = Runtime(server)
    assert run.id in {item.id for item in runtime.list()}
    assert any(item["id"] == run.id and item["turns"] == 2 for item in runtime.list_details())
    resumed = runtime.resume(run.id)
    assert resumed.id == run.id and resumed.status == "running"
    resumed.stop()
    replayed = runtime.replay(run.id)
    assert replayed.id != run.id and replayed.status == "running"
    replayed.stop()

    durable_agent = Agent(
        name="durable-weather-agent",
        models=[HAIKU, "claude-fallback"],
        tools=[tool],
        max_cost=2.0,
        max_steps=5,
        system_prompt="Prefer primary weather observations and concise reports.",
        policy=Policy(
            approval_required_tools=["lookup_weather"],
            tool_risk_levels={"lookup_weather": "high"},
            retry=RetryPolicy(max_attempts=4, initial_delay_ms=25),
        ),
        memory=MemoryConfig(max_context_items=12),
        server=server,
    )
    objective_run = durable_agent.pursue(Objective(
        goal="Maintain a current bicycle commute recommendation for Seattle.",
        context="Wake whenever a weather observation arrives.",
        success_criteria=["Recommendation cites the latest observation"],
        budget=Budget(max_cycles=1000),
        playbook=Playbook(
            name="commute-monitor",
            version="1",
            steps=[PlaybookStep("Observe weather"), PlaybookStep("Publish recommendation")],
        ),
        metadata={"tenant": "scenario"},
    ))
    assert objective_run.status == "waiting"
    assert objective_run.cycles == 1 and objective_run.cost == 0.01
    assert len(objective_run.plan()) == 2
    assert objective_run.memories()[0]["kind"] == "episodic"
    assert objective_run.actions()[0]["status"] == "waiting_approval"
    pending = objective_run.approvals(pending_only=True)
    assert len(pending) == 1
    approved = objective_run.approve(pending[0]["id"], note="Scenario approved")
    assert approved["status"] == "approved"
    objective_run.emit("weather.observed", {"temperature_c": 12}, dedupe_key="obs-1")
    assert objective_run.status == "queued"
    objective_run.pause("Pause scenario")
    idle = objective_run.wait_until_idle(timeout=1, poll_interval=0.01)
    assert idle["status"] == "waiting"
    objective_run.resume()
    objective_run.cancel("Scenario complete")
    assert objective_run.wait(timeout=1, poll_interval=0.01)["status"] == "cancelled"
    assert runtime.get_objective(objective_run.id).id == objective_run.id
    assert objective_run.id in {item.id for item in runtime.list_objectives()}

    swarm = Swarm(
        agents=[SubAgent("researcher", role="Find the key weather fact")],
        max_steps=2,
        server=server,
    )
    swarm_run = swarm.run("Summarize the weather fact.")
    assert swarm_run.status == "running"
    swarm_run.stop()

    print(json.dumps({
        "distribution": version("aeon-agents"),
        "module": str(installed_module),
        "run_id": run.id,
        "status": result["status"],
    }))


def _live_scenario(server: str) -> None:
    import asyncio

    from aeon import Agent, Task

    timeout = float(os.environ.get("AEON_E2E_TIMEOUT", "180"))
    max_cost = float(os.environ.get("AEON_E2E_MAX_COST", "0.25"))
    agent = Agent(
        name="sdk-live-smoke",
        max_cost=max_cost,
        max_steps=3,
        server=server,
    )
    run = agent.run(Task(
        "Respond with exactly AEON_E2E_OK, then finish.",
        context="This is a live SDK smoke test. Do not call tools or modify files.",
        success_criteria=["Complete successfully in one short response"],
    ))

    async def wait_for_expected_response() -> str:
        async for event in run.stream():
            messages: List[Dict[str, Any]] = []
            if event.type == "agent_message":
                messages = [event.data]
            elif event.type == "history":
                messages = event.data.get("messages", [])
            for message in messages:
                if message.get("type") == "agent_message":
                    text = message.get("text", "")
                    if "AEON_E2E_OK" in text:
                        return text
        raise AssertionError("Agent stream closed before returning AEON_E2E_OK")

    try:
        response = asyncio.run(asyncio.wait_for(wait_for_expected_response(), timeout))
    except BaseException:
        try:
            run.stop()
        finally:
            raise
    run.stop()
    result = run.result()
    assert result["status"] == "stopped", result
    print(json.dumps({"live_run_id": run.id, "response": response, **result}))


def test_installed_sdk_scenarios() -> None:
    uv = shutil.which("uv")
    assert uv, "uv is required to create the isolated test environment"
    state = ScenarioState()
    server = ThreadingHTTPServer(("127.0.0.1", 0), _handler_for(state))
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    base_url = f"http://127.0.0.1:{server.server_address[1]}"

    try:
        with tempfile.TemporaryDirectory(prefix="aeon-sdk-e2e-") as temp_dir:
            temp = Path(temp_dir)
            venv = temp / "venv"
            _run([uv, "venv", "--seed", "--python", sys.executable, str(venv)])
            venv_python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")

            install_env = os.environ.copy()
            install_env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
            _run([
                str(venv_python),
                "-m",
                "pip",
                "install",
                "--no-cache-dir",
                str(PACKAGE_DIR),
            ], cwd=temp, env=install_env)

            scenario_env = os.environ.copy()
            scenario_env.pop("PYTHONPATH", None)
            scenario_env["PYTHONNOUSERSITE"] = "1"
            scenario_env["AEON_SOURCE_ROOT"] = str(PACKAGE_DIR)
            contract = _run([
                str(venv_python),
                str(Path(__file__).resolve()),
                "--installed-scenario",
                base_url,
            ], cwd=temp, env=scenario_env)
            print(contract.stdout.strip())

            if os.environ.get("AEON_E2E_LIVE") == "1":
                live_server = os.environ.get("AEON_SERVER", "http://localhost:3000")
                live = _run([
                    str(venv_python),
                    str(Path(__file__).resolve()),
                    "--live-scenario",
                    live_server,
                ], cwd=temp, env=scenario_env)
                print(live.stdout.strip())

        weather_request = next(
            body for body in state.agent_requests
            if "[Agent: weather-agent]" in body.get("task", "")
        )
        assert weather_request["maxCostUsd"] == 1.5
        assert "Context:\nThe audience is planning a bicycle commute." in weather_request["task"]
        assert "Step limit: complete within 4 turns." in weather_request["task"]
        assert state.messages == [{"text": "Use Celsius and finish the report."}]
        assert state.config_updates == [{"OPENROUTER_API_KEY": "test-key"}]
        assert state.summary_invalidations == 1

        synced_tool = next(tool for tool in state.tools.values() if tool["name"] == "lookup_weather")
        assert synced_tool["executor"] == {
            "type": "http",
            "url": "http://weather.test/current",
            "method": "GET",
        }
        assert synced_tool["inputSchema"]["required"] == ["city"]

        swarm_request = next(body for body in state.agent_requests if "subAgents" in body)
        assert swarm_request["subAgents"]["researcher"]["model"] == "sonnet"

        objective_request = state.objective_requests[0]
        assert objective_request["agent"] == {
            "name": "durable-weather-agent",
            "model": "claude-haiku-4-5",
            "fallbackModel": "claude-fallback",
            "systemPrompt": "Prefer primary weather observations and concise reports.",
            "tools": ["lookup_weather"],
        }
        assert objective_request["budget"] == {
            "maxCycles": 1000,
            "maxCostUsd": 2.0,
            "maxTurnsPerCycle": 5,
        }
        assert objective_request["policy"]["retry"]["maxAttempts"] == 4
        assert objective_request["memory"]["maxContextItems"] == 12
        assert objective_request["playbook"]["steps"][0]["title"] == "Observe weather"
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=5)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--installed-scenario":
        _installed_scenario(sys.argv[2])
    elif len(sys.argv) == 3 and sys.argv[1] == "--live-scenario":
        _live_scenario(sys.argv[2])
    else:
        test_installed_sdk_scenarios()
