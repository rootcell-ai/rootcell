import type {
  CallQuery,
  ClearDataResult,
  SpyCallDetail,
  SpyCallDiff,
  SpyCallSummary,
  SpyPaginatedResult,
  SpyServiceHealth,
  StreamEvent,
} from "./types.ts";

const DEFAULT_CALL_LIMIT = 100;
const DEFAULT_STREAM_LIMIT = 100;

export function initialSinceFromLocation(location: Location, nowSeconds: () => number = currentSeconds): number {
  const value = new URLSearchParams(location.search).get("since");
  if (value === null || value.trim().length === 0) {
    return nowSeconds();
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : nowSeconds();
}

export function callsUrl(query: CallQuery): string {
  const params = new URLSearchParams();
  const search = query.search?.trim();
  if (query.limit !== undefined) {
    params.set("limit", String(query.limit));
  } else {
    params.set("limit", String(DEFAULT_CALL_LIMIT));
  }
  if (query.cursor !== undefined) {
    params.set("cursor", query.cursor);
  }
  if (search !== undefined && search.length > 0) {
    params.set("q", search);
    return `/api/search?${params.toString()}`;
  }
  if (query.since !== undefined) {
    params.set("since", String(query.since));
  }
  return `/api/calls?${params.toString()}`;
}

export function streamEventsUrl(callId: string, cursor?: string): string {
  const params = new URLSearchParams({ limit: String(DEFAULT_STREAM_LIMIT) });
  if (cursor !== undefined) {
    params.set("cursor", cursor);
  }
  return `/api/calls/${encodeURIComponent(callId)}/stream-events?${params.toString()}`;
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  const response = await fetch(url, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${String(response.status)} ${response.statusText}${detail.length > 0 ? `: ${detail}` : ""}`);
  }
  return await response.json() as T;
}

export class SpyApiClient {
  health(): Promise<SpyServiceHealth> {
    return fetchJson<SpyServiceHealth>("/api/health");
  }

  calls(query: CallQuery): Promise<SpyPaginatedResult<SpyCallSummary>> {
    return fetchJson<SpyPaginatedResult<SpyCallSummary>>(callsUrl(query));
  }

  callDetail(callId: string): Promise<SpyCallDetail> {
    return fetchJson<SpyCallDetail>(`/api/calls/${encodeURIComponent(callId)}`);
  }

  callDiff(callId: string): Promise<SpyCallDiff> {
    return fetchJson<SpyCallDiff>(`/api/calls/${encodeURIComponent(callId)}/diff`);
  }

  streamEvents(callId: string, cursor?: string): Promise<SpyPaginatedResult<StreamEvent>> {
    return fetchJson<SpyPaginatedResult<StreamEvent>>(streamEventsUrl(callId, cursor));
  }

  clearData(): Promise<ClearDataResult> {
    return fetchJson<ClearDataResult>("/api/clear", {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
      headers: {
        "Content-Type": "application/json",
      },
    });
  }
}

function currentSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
