import json
from typing import AsyncGenerator

from .models import AgentEvent


async def stream_agent_events(ws_url: str, agent_id: str) -> AsyncGenerator[AgentEvent, None]:
    """Async generator that yields AgentEvent objects from the agent's WebSocket feed."""
    try:
        import websockets
    except ImportError:
        raise ImportError(
            "websockets is required for streaming. "
            "Install with: pip install websockets"
        )

    url = f"{ws_url}/agents/{agent_id}"
    async with websockets.connect(url) as ws:
        async for raw in ws:
            try:
                yield AgentEvent.from_dict(json.loads(raw))
            except (json.JSONDecodeError, Exception):
                continue
