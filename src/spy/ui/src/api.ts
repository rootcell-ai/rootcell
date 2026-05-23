import { z, type ZodType } from "zod";
import {
  ClearDataResultSchema,
  SpyCallDetailSchema,
  SpyCallDiffSchema,
  SpyCallSummaryPageSchema,
  SpyServiceHealthSchema,
  StreamEventPageSchema,
  SseEventPayloadSchemas,
} from "../../api-contracts.ts";
import type {
  CallQuery,
  ClearDataResult,
  SpyCallDetail,
  SpyCallDiff,
  SpyCallSummary,
  SpyPaginatedResult,
  SpyServiceHealth,
  StreamEvent,
  SseCallsChangedPayload,
  SseEventName,
  SseHelloPayload,
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

export async function fetchJson<T>(url: string, schema: ZodType<T>, init?: RequestInit): Promise<T> {
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
  let payload: unknown;
  try {
    payload = await response.json() as unknown;
  } catch (error) {
    throw new Error(`invalid JSON response from ${url}: ${errorMessage(error)}`, { cause: error });
  }
  return parseWithSchema(url, schema, payload);
}

export class SpyApiClient {
  health(): Promise<SpyServiceHealth> {
    return fetchJson("/api/health", SpyServiceHealthSchema);
  }

  calls(query: CallQuery): Promise<SpyPaginatedResult<SpyCallSummary>> {
    return fetchJson(callsUrl(query), SpyCallSummaryPageSchema);
  }

  callDetail(callId: string): Promise<SpyCallDetail> {
    return fetchJson(`/api/calls/${encodeURIComponent(callId)}`, SpyCallDetailSchema);
  }

  callDiff(callId: string): Promise<SpyCallDiff> {
    return fetchJson(`/api/calls/${encodeURIComponent(callId)}/diff`, SpyCallDiffSchema);
  }

  streamEvents(callId: string, cursor?: string): Promise<SpyPaginatedResult<StreamEvent>> {
    return fetchJson(streamEventsUrl(callId, cursor), StreamEventPageSchema);
  }

  clearData(): Promise<ClearDataResult> {
    return fetchJson("/api/clear", ClearDataResultSchema, {
      method: "POST",
      body: JSON.stringify({ confirm: true }),
      headers: {
        "Content-Type": "application/json",
      },
    });
  }
}

export function parseSseEventData(eventName: "hello", data: string): SseHelloPayload;
export function parseSseEventData(eventName: "health", data: string): SpyServiceHealth;
export function parseSseEventData(eventName: "calls-changed", data: string): SseCallsChangedPayload;
export function parseSseEventData(eventName: "cleared", data: string): ClearDataResult;
export function parseSseEventData(eventName: SseEventName, data: string): SseHelloPayload | SpyServiceHealth | SseCallsChangedPayload | ClearDataResult {
  let payload: unknown;
  try {
    payload = JSON.parse(data) as unknown;
  } catch (error) {
    throw new Error(`invalid SSE ${eventName} JSON: ${errorMessage(error)}`, { cause: error });
  }
  if (eventName === "hello") {
    return parseWithSchema("SSE hello payload", SseEventPayloadSchemas.hello, payload);
  }
  if (eventName === "health") {
    return parseWithSchema("SSE health payload", SseEventPayloadSchemas.health, payload);
  }
  if (eventName === "calls-changed") {
    return parseWithSchema("SSE calls-changed payload", SseEventPayloadSchemas["calls-changed"], payload);
  }
  return parseWithSchema("SSE cleared payload", SseEventPayloadSchemas.cleared, payload);
}

function parseWithSchema<T>(source: string, schema: ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`invalid response from ${source}: ${formatZodError(parsed.error)}`);
  }
  return parsed.data;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function currentSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
