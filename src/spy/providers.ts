import {
  bedrockCallIdForFlow,
  normalizeBedrockRequest,
  normalizeBedrockResponse,
} from "./bedrock.ts";
import {
  cursorCallIdForFlow,
  normalizeCursorRequest,
  normalizeCursorResponse,
} from "./cursor.ts";
import type {
  NormalizedBlock,
  ProviderId,
  ProviderCall,
  RawPayloadRecord,
  SpoolRequestEvent,
  SpoolResponseEvent,
  StreamEvent,
  UsageRecord,
} from "./schemas.ts";

export interface ProviderAdapterOptions {
  readonly storeRaw?: boolean;
}

export interface NormalizedProviderRequest {
  readonly call: ProviderCall;
  readonly blocks: readonly NormalizedBlock[];
  readonly rawPayloads: readonly RawPayloadRecord[];
}

export interface NormalizedProviderResponse {
  readonly call: ProviderCall;
  readonly blocks: readonly NormalizedBlock[];
  readonly usage: readonly UsageRecord[];
  readonly streamEvents: readonly StreamEvent[];
  readonly rawPayloads: readonly RawPayloadRecord[];
}

export interface SpyProviderAdapter {
  readonly id: ProviderId;
  callIdForFlow(flowId: string): string;
  normalizeRequest(event: SpoolRequestEvent, options?: ProviderAdapterOptions): NormalizedProviderRequest;
  normalizeResponse(event: SpoolResponseEvent, options?: ProviderAdapterOptions): NormalizedProviderResponse;
}

const ADAPTERS: Readonly<Record<ProviderId, SpyProviderAdapter>> = {
  bedrock: {
    id: "bedrock",
    callIdForFlow: bedrockCallIdForFlow,
    normalizeRequest: normalizeBedrockRequest,
    normalizeResponse: normalizeBedrockResponse,
  },
  cursor: {
    id: "cursor",
    callIdForFlow: cursorCallIdForFlow,
    normalizeRequest: normalizeCursorRequest,
    normalizeResponse: normalizeCursorResponse,
  },
};

export function providerAdapterFor(provider: ProviderId): SpyProviderAdapter {
  return ADAPTERS[provider];
}
