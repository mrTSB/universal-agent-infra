from .agent import Agent, Task, Run, SONNET, HAIKU, OPUS
from .runtime import Runtime
from .swarm import Swarm
from .client import AeonClient
from .exceptions import AgentNotFoundError, AeonError, ServerNotRunningError
from .models import AgentEvent, ConfigStatus, CustomTool, ToolInputSchema, JsonSchemaProperty

__version__ = "0.1.0"

__all__ = [
    # Core API
    "Agent",
    "Task",
    "Run",
    "Runtime",
    "Swarm",
    # Model constants
    "SONNET",
    "HAIKU",
    "OPUS",
    # Low-level client
    "AeonClient",
    # Models
    "AgentEvent",
    "ConfigStatus",
    "CustomTool",
    "ToolInputSchema",
    "JsonSchemaProperty",
    # Exceptions
    "AeonError",
    "ServerNotRunningError",
    "AgentNotFoundError",
]
