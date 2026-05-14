class MobiusError(Exception):
    pass


class ServerNotRunningError(MobiusError):
    def __str__(self):
        return (
            "Cannot connect to Mobius server. "
            "Start it with: bun run agent  (from the project root)\n"
            "Or use: mobius start"
        )


class AgentNotFoundError(MobiusError):
    pass
