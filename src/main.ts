import { startAPIServer } from "./api-server.ts";

// Start the multi-agent HTTP + WebSocket server.
// Agents are created on-demand via POST /api/agents — nothing starts automatically.
startAPIServer();
