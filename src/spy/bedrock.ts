import { createHash } from "node:crypto";
import { decodeAwsEventStreamJson } from "./eventstream.ts";
import type {
  NormalizedBlock,
  ProviderCall,
  RawPayloadRecord,
  SpoolEvent,
  SpoolRequestEvent,
  SpoolResponseEvent,
  StreamEvent,
  UsageRecord,
} from "./schemas.ts";

export interface BedrockAdapterOptions {
  readonly storeRaw?: boolean;
}

export interface NormalizedProviderCall {
  readonly call: ProviderCall;
  readonly blocks: readonly NormalizedBlock[];
  readonly usage: readonly UsageRecord[];
  readonly streamEvents: readonly StreamEvent[];
  readonly rawPayloads: readonly RawPayloadRecord[];
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

type BlockKind = NormalizedBlock["kind"];
type Direction = NormalizedBlock["direction"];

interface BlockInput {
  readonly callId: string;
  readonly direction: Direction;
  readonly ordinal: number;
  readonly kind: BlockKind;
  readonly source: string;
  readonly role?: string | undefined;
  readonly providerPath?: string | undefined;
  readonly text?: string | undefined;
  readonly json?: unknown;
  readonly cacheMarker?: boolean;
}

interface ResponseBlockBuilder {
  readonly index: number;
  readonly providerPath: string;
  readonly textParts: string[];
  readonly thinkingParts: string[];
  readonly thinkingValues: unknown[];
  readonly toolInputParts: string[];
  readonly unknownValues: unknown[];
  role?: string | undefined;
  toolUseStart?: Record<string, unknown>;
}

interface JsonParseResult {
  readonly ok: boolean;
  readonly value?: unknown;
}

export function normalizeBedrockCall(
  request: SpoolRequestEvent,
  response: SpoolResponseEvent,
  options: BedrockAdapterOptions = {},
): NormalizedProviderCall {
  if (request.flow_id !== response.flow_id) {
    throw new Error(`cannot normalize Bedrock call with mismatched flow ids: ${request.flow_id} != ${response.flow_id}`);
  }
  if (request.operation !== response.operation || request.model_id !== response.model_id) {
    throw new Error(`cannot normalize Bedrock call with mismatched request/response metadata for flow ${request.flow_id}`);
  }

  const normalizedRequest = normalizeBedrockRequest(request, options);
  const normalizedResponse = normalizeBedrockResponse(response, options);

  return {
    call: {
      ...normalizedRequest.call,
      status: normalizedResponse.call.status,
      completed_at: normalizedResponse.call.completed_at,
      status_code: normalizedResponse.call.status_code,
      response_flow_id: normalizedResponse.call.response_flow_id,
      response_content_hash: normalizedResponse.call.response_content_hash,
    },
    blocks: [...normalizedRequest.blocks, ...normalizedResponse.blocks],
    usage: normalizedResponse.usage,
    streamEvents: normalizedResponse.streamEvents,
    rawPayloads: [...normalizedRequest.rawPayloads, ...normalizedResponse.rawPayloads],
  };
}

export function normalizeBedrockRequest(
  request: SpoolRequestEvent,
  options: BedrockAdapterOptions = {},
): NormalizedProviderRequest {
  const callId = bedrockCallIdForFlow(request.flow_id);
  const requestBody = parseRequestBody(request);
  return {
    call: {
      id: callId,
      provider: "bedrock",
      operation: request.operation,
      model_id: request.model_id,
      status: "pending",
      started_at: request.ts,
      request_flow_id: request.flow_id,
      request_content_hash: hashUnknown(requestBody),
    },
    blocks: normalizeRequestBlocks(callId, request.operation, requestBody),
    rawPayloads: options.storeRaw === true ? [rawPayload(callId, "request", request)] : [],
  };
}

export function normalizeBedrockResponse(
  response: SpoolResponseEvent,
  options: BedrockAdapterOptions = {},
): NormalizedProviderResponse {
  const callId = bedrockCallIdForFlow(response.flow_id);
  const responseNormalization = normalizeResponse(callId, response);
  return {
    call: {
      id: callId,
      provider: "bedrock",
      operation: response.operation,
      model_id: response.model_id,
      status: response.status_code >= 400 ? "error" : "complete",
      started_at: response.ts,
      completed_at: response.ts,
      status_code: response.status_code,
      request_flow_id: response.flow_id,
      response_flow_id: response.flow_id,
      response_content_hash: hashUnknown(responseNormalization.blocks.map((block) => block.content_hash)),
    },
    blocks: responseNormalization.blocks,
    usage: responseNormalization.usage,
    streamEvents: responseNormalization.streamEvents,
    rawPayloads: options.storeRaw === true ? [rawPayload(callId, "response", response)] : [],
  };
}

export function bedrockCallIdForFlow(flowId: string): string {
  return stableId("call", flowId);
}

export function normalizeBedrockSpoolEvents(
  events: readonly SpoolEvent[],
  options: BedrockAdapterOptions = {},
): NormalizedProviderCall[] {
  const requests = new Map<string, SpoolRequestEvent>();
  const responses = new Map<string, SpoolResponseEvent>();

  for (const event of events) {
    if (event.direction === "request") {
      if (requests.has(event.flow_id)) {
        throw new Error(`duplicate Bedrock request event for flow ${event.flow_id}`);
      }
      requests.set(event.flow_id, event);
    } else if (event.direction === "response") {
      if (responses.has(event.flow_id)) {
        throw new Error(`duplicate Bedrock response event for flow ${event.flow_id}`);
      }
      responses.set(event.flow_id, event);
    }
  }

  for (const flowId of responses.keys()) {
    if (!requests.has(flowId)) {
      throw new Error(`Bedrock response event has no matching request for flow ${flowId}`);
    }
  }

  return [...requests.values()]
    .filter((request) => responses.has(request.flow_id))
    .sort((left, right) => left.ts - right.ts || left.flow_id.localeCompare(right.flow_id))
    .map((request) => {
      const response = responses.get(request.flow_id);
      if (response === undefined) {
        throw new Error(`Bedrock request event has no matching response for flow ${request.flow_id}`);
      }
      return normalizeBedrockCall(request, response, options);
    });
}

function normalizeRequestBlocks(callId: string, operation: string, body: Record<string, unknown>): NormalizedBlock[] {
  return isConverseOperation(operation)
    ? normalizeConverseRequestBlocks(callId, body)
    : normalizeAnthropicMessagesRequestBlocks(callId, body);
}

function isConverseOperation(operation: string): boolean {
  return operation === "converse" || operation === "converse-stream";
}

function normalizeConverseRequestBlocks(callId: string, body: Record<string, unknown>): NormalizedBlock[] {
  const blocks: NormalizedBlock[] = [];
  let ordinal = 0;
  const messages = arrayField(body, "messages").filter(isRecord);
  const lastUserMessageIndex = findLastUserMessageIndex(messages);

  const addBlock = (input: Omit<BlockInput, "callId" | "direction" | "ordinal">): void => {
    blocks.push(createBlock({
      callId,
      direction: "request",
      ordinal,
      ...input,
    }));
    ordinal += 1;
  };

  for (const [key, value] of Object.entries(body)) {
    if (key === "messages") {
      normalizeRequestMessages(value, lastUserMessageIndex, addBlock);
    } else if (key === "system") {
      normalizeSystemBlocks(value, addBlock);
    } else if (key === "toolConfig") {
      normalizeToolConfig(value, addBlock);
    } else if (key === "inferenceConfig" || key === "additionalModelRequestFields") {
      addBlock({
        kind: "provider-envelope",
        source: "bedrock-converse-request",
        providerPath: `$.${key}`,
        text: key,
        json: value,
      });
    } else {
      addBlock({
        kind: "unknown",
        source: "bedrock-converse-request",
        providerPath: `$.${key}`,
        text: key,
        json: value,
      });
    }
  }

  return blocks;
}

function normalizeAnthropicMessagesRequestBlocks(callId: string, body: Record<string, unknown>): NormalizedBlock[] {
  const blocks: NormalizedBlock[] = [];
  let ordinal = 0;
  const messages = arrayField(body, "messages").filter(isRecord);
  const lastUserMessageIndex = findLastUserMessageIndex(messages);

  const addBlock = (input: Omit<BlockInput, "callId" | "direction" | "ordinal">): void => {
    blocks.push(createBlock({
      callId,
      direction: "request",
      ordinal,
      ...input,
    }));
    ordinal += 1;
  };

  for (const [key, value] of Object.entries(body)) {
    if (key === "messages") {
      normalizeAnthropicMessages(value, lastUserMessageIndex, addBlock);
    } else if (key === "system") {
      normalizeAnthropicSystem(value, addBlock);
    } else if (key === "tools") {
      normalizeAnthropicTools(value, addBlock);
    } else if (ANTHROPIC_REQUEST_ENVELOPE_FIELDS.has(key)) {
      addBlock({
        kind: "provider-envelope",
        source: "bedrock-anthropic-request",
        providerPath: `$.${key}`,
        text: requestEnvelopeText(key, value),
        json: value,
      });
    } else {
      addBlock({
        kind: "unknown",
        source: "bedrock-anthropic-request",
        providerPath: `$.${key}`,
        text: key,
        json: value,
      });
    }
  }

  return blocks;
}

const ANTHROPIC_REQUEST_ENVELOPE_FIELDS = new Set([
  "anthropic_version",
  "anthropic_beta",
  "max_tokens",
  "metadata",
  "model",
  "output_config",
  "service_tier",
  "stop_sequences",
  "stream",
  "temperature",
  "thinking",
  "tool_choice",
  "top_k",
  "top_p",
]);

function normalizeAnthropicSystem(
  value: unknown,
  addBlock: (input: Omit<BlockInput, "callId" | "direction" | "ordinal">) => void,
): void {
  if (typeof value === "string") {
    addBlock({
      kind: "harness-system-context",
      source: sourceForAnthropicSystemText(value),
      providerPath: "$.system",
      text: value,
    });
    return;
  }

  if (!Array.isArray(value)) {
    addBlock({
      kind: "unknown",
      source: "bedrock-anthropic-system",
      providerPath: "$.system",
      text: "system",
      json: value,
    });
    return;
  }

  value.forEach((item, index) => {
    normalizeAnthropicContentBlock(item, {
      role: "system",
      providerPath: `$.system[${String(index)}]`,
      textKind: "harness-system-context",
      source: "bedrock-anthropic-system",
      addBlock,
    });
  });
}

function normalizeAnthropicMessages(
  value: unknown,
  lastUserMessageIndex: number,
  addBlock: (input: Omit<BlockInput, "callId" | "direction" | "ordinal">) => void,
): void {
  if (!Array.isArray(value)) {
    addBlock({
      kind: "unknown",
      source: "bedrock-anthropic-messages",
      providerPath: "$.messages",
      text: "messages",
      json: value,
    });
    return;
  }

  value.forEach((message, messageIndex) => {
    if (!isRecord(message)) {
      addBlock({
        kind: "unknown",
        source: "bedrock-anthropic-message",
        providerPath: `$.messages[${String(messageIndex)}]`,
        json: message,
      });
      return;
    }

    const role = stringField(message, "role");
    const providerPath = `$.messages[${String(messageIndex)}]`;
    const content = message.content;
    const textKind = role === "user" && messageIndex === lastUserMessageIndex
      ? "current-user-input"
      : "prior-conversation-history";

    if (typeof content === "string") {
      addBlock({
        kind: textKind,
        source: "bedrock-anthropic-message",
        providerPath: `${providerPath}.content`,
        role,
        text: content,
      });
      return;
    }

    if (!Array.isArray(content) || content.length === 0) {
      addBlock({
        kind: "unknown",
        source: "bedrock-anthropic-message",
        providerPath,
        role,
        json: message,
      });
      return;
    }

    content.forEach((item, contentIndex) => {
      normalizeAnthropicContentBlock(item, {
        role,
        providerPath: `${providerPath}.content[${String(contentIndex)}]`,
        textKind,
        source: "bedrock-anthropic-message",
        addBlock,
      });
    });
  });
}

function normalizeAnthropicTools(
  value: unknown,
  addBlock: (input: Omit<BlockInput, "callId" | "direction" | "ordinal">) => void,
): void {
  if (!Array.isArray(value) || value.length === 0) {
    addBlock({
      kind: "provider-envelope",
      source: "bedrock-anthropic-tools",
      providerPath: "$.tools",
      text: "tools",
      json: value,
    });
    return;
  }

  value.forEach((tool, index) => {
    addBlock({
      kind: "tool-definition",
      source: "bedrock-anthropic-tools",
      providerPath: `$.tools[${String(index)}]`,
      text: anthropicToolDefinitionText(tool),
      json: tool,
    });
  });
}

function normalizeAnthropicContentBlock(
  item: unknown,
  context: {
    readonly role?: string | undefined;
    readonly providerPath: string;
    readonly textKind: NormalizedBlock["kind"];
    readonly source: string;
    readonly addBlock: (input: Omit<BlockInput, "callId" | "direction" | "ordinal">) => void;
  },
): void {
  if (!isRecord(item)) {
    context.addBlock({
      kind: "unknown",
      source: context.source,
      providerPath: context.providerPath,
      role: context.role,
      json: item,
    });
    return;
  }

  const type = stringField(item, "type");
  const text = stringField(item, "text");
  if (text !== undefined && (type === undefined || type === "text")) {
    context.addBlock({
      kind: context.textKind,
      source: context.textKind === "harness-system-context" ? sourceForAnthropicSystemText(text) : context.source,
      providerPath: `${context.providerPath}.text`,
      role: context.role,
      text,
    });
    addAnthropicCacheMarker(item, context);
    return;
  }

  if (type === "tool_use") {
    context.addBlock({
      kind: "tool-call",
      source: context.source,
      providerPath: context.providerPath,
      role: context.role,
      text: toolUseText(item),
      json: item,
    });
    addAnthropicCacheMarker(item, context);
    return;
  }

  if (type === "tool_result") {
    context.addBlock({
      kind: "tool-result",
      source: context.source,
      providerPath: context.providerPath,
      role: context.role,
      text: anthropicToolResultText(item),
      json: item,
    });
    addAnthropicCacheMarker(item, context);
    return;
  }

  if (type === "thinking" || type === "redacted_thinking") {
    const thinking = stringField(item, "thinking") ?? stringField(item, "text");
    context.addBlock({
      kind: "thinking",
      source: context.source,
      providerPath: context.providerPath,
      role: context.role,
      json: item,
      ...(thinking === undefined ? {} : { text: thinking }),
    });
    addAnthropicCacheMarker(item, context);
    return;
  }

  if (type === "image" || type === "document") {
    context.addBlock({
      kind: "media-summary",
      source: context.source,
      providerPath: context.providerPath,
      role: context.role,
      text: mediaSummaryText(item),
      json: item,
    });
    addAnthropicCacheMarker(item, context);
    return;
  }

  if (item.cache_control !== undefined && Object.keys(item).length === 1) {
    addAnthropicCacheMarker(item, context);
    return;
  }

  context.addBlock({
    kind: "unknown",
    source: context.source,
    providerPath: context.providerPath,
    role: context.role,
    json: item,
  });
  addAnthropicCacheMarker(item, context);
}

function addAnthropicCacheMarker(
  item: Record<string, unknown>,
  context: {
    readonly role?: string | undefined;
    readonly providerPath: string;
    readonly source: string;
    readonly addBlock: (input: Omit<BlockInput, "callId" | "direction" | "ordinal">) => void;
  },
): void {
  const cacheControl = item.cache_control;
  if (cacheControl === undefined) {
    return;
  }
  context.addBlock({
    kind: "cache-marker",
    source: "bedrock-anthropic-cache-control",
    providerPath: `${context.providerPath}.cache_control`,
    role: context.role,
    text: cacheControlText(cacheControl),
    json: cacheControl,
    cacheMarker: true,
  });
}

function normalizeSystemBlocks(
  value: unknown,
  addBlock: (input: Omit<BlockInput, "callId" | "direction" | "ordinal">) => void,
): void {
  if (!Array.isArray(value)) {
    addBlock({
      kind: "unknown",
      source: "bedrock-converse-system",
      providerPath: "$.system",
      text: "system",
      json: value,
    });
    return;
  }

  value.forEach((item, index) => {
    if (!isRecord(item)) {
      addBlock({
        kind: "unknown",
        source: "bedrock-converse-system",
        providerPath: `$.system[${String(index)}]`,
        json: item,
      });
      return;
    }

    const text = stringField(item, "text");
    if (text !== undefined) {
      addBlock({
        kind: "harness-system-context",
        source: "pi-bedrock-system",
        providerPath: `$.system[${String(index)}].text`,
        text,
      });
      return;
    }

    const cachePoint = item.cachePoint;
    if (cachePoint !== undefined) {
      addBlock({
        kind: "cache-marker",
        source: "bedrock-converse-cache-point",
        providerPath: `$.system[${String(index)}].cachePoint`,
        text: cachePointText(cachePoint),
        json: cachePoint,
        cacheMarker: true,
      });
      return;
    }

    addBlock({
      kind: "unknown",
      source: "bedrock-converse-system",
      providerPath: `$.system[${String(index)}]`,
      json: item,
    });
  });
}

function normalizeRequestMessages(
  value: unknown,
  lastUserMessageIndex: number,
  addBlock: (input: Omit<BlockInput, "callId" | "direction" | "ordinal">) => void,
): void {
  if (!Array.isArray(value)) {
    addBlock({
      kind: "unknown",
      source: "bedrock-converse-messages",
      providerPath: "$.messages",
      text: "messages",
      json: value,
    });
    return;
  }

  value.forEach((message, messageIndex) => {
    if (!isRecord(message)) {
      addBlock({
        kind: "unknown",
        source: "bedrock-converse-message",
        providerPath: `$.messages[${String(messageIndex)}]`,
        json: message,
      });
      return;
    }

    const role = stringField(message, "role");
    const content = arrayField(message, "content");
    if (content.length === 0) {
      addBlock({
        kind: "unknown",
        source: "bedrock-converse-message",
        providerPath: `$.messages[${String(messageIndex)}]`,
        role,
        json: message,
      });
      return;
    }

    content.forEach((item, contentIndex) => {
      const providerPath = `$.messages[${String(messageIndex)}].content[${String(contentIndex)}]`;
      normalizeMessageContentBlock(item, {
        role,
        providerPath,
        isCurrentUserMessage: role === "user" && messageIndex === lastUserMessageIndex,
        addBlock,
      });
    });
  });
}

function normalizeMessageContentBlock(
  item: unknown,
  context: {
    readonly role?: string | undefined;
    readonly providerPath: string;
    readonly isCurrentUserMessage: boolean;
    readonly addBlock: (input: Omit<BlockInput, "callId" | "direction" | "ordinal">) => void;
  },
): void {
  if (!isRecord(item)) {
    context.addBlock({
      kind: "unknown",
      source: "bedrock-converse-message",
      providerPath: context.providerPath,
      role: context.role,
      json: item,
    });
    return;
  }

  const text = stringField(item, "text");
  if (text !== undefined) {
    context.addBlock({
      kind: context.isCurrentUserMessage ? "current-user-input" : "prior-conversation-history",
      source: "bedrock-converse-message",
      providerPath: `${context.providerPath}.text`,
      role: context.role,
      text,
    });
    return;
  }

  const cachePoint = item.cachePoint;
  if (cachePoint !== undefined) {
    context.addBlock({
      kind: "cache-marker",
      source: "bedrock-converse-cache-point",
      providerPath: `${context.providerPath}.cachePoint`,
      role: context.role,
      text: cachePointText(cachePoint),
      json: cachePoint,
      cacheMarker: true,
    });
    return;
  }

  const reasoningContent = item.reasoningContent;
  if (reasoningContent !== undefined) {
    const reasoningText = reasoningContentText(reasoningContent);
    context.addBlock({
      kind: "thinking",
      source: "bedrock-converse-message",
      providerPath: `${context.providerPath}.reasoningContent`,
      role: context.role,
      json: reasoningContent,
      ...(reasoningText === undefined ? {} : { text: reasoningText }),
    });
    return;
  }

  const toolUse = item.toolUse;
  if (toolUse !== undefined) {
    context.addBlock({
      kind: "tool-call",
      source: "bedrock-converse-message",
      providerPath: `${context.providerPath}.toolUse`,
      role: context.role,
      text: toolUseText(toolUse),
      json: toolUse,
    });
    return;
  }

  const toolResult = item.toolResult;
  if (toolResult !== undefined) {
    context.addBlock({
      kind: "tool-result",
      source: "bedrock-converse-message",
      providerPath: `${context.providerPath}.toolResult`,
      role: context.role,
      text: toolResultText(toolResult),
      json: toolResult,
    });
    return;
  }

  context.addBlock({
    kind: "unknown",
    source: "bedrock-converse-message",
    providerPath: context.providerPath,
    role: context.role,
    json: item,
  });
}

function normalizeToolConfig(
  value: unknown,
  addBlock: (input: Omit<BlockInput, "callId" | "direction" | "ordinal">) => void,
): void {
  if (!isRecord(value)) {
    addBlock({
      kind: "unknown",
      source: "bedrock-converse-tool-config",
      providerPath: "$.toolConfig",
      text: "toolConfig",
      json: value,
    });
    return;
  }

  const tools = arrayField(value, "tools");
  if (tools.length === 0) {
    addBlock({
      kind: "provider-envelope",
      source: "bedrock-converse-tool-config",
      providerPath: "$.toolConfig",
      text: "toolConfig",
      json: value,
    });
    return;
  }

  tools.forEach((tool, index) => {
    addBlock({
      kind: "tool-definition",
      source: "bedrock-converse-tool-config",
      providerPath: `$.toolConfig.tools[${String(index)}]`,
      text: toolDefinitionText(tool),
      json: tool,
    });
  });
}

function normalizeResponse(
  callId: string,
  response: SpoolResponseEvent,
): {
  readonly blocks: readonly NormalizedBlock[];
  readonly usage: readonly UsageRecord[];
  readonly streamEvents: readonly StreamEvent[];
} {
  return isConverseOperation(response.operation)
    ? normalizeConverseResponse(callId, response)
    : normalizeAnthropicMessagesResponse(callId, response);
}

function normalizeConverseResponse(
  callId: string,
  response: SpoolResponseEvent,
): {
  readonly blocks: readonly NormalizedBlock[];
  readonly usage: readonly UsageRecord[];
  readonly streamEvents: readonly StreamEvent[];
} {
  const decoded = decodeAwsEventStreamJson(responseBodyB64(response));
  const blocks: NormalizedBlock[] = [];
  const usage: UsageRecord[] = [];
  const builders = new Map<number, ResponseBlockBuilder>();
  const finalized = new Set<number>();
  let ordinal = 0;
  let responseRole: string | undefined;

  const addBlock = (input: Omit<BlockInput, "callId" | "direction" | "ordinal">): void => {
    blocks.push(createBlock({
      callId,
      direction: "response",
      ordinal,
      ...input,
    }));
    ordinal += 1;
  };

  const getBuilder = (index: number, providerPath: string): ResponseBlockBuilder => {
    const existing = builders.get(index);
    if (existing !== undefined) {
      return existing;
    }
    const builder: ResponseBlockBuilder = {
      index,
      providerPath,
      textParts: [],
      thinkingParts: [],
      thinkingValues: [],
      toolInputParts: [],
      unknownValues: [],
      ...(responseRole === undefined ? {} : { role: responseRole }),
    };
    builders.set(index, builder);
    return builder;
  };

  const finalizeBuilder = (index: number): void => {
    if (finalized.has(index)) {
      return;
    }
    const builder = builders.get(index);
    if (builder === undefined) {
      return;
    }
    finalized.add(index);

    const role = builder.role ?? responseRole;
    if (builder.textParts.length > 0) {
      addBlock({
        kind: "assistant-output",
        source: "bedrock-converse-response",
        providerPath: builder.providerPath,
        role,
        text: builder.textParts.join(""),
      });
    }

    if (builder.thinkingParts.length > 0 || builder.thinkingValues.length > 0) {
      const thinkingText = builder.thinkingParts.length > 0 ? builder.thinkingParts.join("") : undefined;
      const thinkingJson = builder.thinkingValues.length > 0 ? builder.thinkingValues : undefined;
      addBlock({
        kind: "thinking",
        source: "bedrock-converse-response",
        providerPath: builder.providerPath,
        role,
        ...(thinkingText === undefined ? {} : { text: thinkingText }),
        ...(thinkingJson === undefined ? {} : { json: thinkingJson }),
      });
    }

    if (builder.toolUseStart !== undefined) {
      const inputText = builder.toolInputParts.join("");
      const toolUse: Record<string, unknown> = { ...builder.toolUseStart };
      if (inputText.length > 0) {
        toolUse.inputText = inputText;
        const parsed = parseJson(inputText);
        toolUse.input = parsed.ok ? parsed.value : inputText;
      }
      addBlock({
        kind: "tool-call",
        source: "bedrock-converse-response",
        providerPath: builder.providerPath,
        role,
        text: toolUseText(toolUse),
        json: { toolUse },
      });
    }

    if (builder.unknownValues.length > 0) {
      addBlock({
        kind: "unknown",
        source: "bedrock-converse-response",
        providerPath: builder.providerPath,
        role,
        json: builder.unknownValues,
      });
    }
  };

  decoded.forEach((message, eventIndex) => {
    const eventType = stringField(message.headers, ":event-type") ?? "unknown";
    const payload = message.payload;
    if (eventType === "messageStart" && isRecord(payload)) {
      responseRole = stringField(payload, "role") ?? responseRole;
      return;
    }

    if (eventType === "contentBlockStart" && isRecord(payload)) {
      const blockIndex = numberField(payload, "contentBlockIndex");
      if (blockIndex === undefined) {
        return;
      }
      const builder = getBuilder(blockIndex, `$.eventStream[${String(eventIndex)}].payload`);
      if (builder.role === undefined && responseRole !== undefined) {
        builder.role = responseRole;
      }
      const start = recordField(payload, "start");
      const toolUse = recordField(start, "toolUse");
      if (toolUse !== undefined) {
        builder.toolUseStart = toolUse;
      } else if (start !== undefined) {
        builder.unknownValues.push(start);
      }
      return;
    }

    if (eventType === "contentBlockDelta" && isRecord(payload)) {
      const blockIndex = numberField(payload, "contentBlockIndex");
      const delta = recordField(payload, "delta");
      if (blockIndex === undefined || delta === undefined) {
        return;
      }
      const builder = getBuilder(blockIndex, `$.eventStream[${String(eventIndex)}].payload`);
      if (builder.role === undefined && responseRole !== undefined) {
        builder.role = responseRole;
      }
      const text = stringField(delta, "text");
      if (text !== undefined) {
        builder.textParts.push(text);
      }
      const toolUseInput = stringField(recordField(delta, "toolUse"), "input");
      if (toolUseInput !== undefined) {
        builder.toolInputParts.push(toolUseInput);
      }
      const thinking = thinkingDelta(delta);
      if (thinking !== undefined) {
        if (thinking.text !== undefined) {
          builder.thinkingParts.push(thinking.text);
        }
        if (thinking.json !== undefined) {
          builder.thinkingValues.push(thinking.json);
        }
      }
      if (text === undefined && toolUseInput === undefined && thinking === undefined) {
        builder.unknownValues.push(delta);
      }
      return;
    }

    if (eventType === "contentBlockStop" && isRecord(payload)) {
      const blockIndex = numberField(payload, "contentBlockIndex");
      if (blockIndex !== undefined) {
        finalizeBuilder(blockIndex);
      }
      return;
    }

    if (eventType === "messageStop") {
      addBlock({
        kind: "provider-envelope",
        source: "bedrock-converse-response",
        providerPath: `$.eventStream[${String(eventIndex)}].payload`,
        role: responseRole,
        text: messageStopText(payload),
        json: payload,
      });
      return;
    }

    if (eventType === "metadata") {
      const usageRecord = usageRecordFromMetadata(callId, usage.length, payload);
      if (usageRecord !== undefined) {
        usage.push(usageRecord);
      }
      addBlock({
        kind: "provider-envelope",
        source: "bedrock-converse-response",
        providerPath: `$.eventStream[${String(eventIndex)}].payload`,
        role: responseRole,
        text: metadataText(payload),
        json: payload,
      });
    }
  });

  for (const index of builders.keys()) {
    finalizeBuilder(index);
  }

  return {
    blocks,
    usage,
    streamEvents: decoded.map((message, index) => streamEvent(callId, response.ts, index, message.headers, message.payload)),
  };
}

function normalizeAnthropicMessagesResponse(
  callId: string,
  response: SpoolResponseEvent,
): {
  readonly blocks: readonly NormalizedBlock[];
  readonly usage: readonly UsageRecord[];
  readonly streamEvents: readonly StreamEvent[];
} {
  if (response.body_encoding === "aws-eventstream" && response.body_b64 !== undefined) {
    return normalizeAnthropicMessagesStreamResponse(callId, response);
  }
  return normalizeAnthropicMessagesJsonResponse(callId, response);
}

function normalizeAnthropicMessagesJsonResponse(
  callId: string,
  response: SpoolResponseEvent,
): {
  readonly blocks: readonly NormalizedBlock[];
  readonly usage: readonly UsageRecord[];
  readonly streamEvents: readonly StreamEvent[];
} {
  const body = parseResponseBody(response);
  const blocks: NormalizedBlock[] = [];
  let ordinal = 0;
  const role = stringField(body, "role");

  const addBlock = (input: Omit<BlockInput, "callId" | "direction" | "ordinal">): void => {
    blocks.push(createBlock({
      callId,
      direction: "response",
      ordinal,
      ...input,
    }));
    ordinal += 1;
  };

  normalizeAnthropicResponseContent(body.content, {
    role,
    providerPath: "$.content",
    addBlock,
  });

  addBlock({
    kind: "provider-envelope",
    source: "bedrock-anthropic-response",
    providerPath: "$",
    role,
    text: anthropicResponseEnvelopeText(body),
    json: compactEnvelopeJson(body, ["content", "usage"]),
  });

  const usageRecord = usageRecordFromUsage(callId, 0, recordField(body, "usage"));
  return {
    blocks,
    usage: usageRecord === undefined ? [] : [usageRecord],
    streamEvents: [],
  };
}

function normalizeAnthropicMessagesStreamResponse(
  callId: string,
  response: SpoolResponseEvent,
): {
  readonly blocks: readonly NormalizedBlock[];
  readonly usage: readonly UsageRecord[];
  readonly streamEvents: readonly StreamEvent[];
} {
  const decoded = decodeAwsEventStreamJson(responseBodyB64(response));
  const messages = decoded.map((message) => ({
    headers: message.headers,
    payload: anthropicStreamPayload(message.payload),
  }));
  const blocks: NormalizedBlock[] = [];
  const builders = new Map<number, ResponseBlockBuilder>();
  const finalized = new Set<number>();
  let ordinal = 0;
  let responseRole: string | undefined;
  const usageParts: Record<string, unknown> = {};

  const addBlock = (input: Omit<BlockInput, "callId" | "direction" | "ordinal">): void => {
    blocks.push(createBlock({
      callId,
      direction: "response",
      ordinal,
      ...input,
    }));
    ordinal += 1;
  };

  const getBuilder = (index: number, providerPath: string): ResponseBlockBuilder => {
    const existing = builders.get(index);
    if (existing !== undefined) {
      return existing;
    }
    const builder: ResponseBlockBuilder = {
      index,
      providerPath,
      textParts: [],
      thinkingParts: [],
      thinkingValues: [],
      toolInputParts: [],
      unknownValues: [],
      ...(responseRole === undefined ? {} : { role: responseRole }),
    };
    builders.set(index, builder);
    return builder;
  };

  const finalizeBuilder = (index: number): void => {
    if (finalized.has(index)) {
      return;
    }
    const builder = builders.get(index);
    if (builder === undefined) {
      return;
    }
    finalized.add(index);

    const role = builder.role ?? responseRole;
    if (builder.textParts.length > 0) {
      addBlock({
        kind: "assistant-output",
        source: "bedrock-anthropic-response",
        providerPath: builder.providerPath,
        role,
        text: builder.textParts.join(""),
      });
    }

    if (builder.thinkingParts.length > 0 || builder.thinkingValues.length > 0) {
      const thinkingText = builder.thinkingParts.length > 0 ? builder.thinkingParts.join("") : undefined;
      const thinkingJson = builder.thinkingValues.length > 0 ? builder.thinkingValues : undefined;
      addBlock({
        kind: "thinking",
        source: "bedrock-anthropic-response",
        providerPath: builder.providerPath,
        role,
        ...(thinkingText === undefined ? {} : { text: thinkingText }),
        ...(thinkingJson === undefined ? {} : { json: thinkingJson }),
      });
    }

    if (builder.toolUseStart !== undefined) {
      const inputText = builder.toolInputParts.join("");
      const toolUse: Record<string, unknown> = { ...builder.toolUseStart };
      if (inputText.length > 0) {
        toolUse.inputText = inputText;
        const parsed = parseJson(inputText);
        toolUse.input = parsed.ok ? parsed.value : inputText;
      }
      addBlock({
        kind: "tool-call",
        source: "bedrock-anthropic-response",
        providerPath: builder.providerPath,
        role,
        text: toolUseText(toolUse),
        json: { toolUse },
      });
    }

    if (builder.unknownValues.length > 0) {
      addBlock({
        kind: "unknown",
        source: "bedrock-anthropic-response",
        providerPath: builder.providerPath,
        role,
        json: builder.unknownValues,
      });
    }
  };

  messages.forEach((message, eventIndex) => {
    const payload = message.payload;
    const eventType = stringField(payload, "type") ?? stringField(message.headers, ":event-type") ?? "unknown";
    const providerPath = `$.eventStream[${String(eventIndex)}].payload`;

    if (eventType === "message_start" && isRecord(payload)) {
      const messageStart = recordField(payload, "message");
      responseRole = stringField(messageStart, "role") ?? responseRole;
      mergeUsage(usageParts, recordField(messageStart, "usage"));
      return;
    }

    if (eventType === "content_block_start" && isRecord(payload)) {
      const blockIndex = numberField(payload, "index");
      const contentBlock = recordField(payload, "content_block");
      if (blockIndex === undefined || contentBlock === undefined) {
        return;
      }
      const builder = getBuilder(blockIndex, providerPath);
      if (builder.role === undefined && responseRole !== undefined) {
        builder.role = responseRole;
      }
      seedAnthropicResponseBuilder(builder, contentBlock);
      return;
    }

    if (eventType === "content_block_delta" && isRecord(payload)) {
      const blockIndex = numberField(payload, "index");
      const delta = recordField(payload, "delta");
      if (blockIndex === undefined || delta === undefined) {
        return;
      }
      const builder = getBuilder(blockIndex, providerPath);
      if (builder.role === undefined && responseRole !== undefined) {
        builder.role = responseRole;
      }
      applyAnthropicResponseDelta(builder, delta);
      return;
    }

    if (eventType === "content_block_stop" && isRecord(payload)) {
      const blockIndex = numberField(payload, "index");
      if (blockIndex !== undefined) {
        finalizeBuilder(blockIndex);
      }
      return;
    }

    if (eventType === "message_delta" && isRecord(payload)) {
      mergeUsage(usageParts, recordField(payload, "usage"));
      addBlock({
        kind: "provider-envelope",
        source: "bedrock-anthropic-response",
        providerPath,
        role: responseRole,
        text: anthropicMessageDeltaText(payload),
        json: payload,
      });
      return;
    }

    if (eventType === "message_stop") {
      addBlock({
        kind: "provider-envelope",
        source: "bedrock-anthropic-response",
        providerPath,
        role: responseRole,
        text: "message_stop",
        json: payload,
      });
      return;
    }

    addBlock({
      kind: "unknown",
      source: "bedrock-anthropic-response",
      providerPath,
      role: responseRole,
      json: payload,
    });
  });

  for (const index of builders.keys()) {
    finalizeBuilder(index);
  }

  const usageRecord = usageRecordFromUsage(callId, 0, usageParts);
  return {
    blocks,
    usage: usageRecord === undefined ? [] : [usageRecord],
    streamEvents: messages.map((message, index) => streamEvent(callId, response.ts, index, message.headers, message.payload)),
  };
}

function createBlock(input: BlockInput): NormalizedBlock {
  const material = input.json === undefined ? input.text ?? "" : canonicalJson(input.json);
  return {
    id: stableId("block", input.callId, input.direction, String(input.ordinal)),
    call_id: input.callId,
    direction: input.direction,
    ordinal: input.ordinal,
    kind: input.kind,
    source: input.source,
    char_size: material.length,
    byte_size: Buffer.byteLength(material, "utf8"),
    content_hash: sha256(material),
    cache_marker: input.cacheMarker ?? false,
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.providerPath === undefined ? {} : { provider_path: input.providerPath }),
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.json === undefined ? {} : { json: input.json }),
  };
}

