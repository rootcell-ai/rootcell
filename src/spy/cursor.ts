import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import type {
  NormalizedBlock,
  ProviderCall,
  RawPayloadRecord,
  SpoolRequestEvent,
  SpoolResponseEvent,
  StreamEvent,
  UsageRecord,
} from "./schemas.ts";

export interface CursorAdapterOptions {
  readonly storeRaw?: boolean;
}

export interface NormalizedCursorRequest {
  readonly call: ProviderCall;
  readonly blocks: readonly NormalizedBlock[];
  readonly rawPayloads: readonly RawPayloadRecord[];
}

export interface NormalizedCursorResponse {
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
  readonly charSize?: number | undefined;
  readonly byteSize?: number | undefined;
}

interface TextCandidate {
  readonly path: string;
  readonly key: string;
  readonly text: string;
}

interface RequestContextCandidate {
  readonly kind: BlockKind;
  readonly role: string;
  readonly path: string;
  readonly text: string;
}

interface ResponseSemanticCandidate {
  readonly kind: BlockKind;
  readonly role?: string | undefined;
  readonly path: string;
  readonly text: string;
  readonly json?: unknown;
}

interface ParsedBody {
  readonly text?: string | undefined;
  readonly binaryText?: string | undefined;
  readonly modelText?: string | undefined;
  readonly json?: unknown;
  readonly jsonLines: readonly unknown[];
  readonly proto?: DecodedProtoMessage | undefined;
  readonly connectFrames?: readonly ParsedConnectFrame[] | undefined;
}

interface ParsedConnectFrame {
  readonly index: number;
  readonly compressed: boolean;
  readonly offset: number;
  readonly frameByteLength: number;
  readonly byteLength: number;
  readonly frameB64: string;
  readonly payloadB64: string;
  readonly payloadSha256: string;
  readonly jsonValues: readonly unknown[];
  readonly text?: string | undefined;
  readonly proto?: DecodedProtoMessage | undefined;
}

interface DecodedProtoMessage {
  readonly path: string;
  readonly byteLength: number;
  readonly fields: readonly DecodedProtoField[];
}

interface DecodedProtoField {
  readonly path: string;
  readonly fieldNumber: number;
  readonly wireType: number;
  readonly value?: number | string | undefined;
  readonly text?: string | undefined;
  readonly packedVarints?: readonly number[] | undefined;
  readonly nested?: DecodedProtoMessage | undefined;
  readonly hexDecoded?: DecodedProtoMessage | undefined;
  readonly hexByteLength?: number | undefined;
  readonly hexSha256?: string | undefined;
  readonly byteLength?: number | undefined;
}

interface VarintRead {
  readonly value: bigint;
  readonly nextOffset: number;
}

interface CursorWireUsageCandidate {
  readonly path: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly wireInputTokens: number;
}

interface RequestContextSectionMetadata {
  readonly key: string;
  readonly label: string;
  readonly kind: BlockKind;
  readonly path: string;
  readonly frameIndex: number;
  readonly startOffset?: number | undefined;
  readonly reportedSize: number;
}

interface ProtoSource {
  readonly source: "raw-protobuf" | "connect-frame";
  readonly message: DecodedProtoMessage;
  readonly frameIndex?: number | undefined;
}

interface CursorBidiAppendEnvelope {
  readonly path: string;
  readonly requestId?: string | undefined;
  readonly appendSeqno?: number | undefined;
  readonly dataHexByteLength: number;
  readonly dataDecodedByteLength: number;
  readonly dataSha256: string;
}

interface CursorSkillEntry {
  readonly path: string;
  readonly filePath: string;
  readonly content: string;
  readonly description?: string | undefined;
}

interface CursorProtoUserMessage {
  readonly path: string;
  readonly text: string;
  readonly messageId?: string | undefined;
}

interface CursorToolCapability {
  readonly id: number;
  readonly name: string;
  readonly path: string;
  readonly encoding: "varint" | "packed-varint";
}

const CURSOR_CONTEXT_SECTION_ORDER = [
  "system_prompt",
  "rules",
  "skills",
  "mcp",
  "subagents",
  "tools",
  "summarized_conversation",
  "conversation",
] as const;

const CURSOR_CLIENT_SIDE_TOOL_V2_NAMES = new Map<number, string>([
  [1, "READ_SEMSEARCH_FILES"],
  [3, "RIPGREP_SEARCH"],
  [5, "READ_FILE"],
  [6, "LIST_DIR"],
  [7, "EDIT_FILE"],
  [8, "FILE_SEARCH"],
  [9, "SEMANTIC_SEARCH_FULL"],
  [11, "DELETE_FILE"],
  [12, "REAPPLY"],
  [15, "RUN_TERMINAL_COMMAND_V2"],
  [16, "FETCH_RULES"],
  [18, "WEB_SEARCH"],
  [19, "MCP"],
  [23, "SEARCH_SYMBOLS"],
  [24, "BACKGROUND_COMPOSER_FOLLOWUP"],
  [25, "KNOWLEDGE_BASE"],
  [26, "FETCH_PULL_REQUEST"],
  [27, "DEEP_SEARCH"],
  [28, "CREATE_DIAGRAM"],
  [29, "FIX_LINTS"],
  [30, "READ_LINTS"],
  [31, "GO_TO_DEFINITION"],
  [32, "TASK"],
  [33, "AWAIT_TASK"],
  [34, "TODO_READ"],
  [35, "TODO_WRITE"],
  [38, "EDIT_FILE_V2"],
  [39, "LIST_DIR_V2"],
  [40, "READ_FILE_V2"],
  [41, "RIPGREP_RAW_SEARCH"],
  [42, "GLOB_FILE_SEARCH"],
  [43, "CREATE_PLAN"],
  [44, "LIST_MCP_RESOURCES"],
  [45, "READ_MCP_RESOURCE"],
  [46, "READ_PROJECT"],
  [47, "UPDATE_PROJECT"],
  [48, "TASK_V2"],
  [49, "CALL_MCP_TOOL"],
  [50, "APPLY_AGENT_DIFF"],
  [51, "ASK_QUESTION"],
  [52, "SWITCH_MODE"],
  [53, "GENERATE_IMAGE"],
  [54, "COMPUTER_USE"],
  [55, "WRITE_SHELL_STDIN"],
]);

export function cursorCallIdForFlow(flowId: string): string {
  return stableId("call", "cursor", flowId);
}

export function normalizeCursorRequest(
  request: SpoolRequestEvent,
  options: CursorAdapterOptions = {},
): NormalizedCursorRequest {
  const callId = cursorCallIdForFlow(request.flow_id);
  const body = parseCapturedBody(request);
  const modelId = cursorModelId(request.model_id, body) ?? request.model_id;
  return {
    call: {
      id: callId,
      provider: "cursor",
      operation: request.operation,
      model_id: modelId,
      status: "pending",
      started_at: request.ts,
      request_flow_id: request.flow_id,
      request_content_hash: hashUnknown(capturedBodyHashMaterial(body)),
    },
    blocks: normalizeCursorRequestBlocks(callId, request, body),
    rawPayloads: options.storeRaw === true ? [rawPayload(callId, "request", request)] : [],
  };
}

export function normalizeCursorResponse(
  response: SpoolResponseEvent,
  options: CursorAdapterOptions = {},
): NormalizedCursorResponse {
  const callId = cursorCallIdForFlow(response.flow_id);
  const body = parseCapturedBody(response);
  const modelId = cursorModelId(response.model_id, body) ?? response.model_id;
  const normalized = normalizeCursorResponseBody(callId, response, body);
  return {
    call: {
      id: callId,
      provider: "cursor",
      operation: response.operation,
      model_id: modelId,
      status: response.status_code >= 400 ? "error" : "complete",
      started_at: response.ts,
      completed_at: response.ts,
      status_code: response.status_code,
      request_flow_id: response.flow_id,
      response_flow_id: response.flow_id,
      response_content_hash: hashUnknown(normalized.blocks.map((block) => block.content_hash)),
    },
    blocks: normalized.blocks,
    usage: normalized.usage,
    streamEvents: normalized.streamEvents,
    rawPayloads: options.storeRaw === true ? [rawPayload(callId, "response", response)] : [],
  };
}

function normalizeCursorRequestBlocks(
  callId: string,
  request: SpoolRequestEvent,
  body: ParsedBody,
): NormalizedBlock[] {
  const blocks: NormalizedBlock[] = [];
  const usedPaths = new Set<string>();
  let ordinal = 0;
  const addBlock = (input: Omit<BlockInput, "callId" | "direction" | "ordinal">): void => {
    blocks.push(createBlock({
      callId,
      direction: "request",
      ordinal,
      ...input,
    }));
    ordinal += 1;
  };

  addBlock({
    kind: "provider-envelope",
    source: "cursor-request",
    providerPath: "$.http",
    text: `${request.method} ${request.host}${request.path}`,
    json: {
      host: request.host,
      method: request.method,
      path: request.path,
      operation: request.operation,
      model_id: request.model_id,
    },
  });

  if (body.json !== undefined) {
    normalizeRequestJson(body.json, addBlock, usedPaths);
  } else if (body.jsonLines.length > 0) {
    body.jsonLines.forEach((value, index) => {
      normalizeRequestJson(value, addBlock, usedPaths, `$[${String(index)}]`);
    });
  }

  normalizeRequestProtobuf(body, addBlock, usedPaths);

  const bodyText = body.text ?? body.binaryText;
  if (blocks.length === 1 && bodyText !== undefined && bodyText.trim().length > 0) {
    addBlock({
      kind: body.text === undefined ? "media-summary" : "current-user-input",
      source: body.text === undefined ? "cursor-request-binary-strings" : "cursor-request-body",
      providerPath: "$.body",
      text: truncateText(bodyText, 8_000),
    });
  }

  return blocks;
}

