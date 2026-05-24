import { z, type ZodType } from "zod";
import {
  ClearDataResultSchema,
  SpyCallDetailSchema,
  SpyCallDiffSchema,
  SpyCallSummaryPageSchema,
  SpyServiceHealthSchema,
  SpyTokenCountResponseSchema,
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
  SpyTokenCountRequest,
  SpyTokenCountResponse,
  StreamEvent,
  SseCallsChangedPayload,
  SseEventName,
  SseHelloPayload,
  TimePreset,
} from "./types.ts";

const DEFAULT_CALL_LIMIT = 100;
const DEFAULT_STREAM_LIMIT = 100;
const URL_PRESETS = new Set<TimePreset>(["live", "10m", "1h", "today", "custom"]);

export interface TimelineRangeState {
  readonly preset: TimePreset;
  readonly since: number;
}

export function initialTimelineRangeFromLocation(
  location: Pick<Location, "search">,
  nowSeconds: () => number = currentSeconds,
): TimelineRangeState {
  const params = new URLSearchParams(location.search);
  const explicitPreset = parseTimePreset(params.get("preset"));
  if (explicitPreset !== undefined && explicitPreset !== "custom") {
    return { preset: explicitPreset, since: resolveTimelineSince(explicitPreset, undefined, nowSeconds) };
  }
  const since = parseSince(params.get("since"));
  if (since !== undefined) {
    return {
      preset: explicitPreset ?? "custom",
      since,
    };
  }
  return { preset: "live", since: nowSeconds() };
}

export function initialSinceFromLocation(location: Pick<Location, "search">, nowSeconds: () => number = currentSeconds): number {
  return initialTimelineRangeFromLocation(location, nowSeconds).since;
}

export function resolveTimelineSince(
  preset: TimePreset,
  fixedSince: number | undefined,
  nowSeconds: () => number = currentSeconds,
): number {
  const now = nowSeconds();
  if (preset === "10m") {
    return now - 10 * 60;
  }
  if (preset === "1h") {
    return now - 60 * 60;
  }
  if (preset === "today") {
    const start = new Date(now * 1000);
    start.setHours(0, 0, 0, 0);
    return Math.floor(start.getTime() / 1000);
  }
  if (preset === "custom" && fixedSince !== undefined) {
    return fixedSince;
  }
  return now;
}

function parseTimePreset(value: string | null): TimePreset | undefined {
  return value !== null && URL_PRESETS.has(value as TimePreset) ? value as TimePreset : undefined;
}

function parseSince(value: string | null): number | undefined {
  if (value === null || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function timelineRangeUrl(preset: TimePreset, since: number, currentHref: string): string {
  const url = new URL(currentHref);
  if (preset === "custom") {
    url.searchParams.set("preset", preset);
    url.searchParams.set("since", String(since));
  } else {
    url.searchParams.set("preset", preset);
    url.searchParams.delete("since");
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function replaceTimelineRangeUrl(preset: TimePreset, since: number): void {
  window.history.replaceState(window.history.state, "", timelineRangeUrl(preset, since, window.location.href));
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
  if (query.since !== undefined) {
    params.set("since", String(query.since));
  }
  if (query.provider !== undefined) {
    params.set("provider", query.provider);
  }
  if (query.modelId !== undefined) {
    params.set("model_id", query.modelId);
  }
  if (query.operation !== undefined) {
    params.set("operation", query.operation);
  }
  if (query.status !== undefined) {
    params.set("status", query.status);
  }
  if (search !== undefined && search.length > 0) {
    params.set("q", search);
    return `/api/search?${params.toString()}`;
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

  tokenCount(request: SpyTokenCountRequest): Promise<SpyTokenCountResponse> {
    return fetchJson("/api/token-count", SpyTokenCountResponseSchema, {
      method: "POST",
      body: JSON.stringify(request),
      headers: {
        "Content-Type": "application/json",
      },
    });
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