function streamEvent(
  callId: string,
  observedAt: number,
  ordinal: number,
  headers: Readonly<Record<string, unknown>>,
  payload: unknown,
): StreamEvent {
  const payloadText = streamPayloadText(payload);
  return {
    id: stableId("stream", callId, String(ordinal)),
    call_id: callId,
    ordinal,
    event_type: stringField(payload, "type") ?? stringField(headers, ":event-type") ?? "unknown",
    headers: { ...headers },
    observed_at: observedAt,
    ...(payload === undefined ? {} : { payload }),
    ...(payloadText === undefined ? {} : { payload_text: payloadText }),
    ...(payload === undefined ? {} : { payload_sha256: hashUnknown(payload) }),
  };
}

function usageRecordFromMetadata(callId: string, index: number, payload: unknown): UsageRecord | undefined {
  return usageRecordFromUsage(callId, index, recordField(payload, "usage"));
}

function usageRecordFromUsage(callId: string, index: number, usage: Record<string, unknown> | undefined): UsageRecord | undefined {
  if (usage === undefined || Object.keys(usage).length === 0) {
    return undefined;
  }

  const inputTokens = firstNumber(usage, ["inputTokens", "input_tokens"]);
  const outputTokens = firstNumber(usage, ["outputTokens", "output_tokens"]);
  const cacheReadTokens = firstNumber(usage, [
    "cacheReadTokens",
    "cacheReadInputTokens",
    "cache_read_tokens",
    "cache_read_input_tokens",
  ]);
  const cacheWriteTokens = firstNumber(usage, [
    "cacheWriteTokens",
    "cacheWriteInputTokens",
    "cacheCreationInputTokens",
    "cache_creation_input_tokens",
    "cache_write_tokens",
    "cache_write_input_tokens",
  ]);
  const totalTokens = firstNumber(usage, ["totalTokens", "total_tokens"]) ?? sumNumbers([
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  ]);

  return {
    id: stableId("usage", callId, String(index)),
    call_id: callId,
    source: "provider-reported",
    raw: usage,
    ...optionalIntegerField("input_tokens", inputTokens),
    ...optionalIntegerField("output_tokens", outputTokens),
    ...optionalIntegerField("cache_read_tokens", cacheReadTokens),
    ...optionalIntegerField("cache_write_tokens", cacheWriteTokens),
    ...optionalIntegerField("total_tokens", totalTokens),
  };
}

