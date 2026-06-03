import axios, { AxiosError, AxiosInstance } from "axios";

const MAX_ITEMS_CAP = 5000;
const CUSTOM_FIELD_KEY = /^[0-9a-f]{40}$/;

export interface Pipeline {
  id: number;
  name: string;
  active: boolean;
  add_time: string;
  update_time: string;
}

export interface Deal {
  id: number;
  title: string;
  status: string;
  add_time: string;
  update_time: string;
  pipeline_id: number;
  stage_id: number;
  value: number | null;
  currency: string;
  owner_name: string | null;
  org_id: number | null;
  org_name: string | null;
  won_time: string | null;
  custom_fields: Record<string, unknown>;
}

export interface FieldOption {
  id: number;
  label: string;
}

export interface PipedriveField {
  key: string;
  name: string;
  field_type: string;
  mandatory_flag: boolean;
  edit_flag: boolean;
  options?: FieldOption[];
}

export interface Organization {
  id: number;
  name: string;
  owner_name: string | null;
  add_time: string;
  update_time: string;
  [key: string]: unknown;
}

export interface Person {
  id: number;
  name: string;
  email: { value: string; primary: boolean }[];
  phone: { value: string; primary: boolean }[];
  org_name: string | null;
  owner_name: string | null;
  add_time: string;
  update_time: string;
  [key: string]: unknown;
}

interface CursorResponse<T> {
  success: boolean;
  data: T[] | null;
  additional_data?: { next_cursor?: string | null };
}

interface OffsetResponse<T> {
  success: boolean;
  data: T[] | null;
  additional_data?: {
    pagination?: { more_items_in_collection: boolean; next_start: number };
  };
}

export interface PagedResult<T> {
  items: T[];
  truncated: boolean;
}

export interface ActivityType {
  id: number;
  name: string;
  key_string: string;
  icon_key: string;
  color: string | null;
}

export interface Activity {
  id: number;
  subject: string;
  type: string;
  done: boolean;
  due_date: string | null;
  due_time: string | null;
  duration: string | null;
  add_time: string;
  update_time: string;
  note: string | null;
  deal_id: number | null;
  person_id: number | null;
  org_id: number | null;
  owner_name: string | null;
  deal_title: string | null;
}

export interface Note {
  id: number;
  content: string;
  add_time: string;
  update_time: string;
  user_id: number | null;
  deal_id: number | null;
  person_id: number | null;
  org_id: number | null;
  pinned_to_deal_flag: boolean;
  pinned_to_person_flag: boolean;
  pinned_to_org_flag: boolean;
}

export class PipedriveClient {
  private http: AxiosInstance;

  constructor(apiToken: string) {
    this.http = axios.create({
      baseURL: "https://api.pipedrive.com/v1",
      headers: { "x-api-token": apiToken, Accept: "application/json" },
      timeout: 30000,
    });
  }

  // ── Pipelines ────────────────────────────────────────────────────────────

  async listPipelines(): Promise<Pipeline[]> {
    const { items } = await this.fetchCursor<Pipeline>("/pipelines", {}, 500);
    return items.filter((p) => p.active);
  }

  // ── Deals ────────────────────────────────────────────────────────────────

  async getDeals(options: {
    pipeline_id: number;
    start_date: string;
    end_date: string;
    filter_by: "created" | "updated" | "won";
    status?: string;
    limit?: number;
  }): Promise<PagedResult<Deal>> {
    const maxItems = Math.min(options.limit ?? 500, MAX_ITEMS_CAP);
    const params: Record<string, unknown> = { pipeline_id: options.pipeline_id };

    if (options.status && options.status !== "all") {
      params.status = options.status;
    }

    if (options.filter_by === "updated") {
      params.updated_since = `${options.start_date}T00:00:00Z`;
      params.updated_until = `${options.end_date}T23:59:59Z`;
      const { items: raw, truncated } = await this.fetchCursor<Record<string, unknown>>(
        "/deals/collection",
        params,
        maxItems
      );
      return { items: raw.map(toDeal), truncated };
    }

    // filter_by === "won": sort by update_time desc, filter client-side by won_time
    if (options.filter_by === "won") {
      params.status = "won";
      const from = `${options.start_date} 00:00:00`;
      const to = `${options.end_date} 23:59:59`;
      return this.fetchDealsByWonDate(params, from, to, maxItems);
    }

    // filter_by === "created": use /deals with sort=add_time DESC + early exit
    // Pipedrive add_time format: "YYYY-MM-DD HH:MM:SS" (space separator)
    const from = `${options.start_date} 00:00:00`;
    const to = `${options.end_date} 23:59:59`;
    return this.fetchDealsByCreatedDate(params, from, to, maxItems);
  }

