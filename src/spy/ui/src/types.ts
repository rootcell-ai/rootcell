import type {
  DiffClassification,
  HttpEventRecord,
  NormalizedBlock,
  RawPayloadRecord,
  StreamEvent,
  UsageRecord,
} from "../../schemas.ts";
import type {
  ClearDataResult,
  SpyCallDetail,
  SpyCallDiff,
  SpyCallSummary,
  SpyHealthSnapshot,
  SpyPaginatedResult,
  SpyRequestComposition,
  SpyRequestCompositionSection,
  SpyServiceHealth,
  SpyUsageSummary,
  SseCallsChangedPayload,
  SseEventName,
  SseHelloPayload,
} from "../../api-contracts.ts";

export type {
  ClearDataResult,
  DiffClassification,
  HttpEventRecord,
  NormalizedBlock,
  RawPayloadRecord,
  SpyCallDetail,
  SpyCallDiff,
  SpyCallSummary,
  SpyHealthSnapshot,
  SpyPaginatedResult,
  SpyRequestComposition,
  SpyRequestCompositionSection,
  SpyServiceHealth,
  SpyUsageSummary,
  StreamEvent,
  SseCallsChangedPayload,
  SseEventName,
  SseHelloPayload,
  UsageRecord,
};

export type TimePreset = "live" | "10m" | "1h" | "today" | "custom";

export interface CallQuery {
  readonly since?: number | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  readonly search?: string | undefined;
  readonly provider?: string | undefined;
  readonly modelId?: string | undefined;
  readonly operation?: string | undefined;
  readonly status?: string | undefined;
}

export interface UiFilters {
  readonly provider: string;
  readonly model: string;
  readonly operation: string;
  readonly status: string;
  readonly blockKind: string;
}
