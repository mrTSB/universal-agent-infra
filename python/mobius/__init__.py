from .agent import Agent, Task, Run, SONNET, HAIKU, OPUS
from .client import MobiusClient
from .exceptions import AgentNotFoundError, MobiusError, ServerNotRunningError
from .models import AgentEvent, ConfigStatus, CustomTool, ToolInputSchema, JsonSchemaProperty

__version__ = "0.1.0"

__all__ = [
    # High-level API
    "Agent",
    "Task",
    "Run",
    # Model constants
    "SONNET",
    "HAIKU",
    "OPUS",
    # Low-level client (for direct API access)
    "MobiusClient",
    # Models
    "AgentEvent",
    "ConfigStatus",
    "CustomTool",
    "ToolInputSchema",
    "JsonSchemaProperty",
    # Exceptions
    "MobiusError",
    "ServerNotRunningError",
    "AgentNotFoundError",
]