function sumNumbers(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0 ? undefined : present.reduce((total, value) => total + value, 0);
}

function rawPayload(
  callId: string,
  direction: RawPayloadRecord["direction"],
  event: {
    readonly headers: readonly (readonly [string, string])[];
    readonly body_text?: string | undefined;
    readonly body_b64?: string | undefined;
    readonly body_sha256?: string | undefined;
    readonly body_encoding?: "aws-eventstream" | undefined;
  },
): RawPayloadRecord {
  const contentType = headerValue(event.headers, "content-type");
  return {
    id: stableId("raw", callId, direction),
    call_id: callId,
    direction,
    ...(contentType === undefined ? {} : { content_type: contentType }),
    ...bodyFields(event),
  };
}

function bodyFields(event: {
  readonly body_text?: string | undefined;
  readonly body_b64?: string | undefined;
  readonly body_sha256?: string | undefined;
  readonly body_encoding?: "aws-eventstream" | undefined;
}): Pick<RawPayloadRecord, "body_text" | "body_b64" | "body_sha256" | "body_encoding"> {
  return {
    ...(event.body_text === undefined ? {} : { body_text: event.body_text }),
    ...(event.body_b64 === undefined ? {} : { body_b64: event.body_b64 }),
    ...(event.body_sha256 === undefined ? {} : { body_sha256: event.body_sha256 }),
    ...(event.body_encoding === undefined ? {} : { body_encoding: event.body_encoding }),
  };
}

