// Load persisted API keys before anything else reads process.env
import "./src/config.ts";

import { configureAgentProvider, logProviderConfig } from "./src/provider.ts";

const provider = configureAgentProvider();
logProviderConfig(provider);

// Don't exit if key is missing — the dashboard settings page lets users
// enter keys at runtime without needing shell env vars.
if (provider.provider === "unconfigured") {
  console.warn("[config] No ANTHROPIC_API_KEY found. Open the dashboard and enter your keys in Settings.");
}

await import("./src/main.ts");
