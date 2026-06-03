import axios, { AxiosError, AxiosInstance } from "axios";

const MAX_ITEMS_CAP = 2000;

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
  org_name: string | null;
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
    filter_by: "created" | "updated";
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
    } else {
      // Sort descending so newest deals appear first — important when hitting the cap
      params.sort_by = "add_time";
      params.sort_direction = "desc";
    }

    const { items: raw, truncated } = await this.fetchCursor<Record<string, unknown>>(
      "/deals/collection",
      params,
      MAX_ITEMS_CAP
    );

    let deals = raw.map(toDeal);

    if (options.filter_by === "created") {
      // Pipedrive add_time format: "YYYY-MM-DD HH:MM:SS" (space separator, not T)
      const from = `${options.start_date} 00:00:00`;
      const to = `${options.end_date} 23:59:59`;
      deals = deals.filter((d) => d.add_time >= from && d.add_time <= to);
    }

    const wasTruncated = truncated || deals.length > maxItems;
    return { items: deals.slice(0, maxItems), truncated: wasTruncated };
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
  }): Promise<PagedResult<Organization>> {
    const maxItems = Math.min(options.limit ?? 100, MAX_ITEMS_CAP);
    const params: Record<string, unknown> = { include_option_labels: true };
    if (options.updated_since) params.updated_since = options.updated_since;
    if (options.updated_until) params.updated_until = options.updated_until;
    if (options.owner_id) params.owner_id = options.owner_id;

    return this.fetchCursor<Organization>("/organizations/collection", params, maxItems);
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

  private async get<T>(endpoint: string, params?: Record<string, unknown>): Promise<T> {
    try {
      const res = await this.http.get<T>(endpoint, { params });
      return res.data;
    } catch (err) {
      throw toPipedriveError(err);
    }
  }
}

// ── Mappers ──────────────────────────────────────────────────────────────────

function toDeal(d: Record<string, unknown>): Deal {
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
    org_name: (d.org_name as string | null) ?? null,
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