function parseRequestBody(request: SpoolRequestEvent): Record<string, unknown> {
  const text = capturedBodyText(request);
  const parsed = parseJson(text);
  if (!parsed.ok || !isRecord(parsed.value)) {
    throw new Error(`Bedrock request body for flow ${request.flow_id} is not a JSON object`);
  }
  return parsed.value;
}

function parseResponseBody(response: SpoolResponseEvent): Record<string, unknown> {
  const text = capturedBodyText(response);
  const parsed = parseJson(text);
  if (!parsed.ok || !isRecord(parsed.value)) {
    throw new Error(`Bedrock response body for flow ${response.flow_id} is not a JSON object`);
  }
  return parsed.value;
}

function responseBodyB64(response: SpoolResponseEvent): string {
  if (response.body_encoding !== "aws-eventstream" || response.body_b64 === undefined) {
    throw new Error(`Bedrock response body for flow ${response.flow_id} is not an AWS event stream`);
  }
  return response.body_b64;
}

function capturedBodyText(event: { readonly body_text?: string | undefined; readonly body_b64?: string | undefined }): string {
  if (event.body_text !== undefined) {
    return event.body_text;
  }
  if (event.body_b64 !== undefined) {
    return Buffer.from(event.body_b64, "base64").toString("utf8");
  }
  throw new Error("capture event has no body");
}

