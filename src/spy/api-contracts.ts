import { z } from "zod";
import {
  DiffClassificationSchema,
  HttpEventRecordSchema,
  NormalizedBlockKindSchema,
  NormalizedBlockSchema,
  ProviderCallSchema,
  RawPayloadRecordSchema,
  StreamEventSchema,
  UsageRecordSchema,
} from "./schemas.ts";

const NonNegativeIntegerSchema = z.number().int().nonnegative();
const NonNegativeNumberSchema = z.number().nonnegative();

export const IngestSpoolBatchResultSchema = z.object({
  attempted: NonNegativeIntegerSchema,
  ingested: NonNegativeIntegerSchema,
  deleted: NonNegativeIntegerSchema,
  deferred: NonNegativeIntegerSchema,
  malformed: NonNegativeIntegerSchema,
  errors: NonNegativeIntegerSchema,
}).strict();

export const RetentionResultSchema = z.object({
  deletedByAge: NonNegativeIntegerSchema,
  deletedBySize: NonNegativeIntegerSchema,
  vacuumed: z.boolean(),
}).strict();

export const ClearDataResultSchema = z.object({
  deletedSpoolFiles: NonNegativeIntegerSchema,
  clearGeneration: NonNegativeIntegerSchema,
  clearBaselineTs: NonNegativeNumberSchema,
}).strict();

export const SpyHealthSnapshotSchema = z.object({
  schemaVersion: NonNegativeIntegerSchema,
  dbSizeBytes: NonNegativeIntegerSchema,
  dbUsedBytes: NonNegativeIntegerSchema,
  spoolSizeBytes: NonNegativeIntegerSchema,
  providerCallCount: NonNegativeIntegerSchema,
  pendingCallCount: NonNegativeIntegerSchema,
  droppedCaptureCount: NonNegativeIntegerSchema,
  lastIngestAt: NonNegativeNumberSchema.nullable(),
  counters: z.record(z.string(), z.number()),
  metadata: z.record(z.string(), z.string()),
}).strict();

export const SpyTokenCountModeSchema = z.enum(["provider"]);
export const SpyTokenCountProvenanceSchema = z.enum([
  "provider_reported",
  "provider_counted",
  "unavailable",
]);
export const SpyTokenCountSubjectTypeSchema = z.enum(["call", "section", "block", "selection"]);

export const SpyServiceHealthSchema = z.object({
  ok: z.literal(true),
  service: z.object({
    enabled: z.boolean(),
    bind: z.string().min(1),
    port: NonNegativeIntegerSchema,
    retentionDays: NonNegativeNumberSchema,
    maxBytes: NonNegativeIntegerSchema,
    spoolMaxBytes: NonNegativeIntegerSchema,
    storeRaw: z.boolean(),
    tokenCountMode: SpyTokenCountModeSchema,
    staticAssets: z.boolean(),
  }).strict(),
  store: SpyHealthSnapshotSchema,
}).strict();

export const SpyUsageSummarySchema = z.object({
  inputTokens: NonNegativeIntegerSchema.nullable(),
  outputTokens: NonNegativeIntegerSchema.nullable(),
  cacheReadTokens: NonNegativeIntegerSchema.nullable(),
  cacheWriteTokens: NonNegativeIntegerSchema.nullable(),
  totalTokens: NonNegativeIntegerSchema.nullable(),
}).strict();

export const SpyTokenCountRecordSchema = z.object({
  subjectType: SpyTokenCountSubjectTypeSchema,
  callId: z.string().min(1).optional(),
  blockId: z.string().min(1).optional(),
  direction: z.enum(["request", "response"]).optional(),
  kind: NormalizedBlockKindSchema.optional(),
  label: z.string().min(1).optional(),
  sourceHash: z.string().min(1),
  modelId: z.string().min(1),
  tokens: NonNegativeIntegerSchema.nullable(),
  provenance: SpyTokenCountProvenanceSchema,
  countedAt: NonNegativeNumberSchema,
  error: z.string().min(1).optional(),
}).strict();

export const SpyTokenCountSubjectSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("call"),
    callId: z.string().min(1),
    direction: z.literal("request"),
  }).strict(),
  z.object({
    type: z.literal("section"),
    callId: z.string().min(1),
    direction: z.enum(["request", "response"]),
    kind: NormalizedBlockKindSchema,
  }).strict(),
  z.object({
    type: z.literal("block"),
    callId: z.string().min(1),
    blockId: z.string().min(1),
  }).strict(),
  z.object({
    type: z.literal("selection"),
    callId: z.string().min(1),
    text: z.string(),
    label: z.string().min(1).optional(),
  }).strict(),
]);

export const SpyTokenCountRequestSchema = z.object({
  mode: SpyTokenCountModeSchema.optional(),
  subjects: z.array(SpyTokenCountSubjectSchema).min(1).max(100),
}).strict();