function normalizeRequestProtobuf(
  body: ParsedBody,
  addBlock: (input: Omit<BlockInput, "callId" | "direction" | "ordinal">) => void,
  usedPaths: Set<string>,
): void {
  const sources = cursorProtoSources(body);
  if (sources.length === 0) {
    return;
  }

  const seen = new Set<string>();
  const addUnique = (key: string, input: Omit<BlockInput, "callId" | "direction" | "ordinal">): void => {
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    if (input.providerPath !== undefined) {
      usedPaths.add(input.providerPath);
    }
    addBlock(input);
  };

  for (const source of sources) {
    const envelope = cursorBidiAppendEnvelope(source.message);
    if (envelope !== undefined) {
      addUnique(`bidi-envelope:${envelope.requestId ?? ""}:${String(envelope.appendSeqno ?? "")}:${envelope.dataSha256}`, {
        kind: "provider-envelope",
        source: "cursor-request-protobuf-envelope",
        providerPath: envelope.path,
        text: [
          "Cursor BidiAppend protobuf envelope",
          envelope.requestId === undefined ? undefined : `requestId=${envelope.requestId}`,
          envelope.appendSeqno === undefined ? undefined : `appendSeqno=${String(envelope.appendSeqno)}`,
          `decodedData=${String(envelope.dataDecodedByteLength)} bytes`,
        ].filter((part): part is string => part !== undefined).join(" "),
        json: {
          requestId: envelope.requestId,
          appendSeqno: envelope.appendSeqno,
          dataHexByteLength: envelope.dataHexByteLength,
          dataDecodedByteLength: envelope.dataDecodedByteLength,
          dataSha256: envelope.dataSha256,
        },
      });
    }
  }

  for (const message of collectCursorProtoUserMessages(sources)) {
    addUnique(`user-message:${message.messageId ?? ""}:${message.text}`, {
      kind: "current-user-input",
      source: "cursor-request-protobuf-message",
      providerPath: message.path,
      role: "user",
      text: message.text,
      json: {
        ...(message.messageId === undefined ? {} : { messageId: message.messageId }),
      },
    });
  }

  for (const skill of collectCursorProtoSkills(sources)) {
    addUnique(`skill:${skill.filePath}:${sha256(skill.content)}`, {
      kind: "harness-system-context",
      source: "cursor-request-protobuf-skill",
      providerPath: skill.path,
      role: "skill",
      text: `${skill.filePath}\n\n${skill.content}`,
      json: {
        filePath: skill.filePath,
        ...(skill.description === undefined ? {} : { description: skill.description }),
      },
    });
  }

  for (const model of collectCursorProtoModels(sources)) {
    addUnique(`model:${model.model}`, {
      kind: "provider-envelope",
      source: "cursor-request-protobuf-model",
      providerPath: model.path,
      text: `model: ${model.model}`,
    });
  }

  const toolCapabilities = collectCursorToolCapabilities(sources);
  if (toolCapabilities.length > 0) {
    const tools = toolCapabilities.map((tool) => ({
      id: tool.id,
      name: tool.name,
      path: tool.path,
      encoding: tool.encoding,
    }));
    addUnique(`tool-capabilities:${tools.map((tool) => `${String(tool.id)}:${tool.path}`).join(",")}`, {
      kind: "tool-definition",
      source: "cursor-request-protobuf-tool-enums",
      providerPath: "$.protobuf.ClientSideToolV2",
      text: [
        "Cursor ClientSideToolV2 capabilities:",
        ...tools.map((tool) => `- ${tool.name} (${String(tool.id)}) at ${tool.path}`),
      ].join("\n"),
      json: {
        enum: "ClientSideToolV2",
        tools,
      },
    });
  }
}

function cursorProtoSources(body: ParsedBody): ProtoSource[] {
  const sources: ProtoSource[] = [];
  if (body.proto !== undefined) {
    sources.push({ source: "raw-protobuf", message: body.proto });
  }
  for (const frame of body.connectFrames ?? []) {
    if (frame.proto !== undefined) {
      sources.push({ source: "connect-frame", message: frame.proto, frameIndex: frame.index });
    }
  }
  return sources;
}

function cursorBidiAppendEnvelope(message: DecodedProtoMessage): CursorBidiAppendEnvelope | undefined {
  const dataField = message.fields.find((field) =>
    field.fieldNumber === 1
    && field.wireType === 2
    && field.hexDecoded !== undefined
    && field.hexByteLength !== undefined
    && field.hexSha256 !== undefined
  );
  if (dataField?.hexDecoded === undefined || dataField.hexByteLength === undefined || dataField.hexSha256 === undefined) {
    return undefined;
  }

  const requestIdContainer = message.fields.find((field) => field.fieldNumber === 2 && field.nested !== undefined)?.nested;
  const requestId = requestIdContainer === undefined ? undefined : directProtoTextField(requestIdContainer, 1);
  const appendSeqno = directProtoNumberField(message, 3);
  return {
    path: message.path,
    requestId,
    appendSeqno,
    dataHexByteLength: dataField.byteLength ?? 0,
    dataDecodedByteLength: dataField.hexByteLength,
    dataSha256: dataField.hexSha256,
  };
}

function collectCursorProtoUserMessages(sources: readonly ProtoSource[]): CursorProtoUserMessage[] {
  const messages: CursorProtoUserMessage[] = [];
  const seen = new Set<string>();

  const visit = (message: DecodedProtoMessage): void => {
    const text = directProtoTextField(message, 1);
    const messageId = directProtoTextField(message, 2);
    const role = directProtoNumberField(message, 4);
    if (
      text !== undefined
      && text.trim().length > 0
      && role === 1
      && (messageId === undefined || isUuidLike(messageId))
      && !looksLikeCursorSkillPath(text)
      && !looksLikeCursorSkillContent(text)
    ) {
      const key = `${messageId ?? ""}:${text}`;
      if (!seen.has(key)) {
        seen.add(key);
        messages.push({
          path: message.path,
          text,
          ...(messageId === undefined ? {} : { messageId }),
        });
      }
    }

    for (const child of nestedProtoMessages(message)) {
      visit(child);
    }
  };

  for (const source of sources) {
    visit(source.message);
  }
  return messages;
}

function collectCursorProtoSkills(sources: readonly ProtoSource[]): CursorSkillEntry[] {
  const skills: CursorSkillEntry[] = [];
  const seen = new Set<string>();

  const visit = (message: DecodedProtoMessage): void => {
    const filePath = directProtoTextField(message, 1);
    const content = directProtoTextField(message, 2);
    if (
      filePath !== undefined
      && content !== undefined
      && looksLikeCursorSkillPath(filePath)
      && looksLikeCursorSkillContent(content)
    ) {
      const description = directProtoTextField(message, 3);
      const key = `${filePath}:${sha256(content)}`;
      if (!seen.has(key)) {
        seen.add(key);
        skills.push({
          path: message.path,
          filePath,
          content,
          ...(description === undefined || description.trim().length === 0 ? {} : { description }),
        });
      }
    }

    for (const child of nestedProtoMessages(message)) {
      visit(child);
    }
  };

  for (const source of sources) {
    visit(source.message);
  }
  return skills;
}

function collectCursorProtoModels(sources: readonly ProtoSource[]): { readonly path: string; readonly model: string }[] {
  const models: { readonly path: string; readonly model: string }[] = [];
  const seen = new Set<string>();

  const visit = (message: DecodedProtoMessage): void => {
    for (const field of message.fields) {
      const model = modelIdFromText(field.text);
      if (model !== undefined && !seen.has(model)) {
        seen.add(model);
        models.push({ path: field.path, model });
      }
    }
    for (const child of nestedProtoMessages(message)) {
      visit(child);
    }
  };

  for (const source of sources) {
    visit(source.message);
  }
  return models;
}

function collectCursorToolCapabilities(sources: readonly ProtoSource[]): CursorToolCapability[] {
  const capabilities: CursorToolCapability[] = [];
  const seen = new Set<number>();

  const push = (id: number, path: string, encoding: CursorToolCapability["encoding"]): void => {
    const name = CURSOR_CLIENT_SIDE_TOOL_V2_NAMES.get(id);
    if (name === undefined || seen.has(id)) {
      return;
    }
    seen.add(id);
    capabilities.push({ id, name, path, encoding });
  };

  const visit = (message: DecodedProtoMessage): void => {
    for (const field of message.fields) {
      if (field.fieldNumber === 29 && field.wireType === 0 && typeof field.value === "number") {
        push(field.value, field.path, "varint");
      }
      if (field.fieldNumber === 29 && field.wireType === 2 && plausiblePackedToolIds(field.packedVarints)) {
        for (const id of field.packedVarints) {
          push(id, field.path, "packed-varint");
        }
      }
    }
    for (const child of nestedProtoMessages(message)) {
      visit(child);
    }
  };

  for (const source of sources) {
    visit(source.message);
  }
  return capabilities.sort((left, right) => left.id - right.id);
}

