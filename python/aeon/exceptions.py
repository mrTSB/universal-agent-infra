class AeonError(Exception):
    pass


class ServerNotRunningError(AeonError):
    def __str__(self):
        return (
            "Cannot connect to Aeon server. "
            "Start it with: bun run agent  (from the project root)\n"
            "Or use: aeon start"
        )


class AgentNotFoundError(AeonError):
    pass