function findLastUserMessageIndex(messages: readonly Record<string, unknown>[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && stringField(message, "role") === "user") {
      return index;
    }
  }
  return -1;
}

function cachePointText(value: unknown): string {
  const type = stringField(value, "type");
  return type === undefined ? "cachePoint" : `cachePoint:${type}`;
}

function toolDefinitionText(value: unknown): string {
  const toolSpec = recordField(value, "toolSpec");
  const name = stringField(toolSpec, "name");
  const description = stringField(toolSpec, "description");
  return [name, description].filter((part) => part !== undefined && part.length > 0).join(" ");
}

function anthropicToolDefinitionText(value: unknown): string {
  const name = stringField(value, "name");
  const description = stringField(value, "description");
  return [name, description].filter((part) => part !== undefined && part.length > 0).join(" ") || "tool";
}

function toolUseText(value: unknown): string {
  const record = isRecord(value) && isRecord(value.toolUse) ? value.toolUse : value;
  const name = stringField(record, "name") ?? "toolUse";
  const toolUseId = stringField(record, "toolUseId") ?? stringField(record, "id");
  const inputText = stringField(record, "inputText");
  return [name, toolUseId, inputText].filter((part) => part !== undefined && part.length > 0).join(" ");
}

function toolResultText(value: unknown): string {
  const toolUseId = stringField(value, "toolUseId") ?? "toolResult";
  const status = stringField(value, "status");
  return status === undefined ? toolUseId : `${toolUseId} ${status}`;
}