  // ── Field definitions ────────────────────────────────────────────────────

  async getDealFields(): Promise<PipedriveField[]> {
    return this.fetchOffset<PipedriveField>("/dealFields");
  }

  async getOrgFields(): Promise<PipedriveField[]> {
    return this.fetchOffset<PipedriveField>("/organizationFields");
  }

  async getPersonFields(): Promise<PipedriveField[]> {
    return this.fetchOffset<PipedriveField>("/personFields");
  }

  // ── Organizations ────────────────────────────────────────────────────────

  async listOrganizations(options: {
    updated_since?: string;
    updated_until?: string;
    owner_id?: number;
    limit?: number;
    after_id?: number;
  }): Promise<PagedResult<Organization>> {
    const maxItems = Math.min(options.limit ?? 100, MAX_ITEMS_CAP);

    // Date filter: /organizations/collection ignores updated_since/until (Pipedrive bug).
    // Use /organizations offset endpoint with sort=update_time DESC + client-side filter.
    if (options.updated_since || options.updated_until) {
      const from = options.updated_since
        ? options.updated_since.replace("T", " ").replace("Z", "")
        : "0000-01-01 00:00:00";
      const to = options.updated_until
        ? options.updated_until.replace("T", " ").replace("Z", "")
        : "9999-12-31 23:59:59";
      return this.fetchOrgsByUpdatedDate(from, to, maxItems, options.owner_id);
    }

    // No date filter: fast cursor-based fetch
    const params: Record<string, unknown> = { include_option_labels: true };
    if (options.owner_id) params.owner_id = options.owner_id;
    if (options.after_id) params.since_id = options.after_id;

    return this.fetchCursor<Organization>("/organizations/collection", params, maxItems);
  }

  private async fetchOrgsByUpdatedDate(
    from: string,
    to: string,
    maxItems: number,
    owner_id?: number
  ): Promise<PagedResult<Organization>> {
    const orgs: Organization[] = [];
    let start = 0;

    while (true) {
      const params: Record<string, unknown> = {
        sort: "update_time DESC",
        include_option_labels: true,
        start,
        limit: 500,
      };
      if (owner_id) params.owner_id = owner_id;

      const res = await this.get<OffsetResponse<Organization>>("/organizations", params);
      const page = res.data ?? [];

      for (const org of page) {
        const ut = (org.update_time as string) ?? "";
        if (ut < from) return { items: orgs, truncated: false };
        if (ut <= to) {
          orgs.push(org);
          if (orgs.length >= maxItems) return { items: orgs, truncated: true };
        }
      }

      const more = res.additional_data?.pagination?.more_items_in_collection ?? false;
      if (!more || page.length === 0) break;
      start += 500;
    }

    return { items: orgs, truncated: false };
  }

  // ── Persons ──────────────────────────────────────────────────────────────

  async listPersons(options: {
    updated_since?: string;
    updated_until?: string;
    org_id?: number;
    owner_id?: number;
    limit?: number;
  }): Promise<PagedResult<Person>> {
    const maxItems = Math.min(options.limit ?? 100, MAX_ITEMS_CAP);
    const params: Record<string, unknown> = { include_option_labels: true };
    if (options.updated_since) params.updated_since = options.updated_since;
    if (options.updated_until) params.updated_until = options.updated_until;
    if (options.org_id) params.org_id = options.org_id;
    if (options.owner_id) params.owner_id = options.owner_id;

    return this.fetchCursor<Person>("/persons/collection", params, maxItems);
  }

  // ── Activity types ───────────────────────────────────────────────────────

  async getActivityTypes(): Promise<ActivityType[]> {
    const res = await this.get<{ success: boolean; data: ActivityType[] | null }>("/activityTypes");
    return res.data ?? [];
  }

  // ── Activities ───────────────────────────────────────────────────────────

  async listActivities(options: {
    updated_since?: string;
    updated_until?: string;
    owner_id?: number;
    deal_id?: number;
    person_id?: number;
    org_id?: number;
    done?: boolean;
    limit?: number;
  }): Promise<PagedResult<Activity>> {
    const maxItems = Math.min(options.limit ?? 100, MAX_ITEMS_CAP);
    const params: Record<string, unknown> = {};
    if (options.updated_since) params.updated_since = options.updated_since;
    if (options.updated_until) params.updated_until = options.updated_until;
    if (options.owner_id != null) params.owner_id = options.owner_id;
    if (options.deal_id != null) params.deal_id = options.deal_id;
    if (options.person_id != null) params.person_id = options.person_id;
    if (options.org_id != null) params.org_id = options.org_id;
    if (options.done != null) params.done = options.done ? 1 : 0;

    const { items: raw, truncated } = await this.fetchCursor<Record<string, unknown>>(
      "/activities/collection",
      params,
      maxItems
    );
    return { items: raw.map(toActivity), truncated };
  }

