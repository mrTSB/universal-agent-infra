import { configureAgentProvider, logProviderConfig } from "./src/provider.ts";

const provider = configureAgentProvider();
logProviderConfig(provider);

if (provider.provider === "unconfigured") {
  process.exit(1);
}

await import("./src/main.ts");
