import { createHash } from "node:crypto";
import type { NormalizedBlock } from "./schemas.ts";
import type {
  SpyTokenCountRecord,
  SpyTokenCountSubject,
} from "./api-contracts.ts";

export interface TokenRecordBase {
  readonly subjectType: SpyTokenCountRecord["subjectType"];
  readonly callId?: string | undefined;
  readonly blockId?: string | undefined;
  readonly direction?: NormalizedBlock["direction"] | undefined;
  readonly kind?: NormalizedBlock["kind"] | undefined;
  readonly label?: string | undefined;
  readonly sourceHash: string;
  readonly modelId: string;
  readonly countedAt: number;
}

export function textForTokenCounting(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return stableJson(value);
}

export function textForBlock(block: NormalizedBlock): string {
  if (block.text !== undefined) {
    return block.text;
  }
  if (block.json !== undefined) {
    return stableJson(block.json);
  }
  return "";
}

export function textForBlocks(blocks: readonly NormalizedBlock[]): string {
  return blocks
    .map(textForBlock)
    .filter((text) => text.length > 0)
    .join("\n\n");
}

export function tokenSourceHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function tokenCacheKey(base: Omit<TokenRecordBase, "countedAt">): string {
  return [
    base.subjectType,
    base.callId ?? "",
    base.direction ?? "",
    base.blockId ?? "",
    base.kind ?? "",
    base.sourceHash,
    base.modelId,
  ].join(":");
}

export function unavailableTokenRecord(base: TokenRecordBase, error: string): SpyTokenCountRecord {
  return {
    ...base,
    tokens: null,
    provenance: "unavailable",
    error,
  };
}

export function tokenSubjectCacheKey(subject: SpyTokenCountSubject, sourceHash: string, modelId: string): string {
  if (subject.type === "call") {
    return tokenCacheKey({
      subjectType: "call",
      callId: subject.callId,
      direction: subject.direction,
      sourceHash,
      modelId,
    });
  }
  if (subject.type === "section") {
    return tokenCacheKey({
      subjectType: "section",
      callId: subject.callId,
      direction: subject.direction,
      kind: subject.kind,
      sourceHash,
      modelId,
    });
  }
  if (subject.type === "block") {
    return tokenCacheKey({
      subjectType: "block",
      callId: subject.callId,
      blockId: subject.blockId,
      sourceHash,
      modelId,
    });
  }
  return tokenCacheKey({
    subjectType: "selection",
    callId: subject.callId,
    sourceHash,
    modelId,
  });
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortJson(entryValue)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}