  // ── Notes ────────────────────────────────────────────────────────────────

  async listNotes(options: {
    start_date?: string;
    end_date?: string;
    deal_id?: number;
    person_id?: number;
    org_id?: number;
    user_id?: number;
    pinned_to_deal?: boolean;
    limit?: number;
  }): Promise<PagedResult<Note>> {
    const maxItems = Math.min(options.limit ?? 100, MAX_ITEMS_CAP);
    const params: Record<string, unknown> = {};
    if (options.start_date) params.start_date = options.start_date;
    if (options.end_date) params.end_date = options.end_date;
    if (options.deal_id != null) params.deal_id = options.deal_id;
    if (options.person_id != null) params.person_id = options.person_id;
    if (options.org_id != null) params.org_id = options.org_id;
    if (options.user_id != null) params.user_id = options.user_id;
    if (options.pinned_to_deal != null) params.pinned_to_deal_flag = options.pinned_to_deal ? 1 : 0;

    const items = await this.fetchOffsetWithParams<Record<string, unknown>>("/notes", params, maxItems);
    return { items: items.items.map(toNote), truncated: items.truncated };
  }

  async getNote(id: number): Promise<Note> {
    const res = await this.get<{ success: boolean; data: Record<string, unknown> }>(`/notes/${id}`);
    return toNote(res.data);
  }

  // ── Deals by created date (offset pagination + early exit) ──────────────

  private async fetchDealsByCreatedDate(
    baseParams: Record<string, unknown>,
    from: string,
    to: string,
    maxItems: number
  ): Promise<PagedResult<Deal>> {
    const deals: Deal[] = [];
    let start = 0;
    let truncated = false;

    while (true) {
      const params: Record<string, unknown> = {
        ...baseParams,
        sort: "add_time DESC",
        start,
        limit: 500,
      };

      const res = await this.get<OffsetResponse<Record<string, unknown>>>("/deals", params);
      const page = res.data ?? [];

      for (const raw of page) {
        const addTime = raw.add_time as string;
        // Since sorted desc, once we're before the range we can stop entirely
        if (addTime < from) {
          return { items: deals, truncated };
        }
        if (addTime <= to) {
          deals.push(toDeal(raw));
          if (deals.length >= maxItems) {
            return { items: deals, truncated: true };
          }
        }
      }

      const more = res.additional_data?.pagination?.more_items_in_collection ?? false;
      if (!more || page.length === 0) break;
      start += 500;
    }

    return { items: deals, truncated };
  }

  private async fetchDealsByWonDate(
    baseParams: Record<string, unknown>,
    from: string,
    to: string,
    maxItems: number
  ): Promise<PagedResult<Deal>> {
    const deals: Deal[] = [];
    let start = 0;

    while (true) {
      const params: Record<string, unknown> = {
        ...baseParams,
        sort: "update_time DESC",
        start,
        limit: 500,
      };

      const res = await this.get<OffsetResponse<Record<string, unknown>>>("/deals", params);
      const page = res.data ?? [];

      for (const raw of page) {
        const wonTime = (raw.won_time as string | null) ?? "";
        if (wonTime && wonTime < from) {
          // Sorted by update_time desc; won_time may not be monotonic but
          // once update_time is far before our range we can stop safely
          const updateTime = (raw.update_time as string) ?? "";
          if (updateTime < from) return { items: deals, truncated: false };
          continue;
        }
        if (wonTime >= from && wonTime <= to) {
          deals.push(toDeal(raw));
          if (deals.length >= maxItems) return { items: deals, truncated: true };
        }
      }

      const more = res.additional_data?.pagination?.more_items_in_collection ?? false;
      if (!more || page.length === 0) break;
      start += 500;
    }

    return { items: deals, truncated: false };
  }

  // ── Pagination helpers ───────────────────────────────────────────────────

  private async fetchCursor<T>(
    endpoint: string,
    params: Record<string, unknown>,
    maxItems: number
  ): Promise<PagedResult<T>> {
    const items: T[] = [];
    let cursor: string | undefined;
    let truncated = false;

    do {
      const reqParams: Record<string, unknown> = { ...params, limit: Math.min(500, maxItems - items.length) };
      if (cursor) reqParams.cursor = cursor;

      const res = await this.get<CursorResponse<T>>(endpoint, reqParams);
      if (res.data) items.push(...res.data);

      cursor = res.additional_data?.next_cursor ?? undefined;

      if (items.length >= maxItems && cursor) {
        truncated = true;
        cursor = undefined;
      }
    } while (cursor);

    return { items, truncated };
  }