function plausiblePackedToolIds(values: readonly number[] | undefined): values is readonly number[] {
  return values !== undefined
    && values.length > 0
    && values.length <= CURSOR_CLIENT_SIDE_TOOL_V2_NAMES.size
    && values.every((value) => CURSOR_CLIENT_SIDE_TOOL_V2_NAMES.has(value));
}

function nestedProtoMessages(message: DecodedProtoMessage): DecodedProtoMessage[] {
  const nested: DecodedProtoMessage[] = [];
  for (const field of message.fields) {
    nested.push(...nestedProtoMessagesFromField(field));
  }
  return nested;
}

function nestedProtoMessagesFromField(field: DecodedProtoField): DecodedProtoMessage[] {
  return [
    ...(field.nested === undefined ? [] : [field.nested]),
    ...(field.hexDecoded === undefined ? [] : [field.hexDecoded]),
  ];
}

function looksLikeCursorSkillPath(value: string): boolean {
  return /(?:^|\/)\.cursor\/skills(?:-[^/]+)?\/[^/]+\/SKILL\.md$/i.test(value);
}

function looksLikeCursorSkillContent(value: string): boolean {
  return /^---\s*\nname:\s*/.test(value) || /^#\s+\S/.test(value);
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function normalizeRequestJson(
  value: unknown,
  addBlock: (input: Omit<BlockInput, "callId" | "direction" | "ordinal">) => void,
  usedPaths: Set<string>,
  rootPath = "$",
): void {
  const top = isRecord(value) ? value : undefined;
  if (top !== undefined) {
    addKnownStringField(top, ["model", "model_id", "modelName", "modelDisplayName", "selectedModel"], addBlock, usedPaths, rootPath, "provider-envelope");
    addKnownStringField(top, ["system", "systemPrompt", "instructions", "rules", "developerInstruction"], addBlock, usedPaths, rootPath, "harness-system-context");
    addKnownStringField(top, ["prompt", "query", "input", "userInput", "currentPrompt", "currentMessage"], addBlock, usedPaths, rootPath, "current-user-input");
    addKnownValueField(top, ["tools", "toolDefinitions", "functions"], addBlock, usedPaths, rootPath, "tool-definition");
    normalizeMessagesFromKnownFields(top, addBlock, usedPaths, rootPath);
  }

  for (const candidate of collectTextCandidates(value, rootPath)) {
    if (usedPaths.has(candidate.path) || candidate.text.trim().length === 0) {
      continue;
    }
    const kind = requestKindForCandidate(candidate);
    if (kind === undefined) {
      continue;
    }
    usedPaths.add(candidate.path);
    addBlock({
      kind,
      source: "cursor-request-json",
      providerPath: candidate.path,
      text: truncateText(candidate.text, 16_000),
    });
  }

  if (top !== undefined && !hasSemanticRequestBlockForRoot(usedPaths, rootPath)) {
    addBlock({
      kind: "unknown",
      source: "cursor-request-json",
      providerPath: rootPath,
      text: "Cursor request JSON",
      json: value,
    });
  }
}

function normalizeMessagesFromKnownFields(
  top: Record<string, unknown>,
  addBlock: (input: Omit<BlockInput, "callId" | "direction" | "ordinal">) => void,
  usedPaths: Set<string>,
  rootPath: string,
): void {
  for (const key of ["messages", "conversation", "conversationHistory", "history", "transcript"]) {
    const value = top[key];
    if (!Array.isArray(value)) {
      continue;
    }
    const records = value.filter(isRecord);
    const lastUserIndex = findLastUserMessageIndex(records);
    records.forEach((message, index) => {
      const role = stringField(message, "role") ?? stringField(message, "speaker") ?? stringField(message, "type");
      const content = message.content ?? message.text ?? message.message ?? message.prompt;
      const providerPath = `${rootPath}.${key}[${String(index)}]`;
      const text = textFromUnknown(content);
      const kind = role === "system"
        ? "harness-system-context"
        : role === "user" && index === lastUserIndex
          ? "current-user-input"
          : "prior-conversation-history";
      usedPaths.add(providerPath);
      if (text !== undefined && text.length > 0) {
        addBlock({
          kind,
          source: "cursor-request-message",
          providerPath,
          role,
          text: truncateText(text, 16_000),
          ...(content !== text ? { json: content } : {}),
        });
        return;
      }
      addBlock({
        kind: "unknown",
        source: "cursor-request-message",
        providerPath,
        role,
        json: message,
      });
    });
  }
}

function normalizeCursorResponseBody(
  callId: string,
  response: SpoolResponseEvent,
  body: ParsedBody,
): {
  readonly blocks: readonly NormalizedBlock[];
  readonly usage: readonly UsageRecord[];
  readonly streamEvents: readonly StreamEvent[];
} {
  const blocks: NormalizedBlock[] = [];
  let ordinal = 0;
  const addBlock = (input: Omit<BlockInput, "callId" | "direction" | "ordinal">): void => {
    blocks.push(createBlock({
      callId,
      direction: "response",
      ordinal,
      ...input,
    }));
    ordinal += 1;
  };

  addBlock({
    kind: "provider-envelope",
    source: "cursor-response",
    providerPath: "$.http",
    text: `status:${String(response.status_code)}`,
    json: {
      status_code: response.status_code,
      reason: response.reason,
      operation: response.operation,
      model_id: response.model_id,
    },
  });

  const values = structuredValues(body);
  const requestBlocks = normalizeCursorResponseRequestContext(callId, values, body.connectFrames ?? []);
  const textParts = collectCursorResponseText(values);
  if (textParts.length === 0) {
    const bodyText = body.text ?? body.binaryText;
    if (bodyText !== undefined && isUsefulBodyText(bodyText)) {
      textParts.push(bodyText);
    }
  }

  if (textParts.length > 0) {
    addBlock({
      kind: "assistant-output",
      source: "cursor-response-body",
      providerPath: "$.body",
      text: truncateText(joinTextParts(textParts), 32_000),
    });
  }

  for (const candidate of collectCursorResponseSemanticBlocks(values)) {
    addBlock({
      kind: candidate.kind,
      source: "cursor-response-body",
      providerPath: candidate.path,
      role: candidate.role,
      text: truncateText(candidate.text, 16_000),
      ...(candidate.json === undefined ? {} : { json: candidate.json }),
    });
  }

  if (values.length > 0) {
    for (const value of values) {
      const model = cursorModelId(undefined, { json: value, jsonLines: [] });
      if (model !== undefined) {
        addBlock({
          kind: "provider-envelope",
          source: "cursor-response-json",
          providerPath: "$.model",
          text: `model: ${model}`,
        });
        break;
      }
    }
  } else if (textParts.length === 0) {
    addBlock({
      kind: "unknown",
      source: "cursor-response-body",
      providerPath: "$.body",
      text: "Cursor response body",
    });
  }

  return {
    blocks: [...requestBlocks, ...blocks],
    usage: usageRecords(callId, values, body.connectFrames ?? []),
    streamEvents: streamEvents(callId, response.ts, body),
  };
}

function normalizeCursorResponseRequestContext(
  callId: string,
  values: readonly unknown[],
  frames: readonly ParsedConnectFrame[],
): NormalizedBlock[] {
  const candidates = collectCursorRequestContextCandidates(values);
  const blocks: NormalizedBlock[] = [];
  const seen = new Set<string>();
  let ordinal = 1000;

  for (const candidate of candidates) {
    const text = candidate.text.trim();
    const key = `${candidate.kind}\n${candidate.role}\n${text}`;
    if (text.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    blocks.push(createBlock({
      callId,
      direction: "request",
      ordinal,
      kind: candidate.kind,
      source: "cursor-response-request-context",
      providerPath: candidate.path,
      role: candidate.role,
      text: truncateText(text, 32_000),
    }));
    ordinal += 1;
  }

  for (const metadata of collectCursorRequestContextSectionMetadata(frames)) {
    if (requestContextMetadataCovered(blocks, metadata)) {
      continue;
    }
    const key = `metadata\n${metadata.key}\n${String(metadata.reportedSize)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    blocks.push(createBlock({
      callId,
      direction: "request",
      ordinal,
      kind: metadata.kind,
      source: "cursor-response-context-metadata",
      providerPath: metadata.path,
      text: `Cursor reported ${metadata.label} in request context (${String(metadata.reportedSize)} bytes). Exact section text was not exposed in captured Cursor HTTP payload.`,
      json: {
        sectionKey: metadata.key,
        sectionLabel: metadata.label,
        reportedCharSize: metadata.reportedSize,
        reportedByteSize: metadata.reportedSize,
        frameIndex: metadata.frameIndex,
        ...(metadata.startOffset === undefined ? {} : { startOffset: metadata.startOffset }),
      },
      charSize: metadata.reportedSize,
      byteSize: metadata.reportedSize,
    }));
    ordinal += 1;
  }

  return blocks;
}

function collectCursorRequestContextSectionMetadata(
  frames: readonly ParsedConnectFrame[],
): RequestContextSectionMetadata[] {
  const byKey = new Map<string, RequestContextSectionMetadata>();

  const visit = (message: DecodedProtoMessage, frameIndex: number): void => {
    const metadata = cursorRequestContextSectionMetadata(message, frameIndex);
    if (metadata !== undefined) {
      const existing = byKey.get(metadata.key);
      if (
        existing === undefined
        || metadata.reportedSize > existing.reportedSize
        || (metadata.reportedSize === existing.reportedSize && metadata.frameIndex > existing.frameIndex)
      ) {
        byKey.set(metadata.key, metadata);
      }
    }
    for (const field of message.fields) {
      for (const child of nestedProtoMessagesFromField(field)) {
        visit(child, frameIndex);
      }
    }
  };

  for (const frame of frames) {
    if (frame.proto !== undefined) {
      visit(frame.proto, frame.index);
    }
  }

  return [...byKey.values()].sort((left, right) =>
    cursorContextSectionOrder(left.key) - cursorContextSectionOrder(right.key)
  );
}

function cursorRequestContextSectionMetadata(
  message: DecodedProtoMessage,
  frameIndex: number,
): RequestContextSectionMetadata | undefined {
  const key = directProtoTextField(message, 1);
  const label = directProtoTextField(message, 2);
  const reportedSize = directProtoNumberField(message, 4);
  if (key === undefined || label === undefined || reportedSize === undefined || reportedSize <= 0) {
    return undefined;
  }
  const kind = cursorContextSectionKind(key);
  if (kind === undefined) {
    return undefined;
  }
  const startOffset = directProtoNumberField(message, 3);
  return {
    key,
    label,
    kind,
    path: message.path,
    frameIndex,
    ...(startOffset === undefined ? {} : { startOffset }),
    reportedSize,
  };
}

function cursorContextSectionKind(key: string): BlockKind | undefined {
  if (key === "tools") {
    return "tool-definition";
  }
  if (key === "conversation" || key === "summarized_conversation") {
    return "prior-conversation-history";
  }
  if (key === "system_prompt" || key === "rules" || key === "skills" || key === "mcp" || key === "subagents") {
    return "harness-system-context";
  }
  return undefined;
}

function cursorContextSectionOrder(key: string): number {
  const index = CURSOR_CONTEXT_SECTION_ORDER.indexOf(key as (typeof CURSOR_CONTEXT_SECTION_ORDER)[number]);
  return index === -1 ? CURSOR_CONTEXT_SECTION_ORDER.length : index;
}

function requestContextMetadataCovered(
  blocks: readonly NormalizedBlock[],
  metadata: RequestContextSectionMetadata,
): boolean {
  if (metadata.key === "tools") {
    return blocks.some((block) => block.kind === "tool-definition");
  }
  if (metadata.key === "conversation" || metadata.key === "summarized_conversation") {
    return blocks.some((block) => block.kind === "prior-conversation-history");
  }
  if (metadata.key === "system_prompt") {
    return blocks.some((block) => block.kind === "harness-system-context" && block.role === "system");
  }

  const pattern = cursorContextSectionCoveragePattern(metadata.key);
  if (pattern !== undefined) {
    return blocks.some((block) =>
      block.kind === "harness-system-context"
      && block.text !== undefined
      && pattern.test(block.text)
    );
  }

  return blocks.some((block) => block.kind === metadata.kind);
}

function cursorContextSectionCoveragePattern(key: string): RegExp | undefined {
  if (key === "rules") {
    return /<(?:rules|user_rules)\b/i;
  }
  if (key === "skills") {
    return /<(?:agent_skills|available_skills|agent_skill)\b/i;
  }
  if (key === "mcp") {
    return /<mcp\b/i;
  }
  if (key === "subagents") {
    return /subagent/i;
  }
  return undefined;
}

function directProtoTextField(message: DecodedProtoMessage, fieldNumber: number): string | undefined {
  return message.fields.find((field) => field.fieldNumber === fieldNumber && typeof field.text === "string")?.text;
}

function directProtoNumberField(message: DecodedProtoMessage, fieldNumber: number): number | undefined {
  const value = message.fields.find((field) => field.fieldNumber === fieldNumber && typeof field.value === "number")?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function collectCursorRequestContextCandidates(values: readonly unknown[]): RequestContextCandidate[] {
  const candidates: RequestContextCandidate[] = [];

  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        visit(item, `${path}[${String(index)}]`);
      });
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    if (isCursorSummaryMessage(value)) {
      return;
    }

    const role = stringField(value, "role");
    if (role === "system" || role === "user" || role === "human") {
      const text = messageTextFromRecord(value);
      if (text !== undefined) {
        const classified = classifyCursorRequestContext(role, text);
        if (classified !== undefined) {
          candidates.push({
            kind: classified.kind,
            role,
            path,
            text: classified.text,
          });
        }
        return;
      }
    }
    if (role === "assistant") {
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      visit(child, `${path}.${key}`);
    }
  };

  values.forEach((value, index) => {
    visit(value, `$.body[${String(index)}]`);
  });

  return candidates;
}

function isCursorSummaryMessage(value: Record<string, unknown>): boolean {
  const providerOptions = value.providerOptions;
  if (!isRecord(providerOptions)) {
    return false;
  }
  const cursor = providerOptions.cursor;
  return isRecord(cursor) && cursor.isSummary === true;
}

function messageTextFromRecord(value: Record<string, unknown>): string | undefined {
  const parts = [
    ...collectMessageText(value.content),
    stringField(value, "text"),
    stringField(value, "message"),
  ].filter((part): part is string => part !== undefined && part.trim().length > 0);
  return parts.length === 0 ? undefined : joinTextParts(parts);
}

function classifyCursorRequestContext(
  role: string,
  text: string,
): { readonly kind: BlockKind; readonly text: string } | undefined {
  if (role === "system") {
    return { kind: "harness-system-context", text };
  }

  const userQuery = extractCursorUserQuery(text);
  if (userQuery !== undefined) {
    return { kind: "current-user-input", text: userQuery };
  }

  if (isCursorHarnessContext(text)) {
    return { kind: "harness-system-context", text };
  }

  return { kind: "prior-conversation-history", text };
}

function extractCursorUserQuery(text: string): string | undefined {
  const match = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/i.exec(text);
  const query = match?.[1]?.trim();
  return query === undefined || query.length === 0 ? undefined : query;
}

function isCursorHarnessContext(text: string): boolean {
  return /<(?:user_info|agent_transcripts|rules|user_rules|communication|citing_code|terminal_files_information)\b/i.test(text);
}

function addKnownStringField(
  value: Record<string, unknown>,
  keys: readonly string[],
  addBlock: (input: Omit<BlockInput, "callId" | "direction" | "ordinal">) => void,
  usedPaths: Set<string>,
  rootPath: string,
  kind: BlockKind,
): void {
  for (const key of keys) {
    const child = value[key];
    if (typeof child !== "string" || child.length === 0) {
      continue;
    }
    const providerPath = `${rootPath}.${key}`;
    usedPaths.add(providerPath);
    addBlock({
      kind,
      source: "cursor-request-json",
      providerPath,
      text: kind === "provider-envelope" ? `${key}: ${child}` : child,
    });
  }
}

function addKnownValueField(
  value: Record<string, unknown>,
  keys: readonly string[],
  addBlock: (input: Omit<BlockInput, "callId" | "direction" | "ordinal">) => void,
  usedPaths: Set<string>,
  rootPath: string,
  kind: BlockKind,
): void {
  for (const key of keys) {
    const child = value[key];
    if (child === undefined) {
      continue;
    }
    const providerPath = `${rootPath}.${key}`;
    usedPaths.add(providerPath);
    addBlock({
      kind,
      source: "cursor-request-json",
      providerPath,
      text: truncateText(textFromUnknown(child) ?? key, 8_000),
      json: child,
    });
  }
}

function requestKindForCandidate(candidate: TextCandidate): BlockKind | undefined {
  const keyPath = `${candidate.key} ${candidate.path}`.toLowerCase();
  if (/\b(system|instruction|rules?|developer|policy)\b/.test(keyPath)) {
    return "harness-system-context";
  }
  if (/\b(tool|function|schema)\b/.test(keyPath)) {
    return "tool-definition";
  }
  if (/\b(history|conversation|transcript|previous|prior|context)\b/.test(keyPath)) {
    return "prior-conversation-history";
  }
  if (/\b(prompt|query|input|message|content|text|user)\b/.test(keyPath)) {
    return "current-user-input";
  }
  if (/\b(model|version|mode)\b/.test(keyPath)) {
    return "provider-envelope";
  }
  return undefined;
}

function collectCursorResponseText(values: readonly unknown[]): string[] {
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | undefined): void => {
    if (value === undefined) {
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      return;
    }
    seen.add(trimmed);
    parts.push(trimmed);
  };

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) {
      return;
    }

    const role = stringField(value, "role");
    if (role === "assistant") {
      collectMessageText(value.content).forEach(push);
      push(stringField(value, "text"));
      push(stringField(value, "result"));
      return;
    }
    if (role !== undefined) {
      return;
    }

    const type = stringField(value, "type");
    if (type === "assistant" && isRecord(value.message)) {
      collectMessageText(value.message.content).forEach(push);
      push(stringField(value.message, "text"));
      return;
    }

    const result = value.result;
    if (typeof result === "string") {
      push(result);
    } else if (isRecord(result)) {
      push(stringField(result, "text"));
      push(stringField(result, "message"));
      push(stringField(result, "output"));
    }

    for (const child of Object.values(value)) {
      visit(child);
    }
  };

  values.forEach(visit);

  return parts;
}

function collectCursorResponseSemanticBlocks(values: readonly unknown[]): ResponseSemanticCandidate[] {
  const candidates: ResponseSemanticCandidate[] = [];
  const seen = new Set<string>();

  const push = (candidate: ResponseSemanticCandidate): void => {
    const key = `${candidate.kind}\n${candidate.role ?? ""}\n${candidate.text}\n${canonicalJson(candidate.json)}`;
    if (candidate.text.trim().length === 0 || seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(candidate);
  };

  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        visit(item, `${path}[${String(index)}]`);
      });
      return;
    }
    if (!isRecord(value)) {
      return;
    }

    const role = stringField(value, "role");
    if (role === "assistant" && Array.isArray(value.content)) {
      value.content.forEach((item, index) => {
        if (!isRecord(item) || stringField(item, "type") !== "tool-call") {
          return;
        }
        push({
          kind: "tool-call",
          role,
          path: `${path}.content[${String(index)}]`,
          text: cursorToolCallText(item),
          json: item,
        });
      });
      return;
    }

    if (role === "tool" && Array.isArray(value.content)) {
      value.content.forEach((item, index) => {
        if (!isRecord(item) || stringField(item, "type") !== "tool-result") {
          return;
        }
        push({
          kind: "tool-result",
          role,
          path: `${path}.content[${String(index)}]`,
          text: cursorToolResultText(item),
          json: item,
        });
      });
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      visit(child, `${path}.${key}`);
    }
  };

  values.forEach((value, index) => {
    visit(value, `$.body[${String(index)}]`);
  });

  return candidates;
}

function cursorToolCallText(value: Record<string, unknown>): string {
  const toolName = stringField(value, "toolName") ?? stringField(value, "name") ?? "tool";
  const args = value.args;
  return args === undefined ? toolName : `${toolName} ${truncateText(canonicalJson(args), 4_000)}`;
}

function cursorToolResultText(value: Record<string, unknown>): string {
  const result = stringField(value, "result") ?? textFromUnknown(value.experimental_content);
  if (result !== undefined && result.trim().length > 0) {
    return result;
  }
  return stringField(value, "toolName") ?? stringField(value, "name") ?? "tool result";
}

function collectMessageText(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!isRecord(item)) {
      continue;
    }
    const type = stringField(item, "type");
    if (type !== undefined && type !== "text") {
      continue;
    }
    const text = stringField(item, "text");
    if (text !== undefined) {
      parts.push(text);
    }
  }
  return parts;
}

function hasSemanticRequestBlockForRoot(paths: ReadonlySet<string>, rootPath: string): boolean {
  for (const path of paths) {
    if (path === rootPath || path.startsWith(`${rootPath}.`) || path.startsWith(`${rootPath}[`)) {
      return true;
    }
  }
  return false;
}

function findLastUserMessageIndex(messages: readonly Record<string, unknown>[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = stringField(messages[index], "role") ?? stringField(messages[index], "speaker") ?? stringField(messages[index], "type");
    if (role === "user" || role === "human") {
      return index;
    }
  }
  return -1;
}

function parseCapturedBody(event: {
  readonly direction?: string | undefined;
  readonly headers?: readonly (readonly [string, string])[] | undefined;
  readonly body_text?: string | undefined;
  readonly body_b64?: string | undefined;
}): ParsedBody {
  const text = event.body_text ?? decodeBase64Utf8(event.body_b64);
  if (text !== undefined) {
    const json = parseJson(text);
    if (json.ok) {
      return { text, json: json.value, jsonLines: [] };
    }
    const jsonLines = parseJsonLinesOrSse(text);
    if (jsonLines.length > 0) {
      return { text, jsonLines };
    }
    if (!isUsefulBodyText(text)) {
      const framed = parseConnectEnvelope(event.body_b64, event.direction);
      if (framed !== undefined) {
        return framed;
      }
      const proto = parseRawProtoBody(event.body_b64);
      if (proto !== undefined) {
        return proto;
      }
      return { jsonLines: [] };
    }
    return { text, jsonLines };
  }

  const framed = parseConnectEnvelope(event.body_b64, event.direction);
  if (framed !== undefined) {
    return framed;
  }
  const proto = parseRawProtoBody(event.body_b64);
  if (proto !== undefined) {
    return proto;
  }
  const binaryText = extractUsefulPrintableStrings(event.body_b64);
  return { binaryText, jsonLines: [] };
}

function parseJson(text: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function parseJsonLinesOrSse(text: string): unknown[] {
  const values: unknown[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line === "[DONE]") {
      continue;
    }
    const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
    if (payload.length === 0 || payload === "[DONE]") {
      continue;
    }
    const parsed = parseJson(payload);
    if (parsed.ok) {
      values.push(parsed.value);
    }
  }
  return values;
}

function parseConnectEnvelope(value: string | undefined, direction: string | undefined): ParsedBody | undefined {
  if (value === undefined) {
    return undefined;
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(value, "base64");
  } catch {
    return undefined;
  }
  if (buffer.length < 5) {
    return undefined;
  }

  const frames: ParsedConnectFrame[] = [];
  let modelText: string | undefined;
  let offset = 0;
  let index = 0;
  while (offset + 5 <= buffer.length) {
    const frameOffset = offset;
    const flags = buffer[offset] ?? 0;
    const length = buffer.readUInt32BE(offset + 1);
    offset += 5;
    if (length < 0 || offset + length > buffer.length) {
      return undefined;
    }
    const compressed = (flags & 1) === 1;
    const payload = decodeConnectPayload(buffer.subarray(offset, offset + length), compressed);
    offset += length;
    const proto = decodeProtoMessage(payload, `$frame[${String(index)}]`);
    const text = decodePayloadText(payload);
    const textJsonValues = text === undefined ? [] : extractJsonValues(text);
    const protoJsonValues = proto === undefined ? [] : collectProtoJsonValues(proto);
    const jsonValues = uniqueJsonValues([...textJsonValues, ...protoJsonValues]);
    if (text !== undefined && modelText === undefined) {
      modelText = modelIdFromText(text);
    }
    if (proto !== undefined && modelText === undefined) {
      modelText = collectProtoTextFields(proto).find((field) => modelIdFromText(field.text) !== undefined)?.text;
    }
    const usefulText = joinOptionalText([
      text === undefined ? undefined : cursorSemanticTextFromDecoded(text, direction),
      proto === undefined ? undefined : cursorSemanticTextFromProto(proto, direction),
    ]);
    const frameEnd = offset;
    const frameBytes = buffer.subarray(frameOffset, frameEnd);
    frames.push({
      index,
      compressed,
      offset: frameOffset,
      frameByteLength: frameBytes.length,
      byteLength: payload.length,
      frameB64: frameBytes.toString("base64"),
      payloadB64: payload.toString("base64"),
      payloadSha256: sha256Buffer(payload),
      jsonValues,
      ...(usefulText === undefined ? {} : { text: usefulText }),
      ...(proto === undefined ? {} : { proto }),
    });
    index += 1;
  }

  if (offset !== buffer.length || frames.length === 0) {
    return undefined;
  }

  const jsonLines = frames.flatMap((frame) => frame.jsonValues);
  const binaryTextParts = uniqueStrings(frames.map((frame) => frame.text).filter((text): text is string => text !== undefined));
  return {
    jsonLines,
    ...(binaryTextParts.length === 0 ? {} : { binaryText: joinTextParts(binaryTextParts) }),
    ...(modelText === undefined ? {} : { modelText }),
    connectFrames: frames,
  };
}

function parseRawProtoBody(value: string | undefined): ParsedBody | undefined {
  if (value === undefined) {
    return undefined;
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(value, "base64");
  } catch {
    return undefined;
  }
  const proto = decodeProtoMessage(buffer, "$protobuf");
  if (proto === undefined) {
    return undefined;
  }
  const jsonLines = collectProtoJsonValues(proto);
  const modelText = collectProtoTextFields(proto).find((field) => modelIdFromText(field.text) !== undefined)?.text;
  const binaryTextParts = uniqueStrings(collectProtoTextFields(proto)
    .map((field) => field.text)
    .filter(isUsefulCursorSemanticText));
  return {
    jsonLines,
    ...(binaryTextParts.length === 0 ? {} : { binaryText: joinTextParts(binaryTextParts) }),
    ...(modelText === undefined ? {} : { modelText }),
    proto,
  };
}

function collectProtoJsonValues(message: DecodedProtoMessage): unknown[] {
  const values: unknown[] = [];
  for (const field of collectProtoTextFields(message)) {
    const trimmed = field.text.trim();
    const parsed = trimmed.startsWith("{") ? parseJson(trimmed) : { ok: false as const };
    if (parsed.ok) {
      values.push(parsed.value);
      continue;
    }
    if (/^data:\s*[{[]/m.test(trimmed)) {
      values.push(...parseJsonLinesOrSse(trimmed));
    }
  }
  return values;
}

function collectProtoTextFields(message: DecodedProtoMessage): { readonly path: string; readonly text: string }[] {
  const fields: { readonly path: string; readonly text: string }[] = [];
  const visit = (candidate: DecodedProtoMessage): void => {
    for (const field of candidate.fields) {
      if (field.text !== undefined) {
        fields.push({ path: field.path, text: field.text });
      }
      if (field.nested !== undefined) {
        visit(field.nested);
      }
      if (field.hexDecoded !== undefined) {
        visit(field.hexDecoded);
      }
    }
  };
  visit(message);
  return fields;
}

function decodeProtoMessage(buffer: Buffer, path: string, depth = 0): DecodedProtoMessage | undefined {
  if (buffer.length === 0 || depth > 8) {
    return undefined;
  }

  const fields: DecodedProtoField[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const key = readProtoVarint(buffer, offset);
    if (key === undefined || key.value === 0n || key.value > BigInt(Number.MAX_SAFE_INTEGER)) {
      return undefined;
    }
    offset = key.nextOffset;
    const keyNumber = Number(key.value);
    const fieldNumber = Math.floor(keyNumber / 8);
    const wireType = keyNumber % 8;
    if (fieldNumber <= 0) {
      return undefined;
    }
    const fieldPath = `${path}.${String(fieldNumber)}`;

    if (wireType === 0) {
      const value = readProtoVarint(buffer, offset);
      if (value === undefined) {
        return undefined;
      }
      offset = value.nextOffset;
      fields.push({
        path: fieldPath,
        fieldNumber,
        wireType,
        value: protoNumber(value.value),
      });
    } else if (wireType === 1) {
      if (offset + 8 > buffer.length) {
        return undefined;
      }
      const value = buffer.readBigUInt64LE(offset);
      offset += 8;
      fields.push({
        path: fieldPath,
        fieldNumber,
        wireType,
        value: protoNumber(value),
        byteLength: 8,
      });
    } else if (wireType === 2) {
      const length = readProtoVarint(buffer, offset);
      if (length === undefined || length.value > BigInt(Number.MAX_SAFE_INTEGER)) {
        return undefined;
      }
      offset = length.nextOffset;
      const byteLength = Number(length.value);
      if (byteLength < 0 || offset + byteLength > buffer.length) {
        return undefined;
      }
      const bytes = buffer.subarray(offset, offset + byteLength);
      offset += byteLength;
      const text = protoString(bytes);
      const nested = decodeProtoMessage(bytes, fieldPath, depth + 1);
      const hexBytes = protoHexBytes(bytes);
      const hexDecoded = hexBytes === undefined ? undefined : decodeProtoMessage(hexBytes, `${fieldPath}[hex]`, depth + 1);
      const packedVarints = decodePackedProtoVarints(bytes);
      fields.push({
        path: fieldPath,
        fieldNumber,
        wireType,
        byteLength,
        ...(text === undefined ? {} : { text }),
        ...(packedVarints === undefined ? {} : { packedVarints }),
        ...(nested === undefined ? {} : { nested }),
        ...(hexDecoded === undefined || hexBytes === undefined ? {} : {
          hexDecoded,
          hexByteLength: hexBytes.length,
          hexSha256: sha256Buffer(hexBytes),
        }),
      });
    } else if (wireType === 5) {
      if (offset + 4 > buffer.length) {
        return undefined;
      }
      const value = buffer.readUInt32LE(offset);
      offset += 4;
      fields.push({
        path: fieldPath,
        fieldNumber,
        wireType,
        value,
        byteLength: 4,
      });
    } else {
      return undefined;
    }

    if (fields.length > 2_000) {
      return undefined;
    }
  }

  return fields.length === 0 ? undefined : {
    path,
    byteLength: buffer.length,
    fields,
  };
}

function readProtoVarint(buffer: Buffer, offset: number): VarintRead | undefined {
  let result = 0n;
  let shift = 0n;
  for (let index = 0; index < 10 && offset + index < buffer.length; index += 1) {
    const byte = buffer[offset + index];
    if (byte === undefined) {
      return undefined;
    }
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return {
        value: result,
        nextOffset: offset + index + 1,
      };
    }
    shift += 7n;
  }
  return undefined;
}

function protoNumber(value: bigint): number | string {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function protoString(buffer: Buffer): string | undefined {
  if (buffer.length === 0 || buffer.length > 128_000) {
    return undefined;
  }
  const text = buffer.toString("utf8");
  if (text.includes("\uFFFD")) {
    return undefined;
  }
  const controlCount = Array.from(text).filter((char) => {
    const code = char.charCodeAt(0);
    return code < 32 && char !== "\n" && char !== "\r" && char !== "\t";
  }).length;
  if (controlCount > Math.max(1, text.length * 0.05)) {
    return undefined;
  }
  return text.length === 0 ? undefined : text;
}

function protoHexBytes(buffer: Buffer): Buffer | undefined {
  if (buffer.length < 16 || buffer.length % 2 !== 0) {
    return undefined;
  }
  for (const byte of buffer) {
    const isDigit = byte >= 0x30 && byte <= 0x39;
    const isLowerHex = byte >= 0x61 && byte <= 0x66;
    const isUpperHex = byte >= 0x41 && byte <= 0x46;
    if (!isDigit && !isLowerHex && !isUpperHex) {
      return undefined;
    }
  }
  return Buffer.from(buffer.toString("ascii"), "hex");
}

function decodePackedProtoVarints(buffer: Buffer): number[] | undefined {
  if (buffer.length === 0 || buffer.length > 10_000) {
    return undefined;
  }
  const values: number[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const value = readProtoVarint(buffer, offset);
    if (value === undefined || value.value > BigInt(Number.MAX_SAFE_INTEGER)) {
      return undefined;
    }
    values.push(Number(value.value));
    offset = value.nextOffset;
  }
  return values.length === 0 ? undefined : values;
}

function decodeConnectPayload(payload: Buffer, compressed: boolean): Buffer {
  if (!compressed && !isGzip(payload)) {
    return payload;
  }
  try {
    return gunzipSync(payload);
  } catch {
    return payload;
  }
}

function isGzip(payload: Buffer): boolean {
  return payload.length >= 2 && payload[0] === 0x1f && payload[1] === 0x8b;
}

function decodePayloadText(payload: Buffer): string | undefined {
  const text = payload.toString("utf8");
  if (!text.includes("\uFFFD")) {
    return text;
  }
  return undefined;
}

function uniqueJsonValues(values: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  const unique: unknown[] = [];
  for (const value of values) {
    const key = canonicalJson(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(value);
  }
  return unique;
}

function extractJsonValues(text: string): unknown[] {
  const values: unknown[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{") {
      continue;
    }
    const end = jsonObjectEnd(text, index);
    if (end === undefined) {
      continue;
    }
    const parsed = parseJson(text.slice(index, end + 1));
    if (parsed.ok) {
      values.push(parsed.value);
      index = end;
    }
  }

  return values;
}

function jsonObjectEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char !== "}" || depth === 0) {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return index;
    }
  }

  return undefined;
}

function structuredValues(body: ParsedBody): unknown[] {
  if (body.json !== undefined) {
    return [body.json];
  }
  const framedJson = body.connectFrames?.flatMap((frame) => frame.jsonValues) ?? [];
  return [...body.jsonLines, ...framedJson];
}

function streamEvents(callId: string, observedAt: number, body: ParsedBody): StreamEvent[] {
  const events = body.jsonLines.map((payload, index) => ({
    id: stableId("stream", callId, String(index)),
    call_id: callId,
    ordinal: index,
    event_type: cursorStreamEventType(payload),
    headers: {},
    payload,
    observed_at: observedAt,
    ...(textFromUnknown(payload) === undefined ? {} : { payload_text: truncateText(textFromUnknown(payload) ?? "", 4_000) }),
    payload_sha256: hashUnknown(payload),
  }));

  let ordinal = events.length;
  for (const frame of body.connectFrames ?? []) {
    const payload = connectFramePayload(frame);
    events.push({
      id: stableId("stream", callId, "connect-frame", String(frame.index)),
      call_id: callId,
      ordinal,
      event_type: frame.proto === undefined ? "connect-frame" : "connect-protobuf-frame",
      headers: {},
      payload,
      observed_at: observedAt,
      payload_text: truncateText(canonicalJson(payload), 4_000),
      payload_sha256: hashUnknown(payload),
    });
    ordinal += 1;
  }

  return events;
}

function connectFramePayload(frame: ParsedConnectFrame): unknown {
  const protoSources = frame.proto === undefined ? [] : [{ source: "connect-frame" as const, message: frame.proto, frameIndex: frame.index }];
  return {
    format: "connect",
    frameIndex: frame.index,
    compressed: frame.compressed,
    offset: frame.offset,
    frameByteLength: frame.frameByteLength,
    payloadByteLength: frame.byteLength,
    frameB64: frame.frameB64,
    payloadB64: frame.payloadB64,
    payloadSha256: frame.payloadSha256,
    ...(frame.text === undefined ? {} : { text: truncateText(frame.text, 4_000) }),
    ...(frame.jsonValues.length === 0 ? {} : { jsonValues: frame.jsonValues }),
    ...(frame.proto === undefined ? {} : { protobuf: protoPayload(frame.proto) }),
    ...(frame.proto === undefined ? {} : optionalCursorWireUsage(frame.proto)),
    ...(protoSources.length === 0 ? {} : optionalCursorToolCapabilities(protoSources)),
  };
}

function optionalCursorWireUsage(message: DecodedProtoMessage): { readonly cursorUsage: readonly CursorWireUsageCandidate[] } | Record<string, never> {
  const usage = collectCursorWireUsageCandidates(message);
  return usage.length === 0 ? {} : { cursorUsage: usage };
}

function optionalCursorToolCapabilities(sources: readonly ProtoSource[]): { readonly cursorToolCapabilities: readonly CursorToolCapability[] } | Record<string, never> {
  const capabilities = collectCursorToolCapabilities(sources);
  return capabilities.length === 0 ? {} : { cursorToolCapabilities: capabilities };
}

function protoPayload(message: DecodedProtoMessage): unknown {
  return {
    format: "protobuf",
    path: message.path,
    byteLength: message.byteLength,
    fields: message.fields.map((field) => ({
      path: field.path,
      fieldNumber: field.fieldNumber,
      wireType: field.wireType,
      ...(field.value === undefined ? {} : { value: field.value }),
      ...(field.text === undefined ? {} : { text: truncateText(field.text, 1_000) }),
      ...(field.packedVarints === undefined ? {} : { packedVarints: field.packedVarints }),
      ...(field.byteLength === undefined ? {} : { byteLength: field.byteLength }),
      ...(field.nested === undefined ? {} : { nested: protoPayload(field.nested) }),
      ...(field.hexDecoded === undefined ? {} : {
        hexDecoded: protoPayload(field.hexDecoded),
        hexByteLength: field.hexByteLength,
        hexSha256: field.hexSha256,
      }),
    })),
  };
}

function cursorStreamEventType(payload: unknown): string {
  const explicit = stringField(payload, "type") ?? stringField(payload, "event");
  if (explicit !== undefined) {
    return explicit;
  }
  const role = stringField(payload, "role");
  if (role !== undefined) {
    return role;
  }
  return "line";
}

function usageRecords(
  callId: string,
  values: readonly unknown[],
  frames: readonly ParsedConnectFrame[],
): UsageRecord[] {
  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  const pushUsage = (usage: Record<string, unknown>): void => {
    const key = canonicalJson(usage);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const record = usageRecordFromUsage(callId, records.length, usage);
    if (record !== undefined) {
      records.push(record);
    }
  };

  for (const value of values) {
    for (const usage of collectUsageObjects(value)) {
      pushUsage(usage);
    }
  }
  for (const usage of collectProtoUsageObjects(frames)) {
    pushUsage(usage);
  }
  return records;
}

function collectProtoUsageObjects(frames: readonly ParsedConnectFrame[]): Record<string, unknown>[] {
  const usage: Record<string, unknown>[] = [];
  for (const frame of frames) {
    if (frame.proto === undefined) {
      continue;
    }
    for (const candidate of collectCursorWireUsageCandidates(frame.proto)) {
      usage.push({
        inputTokens: candidate.inputTokens,
        outputTokens: candidate.outputTokens,
        cacheReadTokens: candidate.cacheReadTokens,
        cacheWriteTokens: candidate.cacheWriteTokens,
        totalTokens: sumNumbers([candidate.inputTokens, candidate.outputTokens, candidate.cacheReadTokens, candidate.cacheWriteTokens]),
        raw_protobuf: {
          frameIndex: frame.index,
          path: candidate.path,
          wireInputTokens: candidate.wireInputTokens,
          fieldNumbers: {
            wireInputTokens: 1,
            outputTokens: 2,
            cacheReadTokens: 3,
            cacheWriteTokens: 4,
          },
        },
      });
    }
  }
  return usage;
}

function collectCursorWireUsageCandidates(message: DecodedProtoMessage): CursorWireUsageCandidate[] {
  const candidates: CursorWireUsageCandidate[] = [];

  const direct = cursorWireUsageCandidate(message);
  if (direct !== undefined) {
    candidates.push(direct);
  }
  for (const field of message.fields) {
    for (const child of nestedProtoMessagesFromField(field)) {
      candidates.push(...collectCursorWireUsageCandidates(child));
    }
  }
  return candidates;
}

function cursorWireUsageCandidate(message: DecodedProtoMessage): CursorWireUsageCandidate | undefined {
  if (!message.path.endsWith(".1.14")) {
    return undefined;
  }

  const values = new Map<number, number>();
  let scalarNumericFieldCount = 0;
  for (const field of message.fields) {
    if (field.wireType !== 0 || typeof field.value !== "number" || !Number.isInteger(field.value)) {
      continue;
    }
    scalarNumericFieldCount += 1;
    if (!values.has(field.fieldNumber)) {
      values.set(field.fieldNumber, field.value);
    }
  }

  const wireInputTokens = values.get(1);
  const outputTokens = values.get(2);
  const cacheReadTokens = values.get(3) ?? 0;
  const cacheWriteTokens = values.get(4) ?? 0;
  if (
    !plausibleTokenCount(wireInputTokens)
    || !plausibleTokenCount(outputTokens)
    || !plausibleTokenCount(cacheReadTokens)
    || !plausibleTokenCount(cacheWriteTokens)
    || scalarNumericFieldCount > 4
    || wireInputTokens < cacheReadTokens + cacheWriteTokens
  ) {
    return undefined;
  }
  if (wireInputTokens === 0 && outputTokens === 0) {
    return undefined;
  }

  return {
    path: message.path,
    inputTokens: wireInputTokens - cacheReadTokens - cacheWriteTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    wireInputTokens,
  };
}

function plausibleTokenCount(value: number | undefined): value is number {
  return value !== undefined
    && Number.isInteger(value)
    && value >= 0
    && value <= 100_000_000;
}

function collectUsageObjects(value: unknown): Record<string, unknown>[] {
  const usage: Record<string, unknown>[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!isRecord(candidate)) {
      return;
    }
    if (hasUsageFields(candidate)) {
      usage.push(candidate);
    }
    for (const [key, child] of Object.entries(candidate)) {
      if (key.toLowerCase().includes("usage") && isRecord(child) && hasUsageFields(child)) {
        usage.push(child);
      }
      if (Array.isArray(child) || isRecord(child)) {
        visit(child);
      }
    }
  };
  visit(value);
  return usage;
}

function hasUsageFields(value: Record<string, unknown>): boolean {
  return firstNumber(value, [
    "inputTokens",
    "input_tokens",
    "promptTokens",
    "prompt_tokens",
    "outputTokens",
    "output_tokens",
    "completionTokens",
    "completion_tokens",
    "totalTokens",
    "total_tokens",
  ]) !== undefined;
}

function usageRecordFromUsage(callId: string, index: number, usage: Record<string, unknown>): UsageRecord | undefined {
  const inputTokens = firstNumber(usage, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"]);
  const outputTokens = firstNumber(usage, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"]);
  const cacheReadTokens = firstNumber(usage, ["cacheReadTokens", "cacheReadInputTokens", "cachedInputTokens", "cache_read_tokens", "cache_read_input_tokens"]);
  const cacheWriteTokens = firstNumber(usage, ["cacheWriteTokens", "cacheWriteInputTokens", "cacheCreationInputTokens", "cache_write_tokens", "cache_creation_input_tokens"]);
  const totalTokens = firstNumber(usage, ["totalTokens", "total_tokens"])
    ?? sumNumbers([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens]);
  if ([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens].every((value) => value === undefined)) {
    return undefined;
  }
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

function cursorModelId(existing: string | undefined, body: Pick<ParsedBody, "json" | "jsonLines"> & Partial<Pick<ParsedBody, "text" | "binaryText" | "modelText" | "connectFrames" | "proto">>): string | undefined {
  if (existing !== undefined && existing !== "cursor" && existing !== "unknown") {
    return existing;
  }
  for (const value of structuredValues({ ...body, text: undefined })) {
    const model = firstStringDeep(value, ["model", "model_id", "modelName", "modelDisplayName", "selectedModel"]);
    if (model !== undefined) {
      return model;
    }
  }
  if (body.proto !== undefined) {
    const model = collectCursorProtoModels([{ source: "raw-protobuf", message: body.proto }])[0]?.model;
    if (model !== undefined) {
      return model;
    }
  }
  return modelIdFromText(body.modelText) ?? modelIdFromText(body.text) ?? modelIdFromText(body.binaryText) ?? existing;
}

function modelIdFromText(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  return /\bcomposer-2\.5(?:-fast)?\b/i.exec(text)?.[0]
    ?? /\bComposer\s+2\.5(?:\s+Fast)?\b/i.exec(text)?.[0];
}

function firstStringDeep(value: unknown, keys: readonly string[]): string | undefined {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const visit = (candidate: unknown): string | undefined => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const found = visit(item);
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    }
    if (!isRecord(candidate)) {
      return undefined;
    }
    for (const [key, child] of Object.entries(candidate)) {
      if (wanted.has(key.toLowerCase()) && typeof child === "string" && child.length > 0) {
        return child;
      }
    }
    for (const child of Object.values(candidate)) {
      const found = visit(child);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };
  return visit(value);
}

function collectTextCandidates(value: unknown, rootPath = "$"): TextCandidate[] {
  const candidates: TextCandidate[] = [];
  const visit = (candidate: unknown, path: string, key: string): void => {
    if (typeof candidate === "string") {
      candidates.push({ path, key, text: candidate });
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => {
        visit(item, `${path}[${String(index)}]`, key);
      });
      return;
    }
    if (!isRecord(candidate)) {
      return;
    }
    for (const [childKey, child] of Object.entries(candidate)) {
      visit(child, `${path}.${childKey}`, childKey);
    }
  };
  visit(value, rootPath, "");
  return candidates;
}

function textFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const parts = value.map(textFromUnknown).filter((part): part is string => part !== undefined && part.length > 0);
    return parts.length === 0 ? undefined : parts.join("\n");
  }
  if (isRecord(value)) {
    const direct = firstString(value, ["text", "content", "message", "prompt", "value"]);
    if (direct !== undefined) {
      return direct;
    }
    return truncateText(canonicalJson(value), 8_000);
  }
  return undefined;
}

function capturedBodyHashMaterial(body: ParsedBody): unknown {
  if (body.json !== undefined) {
    return body.json;
  }
  if (body.jsonLines.length > 0) {
    return body.jsonLines;
  }
  if (body.proto !== undefined) {
    return protoPayload(body.proto);
  }
  if (body.connectFrames !== undefined) {
    return body.connectFrames.map((frame) => ({
      index: frame.index,
      payloadSha256: frame.payloadSha256,
    }));
  }
  return body.text ?? body.binaryText ?? "";
}

function decodeBase64Utf8(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const text = Buffer.from(value, "base64").toString("utf8");
    return text.includes("\uFFFD") ? undefined : text;
  } catch {
    return undefined;
  }
}

function extractUsefulPrintableStrings(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  let buffer: Buffer;
  try {
    buffer = Buffer.from(value, "base64");
  } catch {
    return undefined;
  }
  return usefulPrintableTextFromDecoded(buffer.toString("latin1"));
}

function usefulPrintableTextFromDecoded(text: string): string | undefined {
  const strings = text.match(/[ -~]{4,}/g) ?? [];
  const useful = strings
    .map((part) => part.trim())
    .filter((part) => isUsefulBodyText(part));
  return useful.length === 0 ? undefined : useful.join("\n");
}

function cursorSemanticTextFromDecoded(text: string, direction: string | undefined): string | undefined {
  const fieldText = extractJsonStringFields(text, ["text", "result"])
    .filter(isUsefulCursorSemanticText);
  if (fieldText.length > 0) {
    return uniqueStrings(fieldText).join("\n");
  }
  if (direction === "response") {
    return undefined;
  }
  if (/"role"\s*:\s*"(?:system|user|assistant)"/.test(text) || /<user_info>|<user_query>|<rules>|System prompt/.test(text)) {
    return undefined;
  }
  return usefulPrintableTextFromDecoded(text);
}

function cursorSemanticTextFromProto(message: DecodedProtoMessage, direction: string | undefined): string | undefined {
  const exactFieldText = collectProtoTextFields(message)
    .flatMap((field) => {
      const trimmed = field.text.trim();
      const direct = trimmed.startsWith("{") || /^data:\s*[{[]/m.test(trimmed)
        ? []
        : [field.text].filter(isUsefulCursorSemanticText);
      const jsonFields = extractJsonStringFields(field.text, ["text", "result"])
        .filter(isUsefulCursorSemanticText);
      return [...direct, ...jsonFields];
    });
  if (exactFieldText.length > 0) {
    return uniqueStrings(exactFieldText).join("\n");
  }
  if (direction === "response") {
    return undefined;
  }
  return undefined;
}

function joinOptionalText(values: readonly (string | undefined)[]): string | undefined {
  const parts = uniqueStrings(values
    .filter((value): value is string => value !== undefined)
    .map((value) => value.trim())
    .filter((value) => value.length > 0));
  return parts.length === 0 ? undefined : parts.join("\n");
}

function extractJsonStringFields(text: string, keys: readonly string[]): string[] {
  const keyPattern = keys.map(escapeRegExp).join("|");
  const pattern = new RegExp(`"(?:${keyPattern})"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "g");
  const values: string[] = [];
  for (const match of text.matchAll(pattern)) {
    const raw = match[1];
    if (raw === undefined) {
      continue;
    }
    const parsed = parseJson(`"${raw}"`);
    if (parsed.ok && typeof parsed.value === "string") {
      values.push(parsed.value);
    }
  }
  return values;
}

function isUsefulCursorSemanticText(text: string): boolean {
  const trimmed = text.trim();
  return isUsefulBodyText(trimmed)
    && !trimmed.includes("<user_query>")
    && !trimmed.includes("<user_info>")
    && !trimmed.includes("<rules>")
    && !trimmed.startsWith("You are an AI coding assistant")
    && !/^(System prompt|Tool definitions|Rules|Skills|MCP|Subagent definitions|Summarized conversation|Conversation)$/.test(trimmed);
}

function isUsefulBodyText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 4) {
    return false;
  }
  const controlCount = Array.from(trimmed).filter((char) => {
    const code = char.charCodeAt(0);
    return code < 32 && char !== "\n" && char !== "\r" && char !== "\t";
  }).length;
  if (controlCount > Math.max(2, trimmed.length * 0.02)) {
    return false;
  }
  if (/^[0-9a-f-]{16,}$/i.test(trimmed)) {
    return false;
  }
  if (/^[A-Za-z0-9_-]{32,}$/.test(trimmed)) {
    return false;
  }
  return /[A-Za-z]{3,}/.test(trimmed) && /\s|[.!?:"']|RCSPY/.test(trimmed);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    unique.push(value);
  }
  return unique;
}

function createBlock(input: BlockInput): NormalizedBlock {
  const material = input.text ?? (input.json === undefined ? "" : canonicalJson(input.json));
  const charSize = input.charSize ?? material.length;
  const byteSize = input.byteSize ?? Buffer.byteLength(material, "utf8");
  return {
    id: stableId("block", input.callId, input.direction, String(input.ordinal)),
    call_id: input.callId,
    direction: input.direction,
    ordinal: input.ordinal,
    kind: input.kind,
    source: input.source,
    char_size: charSize,
    byte_size: byteSize,
    content_hash: sha256(material),
    cache_marker: false,
    ...(input.role === undefined ? {} : { role: input.role }),
    ...(input.providerPath === undefined ? {} : { provider_path: input.providerPath }),
    ...(input.text === undefined ? {} : { text: input.text }),
    ...(input.json === undefined ? {} : { json: input.json }),
  };
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
    ...(event.body_text === undefined ? {} : { body_text: event.body_text }),
    ...(event.body_b64 === undefined ? {} : { body_b64: event.body_b64 }),
    ...(event.body_sha256 === undefined ? {} : { body_sha256: event.body_sha256 }),
    ...(event.body_encoding === undefined ? {} : { body_encoding: event.body_encoding }),
  };
}

function headerValue(headers: readonly (readonly [string, string])[], name: string): string | undefined {
  const lowerName = name.toLowerCase();
  return headers.find(([key]) => key.toLowerCase() === lowerName)?.[1];
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const child = value[key];
  return typeof child === "string" ? child : undefined;
}

function firstString(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const child = value[key];
    if (typeof child === "string" && child.length > 0) {
      return child;
    }
  }
  return undefined;
}

function firstNumber(value: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const child = value[key];
    if (typeof child === "number" && Number.isFinite(child)) {
      return child;
    }
  }
  return undefined;
}

function optionalIntegerField<K extends string>(key: K, value: number | undefined): Record<K, number> | Record<string, never> {
  return value === undefined ? {} : { [key]: Math.trunc(value) } as Record<K, number>;
}

function sumNumbers(values: readonly (number | undefined)[]): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0 ? undefined : present.reduce((total, value) => total + value, 0);
}

function joinTextParts(parts: readonly string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join("\n");
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hashUnknown(value: unknown): string {
  return sha256(canonicalJson(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Buffer(value: Buffer): string {
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
    return Number.isFinite(value) ? JSON.stringify(value) : "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return "null";
}
