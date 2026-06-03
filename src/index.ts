import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PipedriveClient } from "./pipedrive.js";
import { registerTools } from "./tools.js";

const apiToken = process.env.PIPEDRIVE_API_TOKEN;
if (!apiToken) {
  console.error("Error: PIPEDRIVE_API_TOKEN environment variable is required.");
  process.exit(1);
}

const mcpAuthToken = process.env.MCP_AUTH_TOKEN;
if (!mcpAuthToken) {
  console.error("Error: MCP_AUTH_TOKEN environment variable is required.");
  process.exit(1);
}

const oauthClientId = process.env.OAUTH_CLIENT_ID;
const oauthClientSecret = process.env.OAUTH_CLIENT_SECRET;

const client = new PipedriveClient(apiToken);

function createServer(): McpServer {
  const server = new McpServer({ name: "pipedrive-mcp-server", version: "1.0.0" });
  registerTools(server, client);
  return server;
}

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// OAuth 2.0 client credentials endpoint
// Claude.ai sends client_id + client_secret and expects an access_token back
app.post("/oauth/token", (req, res) => {
  const { grant_type, client_id, client_secret } = req.body as Record<string, string>;

  if (grant_type !== "client_credentials") {
    res.status(400).json({ error: "unsupported_grant_type" });
    return;
  }

  if (!oauthClientId || !oauthClientSecret) {
    res.status(500).json({ error: "OAuth not configured on this server" });
    return;
  }

  if (client_id !== oauthClientId || client_secret !== oauthClientSecret) {
    res.status(401).json({ error: "invalid_client" });
    return;
  }

  // Return the MCP bearer token as the access token
  res.json({
    access_token: mcpAuthToken,
    token_type: "bearer",
    expires_in: 86400,
  });
});

app.post("/mcp", async (req, res) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader || authHeader !== `Bearer ${mcpAuthToken}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => transport.close());

  const server = createServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const port = parseInt(process.env.PORT ?? "3000", 10);
app.listen(port, () => {
  console.error(`Pipedrive MCP server listening on port ${port}`);
});
