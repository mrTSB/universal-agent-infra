import requests
from typing import List

from .exceptions import AgentNotFoundError, MobiusError, ServerNotRunningError
from .models import Agent, AgentEvent, ConfigStatus


class MobiusClient:
    """
    Synchronous HTTP client for the Mobius agent infrastructure.

    Usage:
        client = MobiusClient()
        agent = client.create_agent("Research AI trends in 2025")
        print(agent.id, agent.status)

    Streaming (async):
        import asyncio

        async def watch():
            async for event in client.stream(agent_id):
                print(event.type, event.data)

        asyncio.run(watch())
    """

    def __init__(self, base_url: str = "http://localhost:3000"):
        self.base_url = base_url.rstrip("/")
        self._ws_url = (
            self.base_url
            .replace("https://", "wss://")
            .replace("http://", "ws://")
        )
        self._session = requests.Session()

    def _req(self, method: str, path: str, **kwargs) -> requests.Response:
        try:
            r = self._session.request(method, f"{self.base_url}{path}", timeout=30, **kwargs)
        except requests.exceptions.ConnectionError:
            raise ServerNotRunningError()
        if r.status_code == 404:
            raise AgentNotFoundError(f"Not found: {path}")
        r.raise_for_status()
        return r

    # ── Agent CRUD ───────────────────────────────────────────────────────────

    def list_agents(self) -> List[Agent]:
        """Return all agents regardless of status."""
        return [Agent.from_dict(a) for a in self._req("GET", "/api/agents").json()]

    def create_agent(self, task: str) -> Agent:
        """Create and immediately start an agent with the given task description."""
        return Agent.from_dict(self._req("POST", "/api/agents", json={"task": task}).json())

    def get_agent(self, agent_id: str) -> Agent:
        """Fetch current state of a single agent."""
        return Agent.from_dict(self._req("GET", f"/api/agents/{agent_id}").json())

    def stop_agent(self, agent_id: str) -> None:
        """Halt a running agent."""
        self._req("DELETE", f"/api/agents/{agent_id}")

    def send_message(self, agent_id: str, message: str) -> dict:
        """Inject a human message into the agent's conversation."""
        return self._req("POST", f"/api/agents/{agent_id}", json={"message": message}).json()

    # ── Analytics & Summary ──────────────────────────────────────────────────

    def get_analytics(self, agent_id: str) -> dict:
        """Return turn-by-turn analytics (tool usage, phases, costs)."""
        return self._req("GET", f"/api/agents/{agent_id}/analytics").json()

    def get_summary(self, agent_id: str) -> dict:
        """Fetch (or trigger generation of) an AI-written run summary."""
        return self._req("GET", f"/api/agents/{agent_id}/ai-summary").json()

    def invalidate_summary(self, agent_id: str) -> None:
        """Clear the cached AI summary so it regenerates on next fetch."""
        self._req("DELETE", f"/api/agents/{agent_id}/ai-summary")

    # ── Config ───────────────────────────────────────────────────────────────

    def get_config(self) -> ConfigStatus:
        """Return which API keys are currently configured (values never exposed)."""
        return ConfigStatus.from_dict(self._req("GET", "/api/config").json())

    def set_config(self, **keys: str) -> None:
        """
        Persist API keys to the server.

        Example:
            client.set_config(ANTHROPIC_API_KEY="sk-ant-...")
        """
        self._req("POST", "/api/config", json=keys)

    # ── Streaming ────────────────────────────────────────────────────────────

    async def stream(self, agent_id: str):
        """
        Async generator – yields real-time AgentEvent objects.

        Usage:
            async for event in client.stream(agent_id):
                print(event.type, event.data)
        """
        from .streaming import stream_agent_events
        async for event in stream_agent_events(self._ws_url, agent_id):
            yield event
