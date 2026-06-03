import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PipedriveClient, PipedriveField, Note } from "./pipedrive.js";

export function registerTools(server: McpServer, client: PipedriveClient): void {

  // ── Pipelines ──────────────────────────────────────────────────────────────

  server.registerTool(
    "pipedrive_list_pipelines",
    {
      title: "List Pipelines",
      description: "List all active pipelines. Use this to discover pipeline IDs before querying deals.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const pipelines = await client.listPipelines();
        const text = pipelines.map((p) => `• [${p.id}] ${p.name}`).join("\n");
        return {
          content: [{ type: "text", text: `Found ${pipelines.length} active pipeline(s):\n\n${text}` }],
          structuredContent: { pipelines: pipelines.map((p) => ({ id: p.id, name: p.name })) },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${errMsg(err)}` }] };
      }
    }
  );

  // ── Deals ──────────────────────────────────────────────────────────────────

  server.registerTool(
    "pipedrive_get_deals",
    {
      title: "Get Deals by Pipeline and Date Range",
      description:
        "Retrieve deals from a pipeline within a date range.\n\n" +
        "filter_by='created' filters by creation date (add_time) — done client-side after fetching all pipeline deals.\n" +
        "filter_by='updated' filters by last update date (update_time) — done server-side, faster for large datasets.\n\n" +
        "Use pipedrive_list_pipelines first to get pipeline IDs.",
      inputSchema: z.object({
        pipeline_id: z.number().int().positive().describe("Pipeline ID"),
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Start date YYYY-MM-DD (inclusive)"),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("End date YYYY-MM-DD (inclusive)"),
        filter_by: z.enum(["created", "updated", "won"]).default("created")
          .describe("Filter by: 'created' = creation date, 'updated' = last update date, 'won' = date deal was marked won (ignores status filter, always returns won deals)"),
        status: z.enum(["open", "won", "lost", "all"]).default("all").describe("Deal status filter"),
        limit: z.number().int().min(1).max(2000).default(500)
          .describe("Max deals to return (1-2000). Auto-paginates through all results."),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ pipeline_id, start_date, end_date, filter_by, status, limit }) => {
      try {
        const { items: deals, truncated } = await client.getDeals({
          pipeline_id, start_date, end_date, filter_by, status, limit,
        });

        if (deals.length === 0) {
          return {
            content: [{ type: "text", text: `No deals found in pipeline ${pipeline_id} between ${start_date} and ${end_date} (filter: ${filter_by}).` }],
            structuredContent: { deals: [], total: 0, truncated: false },
          };
        }

        const lines = deals.map((d) => {
          const dateInfo = filter_by === "won" && d.won_time
            ? `won: ${d.won_time.slice(0, 10)}`
            : filter_by === "created"
            ? `created: ${d.add_time.slice(0, 10)}`
            : `updated: ${d.update_time.slice(0, 10)}`;
          return `• [${d.id}] ${d.title} | ${d.status} | ${d.value != null ? `${d.value} ${d.currency}` : "no value"} | ${dateInfo} | owner: ${d.owner_name ?? "—"} | org: ${d.org_name ?? "—"}`;
        });

        const truncatedNote = truncated ? `\n\n⚠️ Results capped at ${limit}. Narrow the date range or increase the limit to get all deals.` : "";

        return {
          content: [{ type: "text", text: `Found ${deals.length} deal(s) in pipeline ${pipeline_id} (${start_date} → ${end_date}, filter: ${filter_by}):\n\n${lines.join("\n")}${truncatedNote}` }],
          structuredContent: { deals, total: deals.length, truncated },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${errMsg(err)}` }] };
      }
    }
  );

  // ── Field definitions ──────────────────────────────────────────────────────

  server.registerTool(
    "pipedrive_get_deal_fields",
    {
      title: "Get Deal Field Definitions",
      description: "List all deal fields including custom fields. Returns field keys, types, and available options for enum/set fields (e.g. labels). Use field keys to understand deal data returned by pipedrive_get_deals.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const fields = await client.getDealFields();
        return fieldsResponse(fields);
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${errMsg(err)}` }] };
      }
    }
  );

  server.registerTool(
    "pipedrive_get_org_fields",
    {
      title: "Get Organization Field Definitions",
      description: "List all organization fields including custom fields. Returns field keys, types, and options for enum/set fields.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const fields = await client.getOrgFields();
        return fieldsResponse(fields);
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${errMsg(err)}` }] };
      }
    }
  );

  server.registerTool(
    "pipedrive_get_person_fields",
    {
      title: "Get Person Field Definitions",
      description: "List all person fields including custom fields. Returns field keys, types, and options for enum/set fields.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const fields = await client.getPersonFields();
        return fieldsResponse(fields);
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${errMsg(err)}` }] };
      }
    }
  );

  // ── Organizations ──────────────────────────────────────────────────────────

  server.registerTool(
    "pipedrive_list_organizations",
    {
      title: "List Organizations",
      description: "List organizations with optional date range filter (by last update). Returns standard and custom fields with resolved option labels.",
      inputSchema: z.object({
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Filter updated since this date (YYYY-MM-DD)"),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Filter updated until this date (YYYY-MM-DD)"),
        owner_id: z.number().int().positive().optional().describe("Filter by owner user ID"),
        limit: z.number().int().min(1).max(2000).default(100).describe("Max organizations to return (auto-paginates)"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ start_date, end_date, owner_id, limit }) => {
      try {
        const { items: orgs, truncated } = await client.listOrganizations({
          updated_since: start_date ? `${start_date}T00:00:00Z` : undefined,
          updated_until: end_date ? `${end_date}T23:59:59Z` : undefined,
          owner_id,
          limit,
        });

        const truncatedNote = truncated ? `\n\n⚠️ Results capped at ${limit}.` : "";
        const text = orgs.map((o) => `• [${o.id}] ${o.name} | owner: ${o.owner_name ?? "—"} | updated: ${String(o.update_time).slice(0, 10)}`).join("\n");

        return {
          content: [{ type: "text", text: `Found ${orgs.length} organization(s):\n\n${text}${truncatedNote}` }],
          structuredContent: { organizations: orgs, total: orgs.length, truncated },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${errMsg(err)}` }] };
      }
    }
  );

  // ── Persons ────────────────────────────────────────────────────────────────

  server.registerTool(
    "pipedrive_list_persons",
    {
      title: "List Persons",
      description: "List persons (contacts) with optional filters. Returns standard and custom fields with resolved option labels.",
      inputSchema: z.object({
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Filter updated since this date (YYYY-MM-DD)"),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Filter updated until this date (YYYY-MM-DD)"),
        org_id: z.number().int().positive().optional().describe("Filter by organization ID"),
        owner_id: z.number().int().positive().optional().describe("Filter by owner user ID"),
        limit: z.number().int().min(1).max(2000).default(100).describe("Max persons to return (auto-paginates)"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ start_date, end_date, org_id, owner_id, limit }) => {
      try {
        const { items: persons, truncated } = await client.listPersons({
          updated_since: start_date ? `${start_date}T00:00:00Z` : undefined,
          updated_until: end_date ? `${end_date}T23:59:59Z` : undefined,
          org_id,
          owner_id,
          limit,
        });

        const truncatedNote = truncated ? `\n\n⚠️ Results capped at ${limit}.` : "";
        const text = persons.map((p) => {
          const email = p.email.find((e) => e.primary)?.value ?? p.email[0]?.value ?? "—";
          const phone = p.phone.find((ph) => ph.primary)?.value ?? p.phone[0]?.value ?? "—";
          return `• [${p.id}] ${p.name} | email: ${email} | phone: ${phone} | org: ${p.org_name ?? "—"} | owner: ${p.owner_name ?? "—"}`;
        }).join("\n");

        return {
          content: [{ type: "text", text: `Found ${persons.length} person(s):\n\n${text}${truncatedNote}` }],
          structuredContent: { persons, total: persons.length, truncated },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${errMsg(err)}` }] };
      }
    }
  );

  // ── Activity types ─────────────────────────────────────────────────────────

  server.registerTool(
    "pipedrive_list_activity_types",
    {
      title: "List Activity Types",
      description: "List all activity types (call, meeting, email, task, etc.) with their IDs and key strings. Use this before pipedrive_list_activities to know valid type values.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const types = await client.getActivityTypes();
        const lines = types.map((t) => `• [${t.id}] ${t.name} (key: ${t.key_string})`).join("\n");
        return {
          content: [{ type: "text" as const, text: `${types.length} activity type(s):\n\n${lines}` }],
          structuredContent: { activity_types: types },
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${errMsg(err)}` }] };
      }
    }
  );

  // ── Activities ─────────────────────────────────────────────────────────────

  server.registerTool(
    "pipedrive_list_activities",
    {
      title: "List Activities",
      description: "List activities with optional filters. Filters by last update date if dates provided. Can filter by deal, person, org, owner, or completion status.",
      inputSchema: z.object({
        updated_since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Filter activities updated since this date (YYYY-MM-DD)"),
        updated_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Filter activities updated until this date (YYYY-MM-DD)"),
        deal_id: z.number().int().positive().optional().describe("Filter by deal ID"),
        person_id: z.number().int().positive().optional().describe("Filter by person ID"),
        org_id: z.number().int().positive().optional().describe("Filter by organization ID"),
        owner_id: z.number().int().positive().optional().describe("Filter by owner user ID"),
        done: z.boolean().optional().describe("Filter by completion: true = done, false = open, omit = all"),
        limit: z.number().int().min(1).max(2000).default(100).describe("Max activities to return (auto-paginates)"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ updated_since, updated_until, deal_id, person_id, org_id, owner_id, done, limit }) => {
      try {
        const { items: activities, truncated } = await client.listActivities({
          updated_since: updated_since ? `${updated_since}T00:00:00Z` : undefined,
          updated_until: updated_until ? `${updated_until}T23:59:59Z` : undefined,
          deal_id, person_id, org_id, owner_id, done, limit,
        });

        if (activities.length === 0) {
          return { content: [{ type: "text" as const, text: "No activities found matching the given filters." }] };
        }

        const lines = activities.map((a) =>
          `• [${a.id}] ${a.subject} | type: ${a.type} | done: ${a.done ? "✓" : "○"} | due: ${a.due_date ?? "—"} ${a.due_time ?? ""} | owner: ${a.owner_name ?? "—"} | deal: ${a.deal_title ?? "—"}${a.note ? ` | note: ${a.note.slice(0, 80)}${a.note.length > 80 ? "…" : ""}` : ""}`
        ).join("\n");

        const truncatedNote = truncated ? `\n\n⚠️ Results capped at ${limit}. Narrow filters to get all activities.` : "";

        return {
          content: [{ type: "text" as const, text: `Found ${activities.length} activity/activities:\n\n${lines}${truncatedNote}` }],
          structuredContent: { activities, total: activities.length, truncated },
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${errMsg(err)}` }] };
      }
    }
  );

  // ── Notes ──────────────────────────────────────────────────────────────────

  server.registerTool(
    "pipedrive_list_notes",
    {
      title: "List Notes",
      description: "List notes with optional filters by date range or association (deal, person, org). Note content is truncated to 500 chars — use pipedrive_get_note for the full text of a specific note.",
      inputSchema: z.object({
        start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Filter notes added from this date (YYYY-MM-DD)"),
        end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Filter notes added until this date (YYYY-MM-DD)"),
        deal_id: z.number().int().positive().optional().describe("Filter by deal ID"),
        person_id: z.number().int().positive().optional().describe("Filter by person ID"),
        org_id: z.number().int().positive().optional().describe("Filter by organization ID"),
        user_id: z.number().int().positive().optional().describe("Filter by note author user ID"),
        pinned_to_deal: z.boolean().optional().describe("Filter by pinned-to-deal status"),
        limit: z.number().int().min(1).max(2000).default(100).describe("Max notes to return (auto-paginates)"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ start_date, end_date, deal_id, person_id, org_id, user_id, pinned_to_deal, limit }) => {
      try {
        const { items: notes, truncated } = await client.listNotes({
          start_date, end_date, deal_id, person_id, org_id, user_id, pinned_to_deal, limit,
        });

        if (notes.length === 0) {
          return { content: [{ type: "text" as const, text: "No notes found matching the given filters." }] };
        }

        const lines = notes.map((n) => {
          const plain = stripHtml(n.content);
          const preview = plain.length > 500 ? `${plain.slice(0, 500)}… [use pipedrive_get_note id=${n.id} for full text]` : plain;
          const pins = [n.pinned_to_deal_flag && "deal", n.pinned_to_person_flag && "person", n.pinned_to_org_flag && "org"].filter(Boolean).join(", ");
          return `• [${n.id}] ${n.add_time.slice(0, 10)} | deal: ${n.deal_id ?? "—"} | person: ${n.person_id ?? "—"} | org: ${n.org_id ?? "—"}${pins ? ` | pinned: ${pins}` : ""}\n  ${preview}`;
        }).join("\n\n");

        const truncatedNote = truncated ? `\n\n⚠️ Results capped at ${limit}.` : "";

        return {
          content: [{ type: "text" as const, text: `Found ${notes.length} note(s):\n\n${lines}${truncatedNote}` }],
          structuredContent: { notes: notes.map((n) => ({ ...n, content_plain: stripHtml(n.content) })), total: notes.length, truncated },
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${errMsg(err)}` }] };
      }
    }
  );

  server.registerTool(
    "pipedrive_get_note",
    {
      title: "Get Note Detail",
      description: "Retrieve full content and metadata of a single note by ID. Use when pipedrive_list_notes truncated a note's content.",
      inputSchema: z.object({
        note_id: z.number().int().positive().describe("Note ID to retrieve"),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ note_id }) => {
      try {
        const note = await client.getNote(note_id);
        const plain = stripHtml(note.content);
        const pins = [note.pinned_to_deal_flag && "deal", note.pinned_to_person_flag && "person", note.pinned_to_org_flag && "org"].filter(Boolean).join(", ");
        return {
          content: [{ type: "text" as const, text: `Note [${note.id}] — ${note.add_time.slice(0, 10)}\nDeal: ${note.deal_id ?? "—"} | Person: ${note.person_id ?? "—"} | Org: ${note.org_id ?? "—"}${pins ? ` | Pinned: ${pins}` : ""}\n\n${plain}` }],
          structuredContent: { note: { ...note, content_plain: plain } },
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${errMsg(err)}` }] };
      }
    }
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

function fieldsResponse(fields: PipedriveField[]) {
  const lines = fields.map((f) => {
    const opts = f.options?.length ? ` | options: ${f.options.map((o) => `${o.label}(${o.id})`).join(", ")}` : "";
    return `• [${f.key}] ${f.name} (${f.field_type})${opts}`;
  });
  return {
    content: [{ type: "text" as const, text: `${fields.length} field(s):\n\n${lines.join("\n")}` }],
    structuredContent: { fields },
  };
}
