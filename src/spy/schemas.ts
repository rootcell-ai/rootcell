import { z } from "zod";

export const SpyHeaderPairSchema = z.tuple([z.string(), z.string()]);

const CapturedBodyShape = {
  body_text: z.string().optional(),
  body_b64: z.string().optional(),
  body_sha256: z.string().optional(),
  body_encoding: z.enum(["aws-eventstream"]).optional(),
} as const;

export const ProviderIdSchema = z.enum(["bedrock", "cursor"]);

export type ProviderId = z.infer<typeof ProviderIdSchema>;

const HttpCaptureBaseSchema = z.object({
  version: z.literal(1),
  ts: z.number(),
  flow_id: z.string().min(1),
  provider: ProviderIdSchema,
  operation: z.string().min(1),
  model_id: z.string().min(1),
  host: z.string().min(1),
  method: z.string().min(1),
  path: z.string().min(1),
  headers: z.array(SpyHeaderPairSchema),
}).strict();

export const SpoolRequestEventSchema = HttpCaptureBaseSchema.extend({
  direction: z.literal("request"),
  ...CapturedBodyShape,
}).refine(
  (value) => value.body_text !== undefined || value.body_b64 !== undefined,
  { message: "capture event must include body_text or body_b64" },
);

export const SpoolResponseEventSchema = HttpCaptureBaseSchema.extend({
  direction: z.literal("response"),
  status_code: z.number().int().nonnegative(),
  reason: z.string(),
  request_headers: z.array(SpyHeaderPairSchema),
  ...CapturedBodyShape,
}).refine(
  (value) => value.body_text !== undefined || value.body_b64 !== undefined,
  { message: "capture event must include body_text or body_b64" },
);

export const SpoolStreamChunkEventSchema = HttpCaptureBaseSchema.extend({
  direction: z.literal("stream-chunk"),
  chunk_index: z.number().int().nonnegative(),
  body_b64: z.string().min(1),
  body_sha256: z.string().optional(),
  body_encoding: z.enum(["aws-eventstream"]).optional(),
});

export const SpoolErrorEventSchema = z.object({
  version: z.literal(1),
  ts: z.number(),
  direction: z.literal("error"),
  flow_id: z.string().optional(),
  provider: ProviderIdSchema.optional(),
  error: z.string().min(1),
}).strict();

export const SpoolDroppedEventSchema = z.object({
  version: z.literal(1),
  ts: z.number(),
  direction: z.literal("dropped"),
  provider: ProviderIdSchema.optional(),
  reason: z.string().min(1),
  dropped_count: z.number().int().positive(),
}).strict();

export const SpoolEventSchema = z.discriminatedUnion("direction", [
  SpoolRequestEventSchema,
  SpoolResponseEventSchema,
  SpoolStreamChunkEventSchema,
  SpoolErrorEventSchema,
  SpoolDroppedEventSchema,
]);

export type SpoolEvent = Readonly<z.infer<typeof SpoolEventSchema>>;
export type SpoolRequestEvent = Readonly<z.infer<typeof SpoolRequestEventSchema>>;
export type SpoolResponseEvent = Readonly<z.infer<typeof SpoolResponseEventSchema>>;
export type SpoolStreamChunkEvent = Readonly<z.infer<typeof SpoolStreamChunkEventSchema>>;
export type SpoolErrorEvent = Readonly<z.infer<typeof SpoolErrorEventSchema>>;
export type SpoolDroppedEvent = Readonly<z.infer<typeof SpoolDroppedEventSchema>>;

export const ProviderCallStatusSchema = z.enum([
  "pending",
  "complete",
  "error",
  "dropped",
]);

export const ProviderCallSchema = z.object({
  id: z.string().min(1),
  provider: ProviderIdSchema,
  operation: z.string().min(1),
  model_id: z.string().min(1),
  status: ProviderCallStatusSchema,
  started_at: z.number(),
  completed_at: z.number().optional(),
  status_code: z.number().int().nonnegative().optional(),
  request_flow_id: z.string().min(1),
  response_flow_id: z.string().min(1).optional(),
  request_content_hash: z.string().optional(),
  response_content_hash: z.string().optional(),
}).strict();

export type ProviderCall = Readonly<z.infer<typeof ProviderCallSchema>>;

export const HttpEventRecordSchema = z.object({
  id: z.string().min(1),
  call_id: z.string().min(1),
  direction: z.enum(["request", "response"]),
  observed_at: z.number(),
  host: z.string().min(1),
  method: z.string().min(1),
  path: z.string().min(1),
  status_code: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
  headers: z.array(SpyHeaderPairSchema),
  request_headers: z.array(SpyHeaderPairSchema).optional(),
  content_type: z.string().optional(),
  body_text: z.string().optional(),
  body_b64: z.string().optional(),
  body_sha256: z.string().optional(),
  body_encoding: z.enum(["aws-eventstream"]).optional(),
}).strict();

export type HttpEventRecord = Readonly<z.infer<typeof HttpEventRecordSchema>>;

export const NormalizedBlockKindSchema = z.enum([
  "provider-envelope",
  "harness-system-context",
  "user-visible-message",
  "prior-conversation-history",
  "current-user-input",
  "assistant-output",
  "thinking",
  "tool-definition",
  "tool-call",
  "tool-result",
  "cache-marker",
  "media-summary",
  "unknown",
]);

export const NormalizedBlockSchema = z.object({
  id: z.string().min(1),
  call_id: z.string().min(1),
  direction: z.enum(["request", "response"]),
  ordinal: z.number().int().nonnegative(),
  role: z.string().optional(),
  kind: NormalizedBlockKindSchema,
  source: z.string().min(1),
  provider_path: z.string().optional(),
  text: z.string().optional(),
  json: z.unknown().optional(),
  char_size: z.number().int().nonnegative(),
  byte_size: z.number().int().nonnegative(),
  content_hash: z.string().min(1),
  cache_marker: z.boolean().default(false),
}).strict();

export type NormalizedBlock = Readonly<z.infer<typeof NormalizedBlockSchema>>;

export const UsageRecordSchema = z.object({
  id: z.string().min(1),
  call_id: z.string().min(1),
  source: z.literal("provider-reported"),
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  cache_read_tokens: z.number().int().nonnegative().optional(),
  cache_write_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
  raw: z.unknown().optional(),
}).strict();

export type UsageRecord = Readonly<z.infer<typeof UsageRecordSchema>>;

export const StreamEventSchema = z.object({
  id: z.string().min(1),
  call_id: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  event_type: z.string().min(1),
  headers: z.record(z.string(), z.unknown()),
  payload: z.unknown().optional(),
  payload_text: z.string().optional(),
  payload_sha256: z.string().optional(),
  observed_at: z.number().optional(),
}).strict();

export type StreamEvent = Readonly<z.infer<typeof StreamEventSchema>>;

export const RawPayloadRecordSchema = z.object({
  id: z.string().min(1),
  call_id: z.string().min(1),
  direction: z.enum(["request", "response"]),
  content_type: z.string().optional(),
  body_text: z.string().optional(),
  body_b64: z.string().optional(),
  body_sha256: z.string().optional(),
  body_encoding: z.enum(["aws-eventstream"]).optional(),
}).strict();

export type RawPayloadRecord = Readonly<z.infer<typeof RawPayloadRecordSchema>>;

export const DiffClassificationSchema = z.enum([
  "new",
  "repeated",
  "changed",
  "unknown",
]);

export type DiffClassification = z.infer<typeof DiffClassificationSchema>;
