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