  private async fetchOffset<T>(endpoint: string): Promise<T[]> {
    const items: T[] = [];
    let start = 0;
    let more = true;

    while (more) {
      const res = await this.get<OffsetResponse<T>>(endpoint, { start, limit: 500 });
      if (res.data) items.push(...res.data);
      more = res.additional_data?.pagination?.more_items_in_collection ?? false;
      start += 500;
    }

    return items;
  }

  private async fetchOffsetWithParams<T>(
    endpoint: string,
    params: Record<string, unknown>,
    maxItems: number
  ): Promise<PagedResult<T>> {
    const items: T[] = [];
    let start = 0;
    let more = true;

    while (more && items.length < maxItems) {
      const res = await this.get<OffsetResponse<T>>(endpoint, {
        ...params,
        start,
        limit: Math.min(500, maxItems - items.length),
      });
      if (res.data) items.push(...res.data);
      more = res.additional_data?.pagination?.more_items_in_collection ?? false;
      start += 500;
    }

    return { items: items.slice(0, maxItems), truncated: more };
  }

  private async get<T>(endpoint: string, params?: Record<string, unknown>): Promise<T> {
    try {
      const res = await this.http.get<T>(endpoint, { params });
      return res.data;
    } catch (err) {
      throw toPipedriveError(err);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Pipedrive sometimes returns relation fields as { value: id, ...} objects
function extractId(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "object" && v !== null && "value" in v) return (v as { value: number }).value ?? null;
  return null;
}

// ── Mappers ──────────────────────────────────────────────────────────────────

function toDeal(d: Record<string, unknown>): Deal {
  const custom_fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (CUSTOM_FIELD_KEY.test(k) && v != null) custom_fields[k] = v;
  }
  return {
    id: d.id as number,
    title: d.title as string,
    status: d.status as string,
    add_time: d.add_time as string,
    update_time: d.update_time as string,
    pipeline_id: d.pipeline_id as number,
    stage_id: d.stage_id as number,
    value: (d.value as number | null) ?? null,
    currency: d.currency as string,
    owner_name: (d.owner_name as string | null) ?? null,
    org_id: extractId(d.org_id),
    org_name: (d.org_name as string | null) ?? null,
    won_time: (d.won_time as string | null) ?? null,
    custom_fields,
  };
}

function toActivity(d: Record<string, unknown>): Activity {
  return {
    id: d.id as number,
    subject: (d.subject as string) ?? "",
    type: (d.type as string) ?? "",
    done: Boolean(d.done),
    due_date: (d.due_date as string | null) ?? null,
    due_time: (d.due_time as string | null) ?? null,
    duration: (d.duration as string | null) ?? null,
    add_time: d.add_time as string,
    update_time: d.update_time as string,
    note: (d.note as string | null) ?? null,
    deal_id: (d.deal_id as number | null) ?? null,
    person_id: (d.person_id as number | null) ?? null,
    org_id: (d.org_id as number | null) ?? null,
    owner_name: (d.owner_name as string | null) ?? null,
    deal_title: (d.deal_title as string | null) ?? null,
  };
}

function toNote(d: Record<string, unknown>): Note {
  return {
    id: d.id as number,
    content: (d.content as string) ?? "",
    add_time: d.add_time as string,
    update_time: d.update_time as string,
    user_id: (d.user_id as number | null) ?? null,
    deal_id: (d.deal_id as number | null) ?? null,
    person_id: (d.person_id as number | null) ?? null,
    org_id: (d.org_id as number | null) ?? null,
    pinned_to_deal_flag: Boolean(d.pinned_to_deal_flag),
    pinned_to_person_flag: Boolean(d.pinned_to_person_flag),
    pinned_to_org_flag: Boolean(d.pinned_to_org_flag),
  };
}

function toPipedriveError(err: unknown): Error {
  if (err instanceof AxiosError && err.response) {
    const s = err.response.status;
    if (s === 401) return new Error("Invalid API token. Check your PIPEDRIVE_API_TOKEN.");
    if (s === 403) return new Error("Access denied. The token lacks permission for this resource.");
    if (s === 404) return new Error("Resource not found.");
    if (s === 429) return new Error("Rate limit exceeded. Please wait before retrying.");
    return new Error(`Pipedrive API error ${s}: ${JSON.stringify(err.response.data)}`);
  }
  if (err instanceof Error) return err;
  return new Error(String(err));
}