function anthropicToolResultText(value: unknown): string {
  const toolUseId = stringField(value, "tool_use_id") ?? stringField(value, "toolUseId") ?? "toolResult";
  const content = valueContentText(value);
  return content === undefined ? toolUseId : `${toolUseId} ${content}`;
}

function mediaSummaryText(value: unknown): string {
  const type = stringField(value, "type") ?? "media";
  const mediaType = stringField(recordField(value, "source"), "media_type") ?? stringField(value, "media_type");
  return mediaType === undefined ? type : `${type}:${mediaType}`;
}

function cacheControlText(value: unknown): string {
  const type = stringField(value, "type");
  return type === undefined ? "cache_control" : `cache_control:${type}`;
}

function requestEnvelopeText(key: string, value: unknown): string {
  return `${key}: ${requestEnvelopeValueText(value)}`;
}

function requestEnvelopeValueText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  return truncateText(canonicalJson(value), 1_000);
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function sourceForAnthropicSystemText(text: string): string {
  return /\bClaude Code\b|\bofficial CLI for Claude\b|\bclaude code\b/i.test(text)
    ? "claude-code-bedrock-system"
    : "bedrock-anthropic-system";
}

function anthropicResponseEnvelopeText(value: Record<string, unknown>): string {
  const stopReason = stringField(value, "stop_reason");
  if (stopReason !== undefined) {
    return `stop_reason:${stopReason}`;
  }
  return stringField(value, "type") ?? "message";
}

