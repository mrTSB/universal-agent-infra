export type ProviderConfigResult = {
  provider: "anthropic" | "unconfigured";
  reason: string;
  warnings: string[];
};

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function hasEnv(name: string): boolean {
  return readEnv(name) !== undefined;
}

function setDisabled(name: string): void {
  process.env[name] = "0";
}

export function configureAgentProvider(): ProviderConfigResult {
  const warnings: string[] = [];
  const anthropicApiKey = readEnv("ANTHROPIC_API_KEY");

  // Force the Claude Agent SDK onto the direct Anthropic path every run.
  setDisabled("CLAUDE_CODE_USE_VERTEX");
  setDisabled("CLAUDE_CODE_USE_BEDROCK");
  setDisabled("CLAUDE_CODE_USE_FOUNDRY");

  if (
    hasEnv("CLAUDE_CODE_USE_VERTEX") ||
    hasEnv("ANTHROPIC_VERTEX_PROJECT_ID") ||
    hasEnv("GOOGLE_APPLICATION_CREDENTIALS")
  ) {
    warnings.push(
      "Legacy Vertex-related env vars were detected, but this runner now ignores Vertex and always uses ANTHROPIC_API_KEY."
    );
  }

  if (hasEnv("MOBIUS_AGENT_PROVIDER")) {
    warnings.push(
      "MOBIUS_AGENT_PROVIDER is ignored. This runner is now Anthropic-only."
    );
  }

  if (hasEnv("GEMINI_API_KEY")) {
    warnings.push(
      "GEMINI_API_KEY does not power the main agent. It only helps Browserbase Stagehand tools when browser automation is enabled."
    );
  }

  if (!anthropicApiKey) {
    return {
      provider: "unconfigured",
      reason:
        "Missing ANTHROPIC_API_KEY. Add it to /Users/tanvirb/Documents/Code/universal-agent-infra/.env or export it in your shell before running `bun run agent`.",
      warnings,
    };
  }

  return {
    provider: "anthropic",
    reason:
      "ANTHROPIC_API_KEY is set, so the agent will always use direct Anthropic auth.",
    warnings,
  };
}

export function logProviderConfig(result: ProviderConfigResult): void {
  const prefix = "[provider]";

  if (result.provider === "unconfigured") {
    console.error(`${prefix} ${result.reason}`);
  } else {
    console.log(`${prefix} Using ${result.provider} auth. ${result.reason}`);
  }

  for (const warning of result.warnings) {
    console.warn(`${prefix} ${warning}`);
  }
}
