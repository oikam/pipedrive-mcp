import axios, { AxiosError, AxiosInstance } from "axios";

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

interface PipedriveListResponse<T> {
  success: boolean;
  data: T[] | null;
  additional_data?: {
    next_cursor?: string | null;
  };
}

interface RawDeal {
  id: number;
  title: string;
  status: string;
  add_time: string;
  update_time: string;
  pipeline_id: number;
  stage_id: number;
  value: number | null;
  currency: string;
  owner_name?: string | null;
  org_name?: string | null;
}

export class PipedriveClient {
  private http: AxiosInstance;

  constructor(apiToken: string) {
    this.http = axios.create({
      baseURL: "https://api.pipedrive.com/v1",
      headers: {
        "x-api-token": apiToken,
        "Accept": "application/json",
      },
      timeout: 30000,
    });
  }

  async listPipelines(): Promise<Pipeline[]> {
    const results: Pipeline[] = [];
    let cursor: string | undefined;

    do {
      const params: Record<string, unknown> = { limit: 500 };
      if (cursor) params.cursor = cursor;

      const res = await this.get<PipedriveListResponse<Pipeline>>("/pipelines", params);
      if (res.data) results.push(...res.data);
      cursor = res.additional_data?.next_cursor ?? undefined;
    } while (cursor);

    return results;
  }

  async getDeals(options: {
    pipeline_id: number;
    start_date: string;
    end_date: string;
    status?: string;
    limit?: number;
  }): Promise<Deal[]> {
    const maxItems = Math.min(options.limit ?? 100, 500);
    const results: Deal[] = [];
    let cursor: string | undefined;

    const baseParams: Record<string, unknown> = {
      pipeline_id: options.pipeline_id,
      updated_since: `${options.start_date}T00:00:00Z`,
      updated_until: `${options.end_date}T23:59:59Z`,
      limit: Math.min(maxItems, 100),
    };

    if (options.status && options.status !== "all") {
      baseParams.status = options.status;
    }

    do {
      const params = { ...baseParams };
      if (cursor) params.cursor = cursor;

      const res = await this.get<PipedriveListResponse<RawDeal>>("/deals", params);

      if (res.data) {
        for (const d of res.data) {
          results.push({
            id: d.id,
            title: d.title,
            status: d.status,
            add_time: d.add_time,
            update_time: d.update_time,
            pipeline_id: d.pipeline_id,
            stage_id: d.stage_id,
            value: d.value,
            currency: d.currency,
            owner_name: d.owner_name ?? null,
            org_name: d.org_name ?? null,
          });
        }
      }

      cursor = results.length < maxItems
        ? (res.additional_data?.next_cursor ?? undefined)
        : undefined;
    } while (cursor);

    return results.slice(0, maxItems);
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

function toPipedriveError(err: unknown): Error {
  if (err instanceof AxiosError && err.response) {
    const status = err.response.status;
    if (status === 401) return new Error("Invalid API token. Check your PIPEDRIVE_API_TOKEN.");
    if (status === 403) return new Error("Access denied. The token lacks permission for this resource.");
    if (status === 404) return new Error("Resource not found.");
    if (status === 429) return new Error("Rate limit exceeded. Please wait before retrying.");
    return new Error(`Pipedrive API error ${status}: ${JSON.stringify(err.response.data)}`);
  }
  if (err instanceof Error) return err;
  return new Error(String(err));
}
