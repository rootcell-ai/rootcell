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
  counters: z.record(z.string(), z.number()),
  metadata: z.record(z.string(), z.string()),
}).strict();

export const SpyServiceHealthSchema = z.object({
  ok: z.literal(true),
  service: z.object({
    bind: z.string().min(1),
    port: NonNegativeIntegerSchema,
    retentionDays: NonNegativeNumberSchema,
    maxBytes: NonNegativeIntegerSchema,
    spoolMaxBytes: NonNegativeIntegerSchema,
    storeRaw: z.boolean(),
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

export const SseEventNameSchema = z.enum(["hello", "health", "calls-changed", "cleared"]);

export const SseHelloPayloadSchema = z.object({
  id: NonNegativeIntegerSchema,
}).strict();

export const SseCallsChangedPayloadSchema = z.union([
  z.object({ result: IngestSpoolBatchResultSchema }).strict(),
  z.object({ retention: RetentionResultSchema }).strict(),
]);

export const SseEventPayloadSchemas = {
  hello: SseHelloPayloadSchema,
  health: SpyServiceHealthSchema,
  "calls-changed": SseCallsChangedPayloadSchema,
  cleared: ClearDataResultSchema,
} as const;

export type ClearDataResult = Readonly<z.infer<typeof ClearDataResultSchema>>;
export type IngestSpoolBatchResult = Readonly<z.infer<typeof IngestSpoolBatchResultSchema>>;
export type RetentionResult = Readonly<z.infer<typeof RetentionResultSchema>>;
export type SpyHealthSnapshot = Readonly<z.infer<typeof SpyHealthSnapshotSchema>>;
export type SpyServiceHealth = Readonly<z.infer<typeof SpyServiceHealthSchema>>;
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