export const SpyTokenCountResponseSchema = z.object({
  mode: SpyTokenCountModeSchema,
  records: z.array(SpyTokenCountRecordSchema),
}).strict();

export const SpyCompactionDetectionSourceSchema = z.enum(["none", "pi_pattern", "heuristic", "summarization_request"]);
export const SpyCompactionConfidenceSchema = z.enum(["none", "low", "medium", "high"]);
export const SpyCompactionReasonSchema = z.enum([
  "no_previous_comparable_call",
  "pi_request_context_profile",
  "summarization_system_prompt",
  "conversation_wrapper_input",
  "large_current_user_input",
  "stable_request_context",
  "summary_like_history_block",
  "prior_history_byte_drop",
  "prior_history_block_drop",
  "request_byte_drop",
  "input_token_drop",
]);

export const SpyCompactionEvidenceSchema = z.object({
  currentCallId: z.string().min(1),
  previousCallId: z.string().min(1).nullable(),
  currentRequestByteSize: NonNegativeIntegerSchema,
  previousRequestByteSize: NonNegativeIntegerSchema.nullable(),
  currentInputTokens: NonNegativeIntegerSchema.nullable(),
  previousInputTokens: NonNegativeIntegerSchema.nullable(),
  currentContextTokens: NonNegativeIntegerSchema.nullable(),
  previousContextTokens: NonNegativeIntegerSchema.nullable(),
  currentPriorHistoryByteSize: NonNegativeIntegerSchema,
  previousPriorHistoryByteSize: NonNegativeIntegerSchema.nullable(),
  currentPriorHistoryBlockCount: NonNegativeIntegerSchema,
  previousPriorHistoryBlockCount: NonNegativeIntegerSchema.nullable(),
  summaryLikeBlockIds: z.array(z.string().min(1)),
  newHistoryBlockIds: z.array(z.string().min(1)),
  changedHistoryBlockIds: z.array(z.string().min(1)),
  repeatedContextBlockCount: NonNegativeIntegerSchema,
  changedContextBlockCount: NonNegativeIntegerSchema,
}).strict();

export const SpyCompactionAssessmentSchema = z.object({
  status: z.enum(["none", "candidate"]),
  source: SpyCompactionDetectionSourceSchema,
  confidence: SpyCompactionConfidenceSchema,
  label: z.string().min(1),
  reasons: z.array(SpyCompactionReasonSchema),
  evidence: SpyCompactionEvidenceSchema,
}).strict();

export const SpyCallSummarySchema = z.object({
  call: ProviderCallSchema,
  durationMs: NonNegativeIntegerSchema.nullable(),
  usage: SpyUsageSummarySchema,
  requestBlockCount: NonNegativeIntegerSchema,
  responseBlockCount: NonNegativeIntegerSchema,
  requestByteSize: NonNegativeIntegerSchema,
  responseByteSize: NonNegativeIntegerSchema,
  cacheMarkerCount: NonNegativeIntegerSchema,
  streamEventCount: NonNegativeIntegerSchema,
  rawPayloadCount: NonNegativeIntegerSchema,
}).strict();

export const SpyRequestCompositionSectionSchema = z.object({
  kind: NormalizedBlockKindSchema,
  present: z.boolean(),
  blockCount: NonNegativeIntegerSchema,
  messageCount: NonNegativeIntegerSchema,
  charSize: NonNegativeIntegerSchema,
  byteSize: NonNegativeIntegerSchema,
}).strict();

export const SpyRequestCompositionSchema = z.object({
  totalBlockCount: NonNegativeIntegerSchema,
  totalMessageCount: NonNegativeIntegerSchema,
  totalCharSize: NonNegativeIntegerSchema,
  totalByteSize: NonNegativeIntegerSchema,
  sections: z.array(SpyRequestCompositionSectionSchema),
  toolDefinitionCount: NonNegativeIntegerSchema,
  toolSchemaCharSize: NonNegativeIntegerSchema,
  toolSchemaByteSize: NonNegativeIntegerSchema,
  cacheMarkerCount: NonNegativeIntegerSchema,
  cacheMarkerCharSize: NonNegativeIntegerSchema,
  cacheMarkerByteSize: NonNegativeIntegerSchema,
  mediaSummaryCount: NonNegativeIntegerSchema,
  mediaSummaryCharSize: NonNegativeIntegerSchema,
  mediaSummaryByteSize: NonNegativeIntegerSchema,
  usage: SpyUsageSummarySchema,
}).strict();

export function spyPaginatedResultSchema<T extends z.ZodType>(itemSchema: T): z.ZodObject<{
  items: z.ZodArray<T>;
  nextCursor: z.ZodOptional<z.ZodString>;
}> {
  return z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().optional(),
  }).strict();
}

export const SpyCallSummaryPageSchema = spyPaginatedResultSchema(SpyCallSummarySchema);
export const StreamEventPageSchema = spyPaginatedResultSchema(StreamEventSchema);

