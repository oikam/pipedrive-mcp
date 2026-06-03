import express from "express";
import { createHash } from "crypto";
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

interface AuthCodeData {
  expiry: number;
  challenge: string | undefined;
  challengeMethod: string;
  redirectUri: string;
}

const authCodes = new Map<string, AuthCodeData>();

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
  console.error("[OAuth] Discovery requested");
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256", "plain"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
  });
});

// ── OAuth authorize ───────────────────────────────────────────────────────────

app.get("/authorize", (req, res) => {
  const {
    client_id,
    redirect_uri,
    state,
    response_type,
    code_challenge,
    code_challenge_method,
  } = req.query as Record<string, string>;

  console.error("[OAuth] /authorize called:", JSON.stringify({ client_id, redirect_uri, state, response_type, code_challenge_method }));

  if (response_type !== "code") {
    res.status(400).json({ error: "unsupported_response_type" });
    return;
  }

  if (!oauthClientId || client_id !== oauthClientId) {
    console.error("[OAuth] invalid client_id:", client_id, "expected:", oauthClientId);
    res.status(401).json({ error: "invalid_client" });
    return;
  }

  if (!redirect_uri) {
    res.status(400).json({ error: "invalid_request", error_description: "missing redirect_uri" });
    return;
  }

  const code = createHash("sha256")
    .update(Math.random().toString() + Date.now().toString())
    .digest("hex")
    .slice(0, 32);

  authCodes.set(code, {
    expiry: Date.now() + 5 * 60 * 1000,
    challenge: code_challenge,
    challengeMethod: code_challenge_method ?? "plain",
    redirectUri: redirect_uri,
  });

  const redirect = new URL(redirect_uri);
  redirect.searchParams.set("code", code);
  if (state) redirect.searchParams.set("state", state);

  console.error("[OAuth] Redirecting to:", redirect.toString());
  res.redirect(redirect.toString());
});

// ── OAuth token ───────────────────────────────────────────────────────────────

app.post("/oauth/token", (req, res) => {
  console.error("[OAuth] /token called body:", JSON.stringify(req.body));

  const {
    grant_type,
    code,
    client_id,
    client_secret,
    code_verifier,
    redirect_uri,
  } = req.body as Record<string, string>;

  // Support client_secret_basic (Authorization header) as well
  let resolvedClientId = client_id;
  let resolvedClientSecret = client_secret;
  const authHeader = req.headers["authorization"];
  if (authHeader?.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
    const [id, secret] = decoded.split(":");
    resolvedClientId = resolvedClientId ?? id;
    resolvedClientSecret = resolvedClientSecret ?? secret;
  }

  if (!oauthClientId || !oauthClientSecret) {
    res.status(500).json({ error: "server_error", error_description: "OAuth not configured" });
    return;
  }

  if (resolvedClientId !== oauthClientId || resolvedClientSecret !== oauthClientSecret) {
    console.error("[OAuth] invalid credentials — got client_id:", resolvedClientId);
    res.status(401).json({ error: "invalid_client" });
    return;
  }

  if (grant_type === "authorization_code") {
    const stored = authCodes.get(code);
    if (!stored || Date.now() > stored.expiry) {
      console.error("[OAuth] invalid or expired code:", code);
      res.status(400).json({ error: "invalid_grant", error_description: "Code expired or invalid" });
      return;
    }

    // Validate PKCE if code_challenge was provided
    if (stored.challenge) {
      if (!code_verifier) {
        res.status(400).json({ error: "invalid_grant", error_description: "code_verifier required" });
        return;
      }
      let computed: string;
      if (stored.challengeMethod === "S256") {
        computed = createHash("sha256").update(code_verifier).digest("base64url");
      } else {
        computed = code_verifier;
      }
      if (computed !== stored.challenge) {
        console.error("[OAuth] PKCE verification failed");
        res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed" });
        return;
      }
    }

    authCodes.delete(code);
    console.error("[OAuth] Token issued successfully");
  } else if (grant_type === "client_credentials") {
    console.error("[OAuth] client_credentials grant issued");
  } else {
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
