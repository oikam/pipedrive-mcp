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
const baseUrl = process.env.BASE_URL ?? "https://pipedrive-mcp-production-5a89.up.railway.app";

// In-memory store of one-time auth codes (code -> expiry)
const authCodes = new Map<string, number>();

const client = new PipedriveClient(apiToken);

function createServer(): McpServer {
  const server = new McpServer({ name: "pipedrive-mcp-server", version: "1.0.0" });
  registerTools(server, client);
  return server;
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Health ────────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ── OAuth discovery ───────────────────────────────────────────────────────────

app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
  });
});

// ── OAuth authorize ───────────────────────────────────────────────────────────
// Claude.ai redirects the user here. We immediately redirect back with a code
// since access is controlled by the client_secret at token exchange time.

app.get("/authorize", (req, res) => {
  const { client_id, redirect_uri, state, response_type } = req.query as Record<string, string>;

  if (response_type !== "code") {
    res.status(400).send("unsupported_response_type");
    return;
  }

  if (!oauthClientId || client_id !== oauthClientId) {
    res.status(401).send("invalid_client");
    return;
  }

  if (!redirect_uri) {
    res.status(400).send("missing redirect_uri");
    return;
  }

  // Generate a one-time code valid for 5 minutes
  const code = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  authCodes.set(code, Date.now() + 5 * 60 * 1000);

  const redirect = new URL(redirect_uri);
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);

  res.redirect(redirect.toString());
});

// ── OAuth token ───────────────────────────────────────────────────────────────

app.post("/oauth/token", (req, res) => {
  const { grant_type, code, client_id, client_secret } = req.body as Record<string, string>;

  if (!oauthClientId || !oauthClientSecret) {
    res.status(500).json({ error: "server_error", error_description: "OAuth not configured" });
    return;
  }

  if (client_id !== oauthClientId || client_secret !== oauthClientSecret) {
    res.status(401).json({ error: "invalid_client" });
    return;
  }

  if (grant_type === "authorization_code") {
    const expiry = authCodes.get(code);
    if (!expiry || Date.now() > expiry) {
      res.status(400).json({ error: "invalid_grant", error_description: "Code expired or invalid" });
      return;
    }
    authCodes.delete(code);
  } else if (grant_type !== "client_credentials") {
    res.status(400).json({ error: "unsupported_grant_type" });
    return;
  }

  res.json({
    access_token: mcpAuthToken,
    token_type: "bearer",
    expires_in: 86400,
  });
});

// ── MCP endpoint ──────────────────────────────────────────────────────────────

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