export const SpyCallDetailSchema = z.object({
  summary: SpyCallSummarySchema,
  requestComposition: SpyRequestCompositionSchema,
  compaction: SpyCompactionAssessmentSchema,
  tokenCounts: z.array(SpyTokenCountRecordSchema),
  httpEvents: z.array(HttpEventRecordSchema),
  blocks: z.array(NormalizedBlockSchema),
  usageRecords: z.array(UsageRecordSchema),
  rawPayloads: z.array(RawPayloadRecordSchema),
}).strict();

export const SpyBlockDiffSchema = z.object({
  block: NormalizedBlockSchema,
  classification: DiffClassificationSchema,
  previousBlockId: z.string().optional(),
}).strict();

export const SpyCallDiffSchema = z.object({
  call: SpyCallSummarySchema,
  previousCall: SpyCallSummarySchema.nullable(),
  blocks: z.array(SpyBlockDiffSchema),
}).strict();

export const SseEventNameSchema = z.enum(["hello", "health", "calls-changed", "token-counts-changed", "cleared"]);

export const SseHelloPayloadSchema = z.object({
  id: NonNegativeIntegerSchema,
}).strict();

export const SseCallsChangedPayloadSchema = z.union([
  z.object({ result: IngestSpoolBatchResultSchema }).strict(),
  z.object({ retention: RetentionResultSchema }).strict(),
]);

export const SseTokenCountsChangedPayloadSchema = z.object({
  callId: z.string().min(1),
  records: z.array(SpyTokenCountRecordSchema).min(1),
}).strict();

export const SseEventPayloadSchemas = {
  hello: SseHelloPayloadSchema,
  health: SpyServiceHealthSchema,
  "calls-changed": SseCallsChangedPayloadSchema,
  "token-counts-changed": SseTokenCountsChangedPayloadSchema,
  cleared: ClearDataResultSchema,
} as const;

export type ClearDataResult = Readonly<z.infer<typeof ClearDataResultSchema>>;
export type IngestSpoolBatchResult = Readonly<z.infer<typeof IngestSpoolBatchResultSchema>>;
export type RetentionResult = Readonly<z.infer<typeof RetentionResultSchema>>;
export type SpyHealthSnapshot = Readonly<z.infer<typeof SpyHealthSnapshotSchema>>;
export type SpyServiceHealth = Readonly<z.infer<typeof SpyServiceHealthSchema>>;
export type SpyTokenCountMode = z.infer<typeof SpyTokenCountModeSchema>;
export type SpyTokenCountProvenance = z.infer<typeof SpyTokenCountProvenanceSchema>;
export type SpyTokenCountSubject = Readonly<z.infer<typeof SpyTokenCountSubjectSchema>>;
export type SpyTokenCountRequest = Readonly<z.infer<typeof SpyTokenCountRequestSchema>>;
export type SpyTokenCountRecord = Readonly<z.infer<typeof SpyTokenCountRecordSchema>>;
export type SpyTokenCountResponse = Readonly<z.infer<typeof SpyTokenCountResponseSchema>>;
export type SpyCompactionDetectionSource = z.infer<typeof SpyCompactionDetectionSourceSchema>;
export type SpyCompactionConfidence = z.infer<typeof SpyCompactionConfidenceSchema>;
export type SpyCompactionReason = z.infer<typeof SpyCompactionReasonSchema>;
export type SpyCompactionEvidence = Readonly<z.infer<typeof SpyCompactionEvidenceSchema>>;
export type SpyCompactionAssessment = Readonly<z.infer<typeof SpyCompactionAssessmentSchema>>;
export type SpyUsageSummary = Readonly<z.infer<typeof SpyUsageSummarySchema>>;
export type SpyCallSummary = Readonly<z.infer<typeof SpyCallSummarySchema>>;
export type SpyRequestCompositionSection = Readonly<z.infer<typeof SpyRequestCompositionSectionSchema>>;
export type SpyRequestComposition = Readonly<z.infer<typeof SpyRequestCompositionSchema>>;
export type SpyCallDetail = Readonly<z.infer<typeof SpyCallDetailSchema>>;
export type SpyBlockDiff = Readonly<z.infer<typeof SpyBlockDiffSchema>>;
export type SpyCallDiff = Readonly<z.infer<typeof SpyCallDiffSchema>>;
export type SpyPaginatedResult<T> = Readonly<{
  readonly items: readonly T[];
  readonly nextCursor?: string | undefined;
}>;
export type SseEventName = z.infer<typeof SseEventNameSchema>;
export type SseHelloPayload = Readonly<z.infer<typeof SseHelloPayloadSchema>>;
export type SseCallsChangedPayload = Readonly<z.infer<typeof SseCallsChangedPayloadSchema>>;
export type SseTokenCountsChangedPayload = Readonly<z.infer<typeof SseTokenCountsChangedPayloadSchema>>;
