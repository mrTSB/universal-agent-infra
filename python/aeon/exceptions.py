class AeonError(Exception):
    pass


class ServerNotRunningError(AeonError):
    def __str__(self):
        return (
            "Cannot connect to Aeon server. "
            "From the repository root, start it with: bun run agent "
            "(or pnpm run agent)."
        )


class AgentNotFoundError(AeonError):
    pass


class ObjectiveNotFoundError(AeonError):
    pass
