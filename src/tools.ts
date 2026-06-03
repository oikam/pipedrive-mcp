import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PipedriveClient } from "./pipedrive.js";

export function registerTools(server: McpServer, client: PipedriveClient): void {
  server.registerTool(
    "pipedrive_list_pipelines",
    {
      title: "List Pipelines",
      description: "List all pipelines in Pipedrive. Use this to discover pipeline IDs before querying deals.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const pipelines = await client.listPipelines();
        const active = pipelines.filter((p) => p.active);
        const text = active
          .map((p) => `• [${p.id}] ${p.name}`)
          .join("\n");
        return {
          content: [{ type: "text", text: `Found ${active.length} active pipeline(s):\n\n${text}` }],
          structuredContent: { pipelines: active.map((p) => ({ id: p.id, name: p.name })) },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }
  );

  server.registerTool(
    "pipedrive_get_deals",
    {
      title: "Get Deals by Pipeline and Date Range",
      description:
        "Retrieve deals from a specific pipeline within a date range (based on last update time).\n\n" +
        "Use pipedrive_list_pipelines first to get pipeline IDs.",
      inputSchema: z.object({
        pipeline_id: z.number().int().positive().describe("Pipeline ID to filter deals"),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date (YYYY-MM-DD, inclusive)"),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date (YYYY-MM-DD, inclusive)"),
        status: z
          .enum(["open", "won", "lost", "all"])
          .default("all")
          .describe("Filter by deal status"),
        limit: z
          .number().int().min(1).max(500)
          .default(100)
          .describe("Maximum number of deals to return (1-500)"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ pipeline_id, start_date, end_date, status, limit }) => {
      try {
        const deals = await client.getDeals({ pipeline_id, start_date, end_date, status, limit });

        if (deals.length === 0) {
          return {
            content: [{ type: "text", text: `No deals found in pipeline ${pipeline_id} between ${start_date} and ${end_date}.` }],
            structuredContent: { deals: [], total: 0 },
          };
        }

        const lines = deals.map((d) =>
          `• [${d.id}] ${d.title} | ${d.status} | ${d.value != null ? `${d.value} ${d.currency}` : "no value"} | updated: ${d.update_time.slice(0, 10)} | owner: ${d.owner_name ?? "—"} | org: ${d.org_name ?? "—"}`
        );

        return {
          content: [{
            type: "text",
            text: `Found ${deals.length} deal(s) in pipeline ${pipeline_id} (${start_date} → ${end_date}):\n\n${lines.join("\n")}`,
          }],
          structuredContent: { deals, total: deals.length },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
      }
    }
  );
}