function anthropicMessageDeltaText(value: Record<string, unknown>): string {
  const delta = recordField(value, "delta");
  const stopReason = stringField(delta, "stop_reason");
  return stopReason === undefined ? "message_delta" : `stop_reason:${stopReason}`;
}

function compactEnvelopeJson(value: Record<string, unknown>, omittedKeys: readonly string[]): Record<string, unknown> {
  const omitted = new Set(omittedKeys);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omitted.has(key)));
}

function normalizeAnthropicResponseContent(
  value: unknown,
  context: {
    readonly role?: string | undefined;
    readonly providerPath: string;
    readonly addBlock: (input: Omit<BlockInput, "callId" | "direction" | "ordinal">) => void;
  },
): void {
  if (!Array.isArray(value)) {
    context.addBlock({
      kind: "unknown",
      source: "bedrock-anthropic-response",
      providerPath: context.providerPath,
      role: context.role,
      json: value,
    });
    return;
  }

  value.forEach((item, index) => {
    const providerPath = `${context.providerPath}[${String(index)}]`;
    if (!isRecord(item)) {
      context.addBlock({
        kind: "unknown",
        source: "bedrock-anthropic-response",
        providerPath,
        role: context.role,
        json: item,
      });
      return;
    }

    const type = stringField(item, "type");
    if (type === "text") {
      context.addBlock({
        kind: "assistant-output",
        source: "bedrock-anthropic-response",
        providerPath,
        role: context.role,
        text: stringField(item, "text") ?? "",
      });
      return;
    }
    if (type === "thinking" || type === "redacted_thinking") {
      const thinking = stringField(item, "thinking") ?? stringField(item, "text");
      context.addBlock({
        kind: "thinking",
        source: "bedrock-anthropic-response",
        providerPath,
        role: context.role,
        json: item,
        ...(thinking === undefined ? {} : { text: thinking }),
      });
      return;
    }
    if (type === "tool_use") {
      context.addBlock({
        kind: "tool-call",
        source: "bedrock-anthropic-response",
        providerPath,
        role: context.role,
        text: toolUseText(item),
        json: item,
      });
      return;
    }
    context.addBlock({
      kind: "unknown",
      source: "bedrock-anthropic-response",
      providerPath,
      role: context.role,
      json: item,
    });
  });
}

function seedAnthropicResponseBuilder(builder: ResponseBlockBuilder, contentBlock: Record<string, unknown>): void {
  const type = stringField(contentBlock, "type");
  if (type === "text") {
    const text = stringField(contentBlock, "text");
    if (text !== undefined) {
      builder.textParts.push(text);
    }
    return;
  }
  if (type === "thinking") {
    const thinking = stringField(contentBlock, "thinking");
    if (thinking !== undefined) {
      builder.thinkingParts.push(thinking);
    }
    return;
  }
  if (type === "tool_use") {
    builder.toolUseStart = contentBlock;
    return;
  }
  if (Object.keys(contentBlock).length > 0) {
    builder.unknownValues.push(contentBlock);
  }
}

function applyAnthropicResponseDelta(builder: ResponseBlockBuilder, delta: Record<string, unknown>): void {
  const type = stringField(delta, "type");
  const text = stringField(delta, "text");
  if (type === "text_delta" && text !== undefined) {
    builder.textParts.push(text);
    return;
  }
  const partialJson = stringField(delta, "partial_json");
  if (type === "input_json_delta" && partialJson !== undefined) {
    builder.toolInputParts.push(partialJson);
    return;
  }
  const thinking = stringField(delta, "thinking");
  if (type === "thinking_delta" && thinking !== undefined) {
    builder.thinkingParts.push(thinking);
    return;
  }
  if (type === "signature_delta") {
    builder.thinkingValues.push(delta);
    return;
  }
  builder.unknownValues.push(delta);
}

function anthropicStreamPayload(payload: unknown): unknown {
  const bytes = stringField(payload, "bytes");
  if (bytes === undefined) {
    return payload;
  }
  const decoded = Buffer.from(bytes, "base64").toString("utf8");
  const parsed = parseJson(decoded);
  return parsed.ok ? parsed.value : { bytesText: decoded };
}

function mergeUsage(target: Record<string, unknown>, usage: Record<string, unknown> | undefined): void {
  if (usage === undefined) {
    return;
  }
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      target[key] = value;
    }
  }
}

function valueContentText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const content = value.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  return content.map((item) => {
    if (typeof item === "string") {
      return item;
    }
    return stringField(item, "text");
  }).filter((part): part is string => part !== undefined && part.length > 0).join(" ");
}

function messageStopText(payload: unknown): string {
  const stopReason = stringField(payload, "stopReason");
  return stopReason === undefined ? "messageStop" : `stopReason:${stopReason}`;
}

function metadataText(payload: unknown): string {
  const metrics = recordField(payload, "metrics");
  const latencyMs = numberField(metrics, "latencyMs");
  return latencyMs === undefined ? "metadata" : `latencyMs:${String(latencyMs)}`;
}

function thinkingDelta(delta: Record<string, unknown>): { readonly text?: string | undefined; readonly json?: unknown } | undefined {
  const direct = stringField(delta, "thinking") ?? stringField(delta, "reasoning");
  if (direct !== undefined) {
    return { text: direct };
  }
  const reasoningContent = recordField(delta, "reasoningContent");
  if (reasoningContent !== undefined) {
    const text = reasoningContentText(reasoningContent);
    return {
      json: { reasoningContent },
      ...(text === undefined ? {} : { text }),
    };
  }
  return undefined;
}

function thinkingText(delta: Record<string, unknown>): string | undefined {
  return thinkingDelta(delta)?.text;
}

function reasoningContentText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const direct = stringField(value, "text") ?? stringField(value, "reasoningText");
  if (direct !== undefined) {
    return direct;
  }
  const reasoningText = recordField(value, "reasoningText");
  return stringField(reasoningText, "text");
}

function streamPayloadText(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const type = stringField(payload, "type");
  if (type === "content_block_delta") {
    const delta = recordField(payload, "delta");
    return stringField(delta, "text")
      ?? stringField(delta, "partial_json")
      ?? stringField(delta, "thinking");
  }
  if (type === "content_block_start") {
    const contentBlock = recordField(payload, "content_block");
    return stringField(contentBlock, "text")
      ?? stringField(contentBlock, "thinking")
      ?? toolUseText(contentBlock);
  }
  const delta = recordField(payload, "delta");
  return stringField(delta, "text")
    ?? stringField(recordField(delta, "toolUse"), "input")
    ?? thinkingText(delta ?? {});
}

function optionalIntegerField<TName extends string>(name: TName, value: number | undefined): Readonly<Partial<Record<TName, number>>> {
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    return {} as Readonly<Partial<Record<TName, number>>>;
  }
  return { [name]: value } as Readonly<Partial<Record<TName, number>>>;
}

function firstNumber(record: Record<string, unknown>, names: readonly string[]): number | undefined {
  for (const name of names) {
    const value = numberField(record, name);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function headerValue(headers: readonly (readonly [string, string])[], name: string): string | undefined {
  const lowerName = name.toLowerCase();
  return headers.find(([candidate]) => candidate.toLowerCase() === lowerName)?.[1];
}

function parseJson(text: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const child = value[key];
  return isRecord(child) ? child : undefined;
}

function arrayField(value: Record<string, unknown>, key: string): unknown[] {
  const child = value[key];
  return Array.isArray(child) ? child : [];
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const child = value[key];
  return typeof child === "string" ? child : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const child = value[key];
  return typeof child === "number" && Number.isFinite(child) ? child : undefined;
}

function hashUnknown(value: unknown): string {
  return sha256(canonicalJson(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableId(prefix: string, ...parts: readonly string[]): string {
  return [prefix, ...parts.map(idPart)].join("-");
}

function idPart(value: string): string {
  const cleaned = value.replaceAll(/[^A-Za-z0-9_.-]+/g, "-").replaceAll(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : sha256(value).slice(0, 16);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return JSON.stringify(Number.isFinite(value) ? value : null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(null);
}
