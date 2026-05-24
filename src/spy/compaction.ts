import type {
  SpyCallSummary,
  SpyCompactionAssessment,
  SpyCompactionConfidence,
  SpyCompactionReason,
} from "./api-contracts.ts";
import type { NormalizedBlock } from "./schemas.ts";

const MIN_HISTORY_BYTES_FOR_DROP = 2_048;
const MIN_REQUEST_BYTES_FOR_DROP = 8_192;
const MIN_INPUT_TOKENS_FOR_DROP = 2_000;
const MIN_LARGE_SUMMARIZATION_INPUT_BYTES = 16_384;
const HISTORY_BYTE_DROP_RATIO = 0.55;
const REQUEST_BYTE_DROP_RATIO = 0.75;
const INPUT_TOKEN_DROP_RATIO = 0.75;
const HISTORY_BLOCK_DROP_RATIO = 0.4;
const SUMMARY_LIKE_HISTORY_PATTERN = /\b(summary|summarized|summarised|condensed|compacted|compressed|conversation so far|context summary|previous context|prior conversation|earlier conversation)\b/i;
const SUMMARIZATION_SYSTEM_PATTERN = /\b(context summarization assistant|structured summary|summari[sz]e the conversation|read a conversation between a user and an AI coding assistant|do not continue the conversation)\b/i;
const CONVERSATION_WRAPPER_PATTERN = /<conversation>[\s\S]*<\/conversation>|\[User\]:[\s\S]*\[Assistant\]:/i;

export interface RequestTransitionInput {
  readonly summary: SpyCallSummary;
  readonly requestBlocks: readonly NormalizedBlock[];
  readonly previousSummary: SpyCallSummary | null;
  readonly previousRequestBlocks: readonly NormalizedBlock[];
}

export function detectCompaction(input: RequestTransitionInput): SpyCompactionAssessment {
  const currentHistoryBlocks = historyBlocks(input.requestBlocks);
  const previousHistoryBlocks = historyBlocks(input.previousRequestBlocks);
  const summaryLikeBlockIds = currentHistoryBlocks
    .filter((block) => SUMMARY_LIKE_HISTORY_PATTERN.test(block.text ?? ""))
    .map((block) => block.id);
  const historyDiff = classifyHistoryBlocks(currentHistoryBlocks, previousHistoryBlocks);
  const contextStability = stableContext(input.requestBlocks, input.previousRequestBlocks);
  const summarizationRequest = detectSummarizationRequest(input.requestBlocks);

  const evidence = {
    currentCallId: input.summary.call.id,
    previousCallId: input.previousSummary?.call.id ?? null,
    currentRequestByteSize: input.summary.requestByteSize,
    previousRequestByteSize: input.previousSummary?.requestByteSize ?? null,
    currentInputTokens: input.summary.usage.inputTokens,
    previousInputTokens: input.previousSummary?.usage.inputTokens ?? null,
    currentContextTokens: contextTokens(input.summary),
    previousContextTokens: input.previousSummary === null ? null : contextTokens(input.previousSummary),
    currentPriorHistoryByteSize: byteSize(currentHistoryBlocks),
    previousPriorHistoryByteSize: input.previousSummary === null ? null : byteSize(previousHistoryBlocks),
    currentPriorHistoryBlockCount: currentHistoryBlocks.length,
    previousPriorHistoryBlockCount: input.previousSummary === null ? null : previousHistoryBlocks.length,
    summaryLikeBlockIds,
    newHistoryBlockIds: historyDiff.newBlockIds,
    changedHistoryBlockIds: historyDiff.changedBlockIds,
    repeatedContextBlockCount: contextStability.repeatedBlockCount,
    changedContextBlockCount: contextStability.changedBlockCount,
  };

  if (summarizationRequest.isCandidate) {
    return {
      status: "candidate",
      source: "summarization_request",
      confidence: summarizationRequest.largeCurrentInput ? "high" : "medium",
      label: "Compaction summarization request",
      reasons: summarizationRequest.reasons,
      evidence,
    };
  }

  if (input.previousSummary === null) {
    return {
      status: "none",
      source: "none",
      confidence: "none",
      label: "No compaction candidate",
      reasons: ["no_previous_comparable_call"],
      evidence,
    };
  }

  const reasons: SpyCompactionReason[] = [];
  const piProfile = isPiRequestContext(input);
  const stable = contextStability.repeatedBlockCount + contextStability.changedBlockCount > 0;
  const currentInputExists = input.requestBlocks.some((block) => block.kind === "current-user-input");
  const historyByteDrop = evidence.previousPriorHistoryByteSize !== null
    && evidence.previousPriorHistoryByteSize >= MIN_HISTORY_BYTES_FOR_DROP
    && evidence.currentPriorHistoryByteSize <= evidence.previousPriorHistoryByteSize * HISTORY_BYTE_DROP_RATIO;
  const historyBlockDrop = evidence.previousPriorHistoryBlockCount !== null
    && evidence.previousPriorHistoryBlockCount >= 4
    && evidence.currentPriorHistoryBlockCount <= Math.max(1, Math.floor(evidence.previousPriorHistoryBlockCount * HISTORY_BLOCK_DROP_RATIO));
  const requestByteDrop = evidence.previousRequestByteSize !== null
    && evidence.previousRequestByteSize >= MIN_REQUEST_BYTES_FOR_DROP
    && evidence.currentRequestByteSize <= evidence.previousRequestByteSize * REQUEST_BYTE_DROP_RATIO;
  const inputTokenDrop = evidence.currentContextTokens !== null
    && evidence.previousContextTokens !== null
    && evidence.previousContextTokens >= MIN_INPUT_TOKENS_FOR_DROP
    && evidence.currentContextTokens <= evidence.previousContextTokens * INPUT_TOKEN_DROP_RATIO;
  const summaryLikeHistory = summaryLikeBlockIds.length > 0;

  if (piProfile) {
    reasons.push("pi_request_context_profile");
  }
  if (stable) {
    reasons.push("stable_request_context");
  }
  if (summaryLikeHistory) {
    reasons.push("summary_like_history_block");
  }
  if (historyByteDrop) {
    reasons.push("prior_history_byte_drop");
  }
  if (historyBlockDrop) {
    reasons.push("prior_history_block_drop");
  }
  if (requestByteDrop) {
    reasons.push("request_byte_drop");
  }
  if (inputTokenDrop) {
    reasons.push("input_token_drop");
  }

  const hasPriorHistory = evidence.currentPriorHistoryBlockCount > 0 && evidence.previousPriorHistoryBlockCount !== null && evidence.previousPriorHistoryBlockCount > 0;
  const piCandidate = piProfile && stable && currentInputExists && hasPriorHistory && (
    (summaryLikeHistory && (historyByteDrop || requestByteDrop || inputTokenDrop))
      || (historyByteDrop && (historyBlockDrop || requestByteDrop || inputTokenDrop))
  );
  const heuristicCandidate = !piCandidate && stable && currentInputExists && hasPriorHistory && (
    (summaryLikeHistory && historyByteDrop)
      || (historyByteDrop && historyBlockDrop && (requestByteDrop || inputTokenDrop))
  );

  if (!piCandidate && !heuristicCandidate) {
    return {
      status: "none",
      source: "none",
      confidence: "none",
      label: "No compaction candidate",
      reasons: [],
      evidence,
    };
  }

  return {
    status: "candidate",
    source: piCandidate ? "pi_pattern" : "heuristic",
    confidence: candidateConfidence({
      piCandidate,
      summaryLikeHistory,
      historyByteDrop,
      historyBlockDrop,
      requestByteDrop,
      inputTokenDrop,
    }),
    label: piCandidate ? "Pi compaction candidate" : "Heuristic compaction candidate",
    reasons,
    evidence,
  };
}

function historyBlocks(blocks: readonly NormalizedBlock[]): NormalizedBlock[] {
  return blocks.filter((block) => block.direction === "request" && block.kind === "prior-conversation-history");
}

function detectSummarizationRequest(blocks: readonly NormalizedBlock[]): {
  readonly isCandidate: boolean;
  readonly largeCurrentInput: boolean;
  readonly reasons: SpyCompactionReason[];
} {
  const systemPrompt = blocks.find((block) =>
    block.direction === "request"
    && block.kind === "harness-system-context"
    && SUMMARIZATION_SYSTEM_PATTERN.test(block.text ?? "")
  );
  const wrappedInput = blocks.find((block) =>
    block.direction === "request"
    && block.kind === "current-user-input"
    && CONVERSATION_WRAPPER_PATTERN.test(block.text ?? "")
  );
  const largeCurrentInput = wrappedInput !== undefined && wrappedInput.byte_size >= MIN_LARGE_SUMMARIZATION_INPUT_BYTES;
  const reasons: SpyCompactionReason[] = [];
  if (systemPrompt !== undefined) {
    reasons.push("summarization_system_prompt");
  }
  if (wrappedInput !== undefined) {
    reasons.push("conversation_wrapper_input");
  }
  if (largeCurrentInput) {
    reasons.push("large_current_user_input");
  }
  return {
    isCandidate: systemPrompt !== undefined && wrappedInput !== undefined,
    largeCurrentInput,
    reasons,
  };
}

function byteSize(blocks: readonly NormalizedBlock[]): number {
  return blocks.reduce((total, block) => total + block.byte_size, 0);
}

function contextTokens(summary: SpyCallSummary): number | null {
  const parts = [
    summary.usage.inputTokens,
    summary.usage.cacheReadTokens,
    summary.usage.cacheWriteTokens,
  ].filter((value): value is number => value !== null);
  return parts.length === 0 ? null : parts.reduce((total, value) => total + value, 0);
}

function classifyHistoryBlocks(
  currentBlocks: readonly NormalizedBlock[],
  previousBlocks: readonly NormalizedBlock[],
): { readonly newBlockIds: string[]; readonly changedBlockIds: string[] } {
  const previousHashes = new Set(previousBlocks.map((block) => block.content_hash));
  const previousSignatures = new Set(previousBlocks.map(blockSignature));
  const newBlockIds: string[] = [];
  const changedBlockIds: string[] = [];
  for (const block of currentBlocks) {
    if (previousHashes.has(block.content_hash)) {
      continue;
    }
    if (previousSignatures.has(blockSignature(block))) {
      changedBlockIds.push(block.id);
    } else {
      newBlockIds.push(block.id);
    }
  }
  return { newBlockIds, changedBlockIds };
}

function stableContext(
  currentBlocks: readonly NormalizedBlock[],
  previousBlocks: readonly NormalizedBlock[],
): { readonly repeatedBlockCount: number; readonly changedBlockCount: number } {
  const previousContext = previousBlocks.filter(isContextBlock);
  const previousHashes = new Set(previousContext.map((block) => block.content_hash));
  const previousSignatures = new Set(previousContext.map(blockSignature));
  let repeatedBlockCount = 0;
  let changedBlockCount = 0;
  for (const block of currentBlocks.filter(isContextBlock)) {
    if (previousHashes.has(block.content_hash)) {
      repeatedBlockCount += 1;
    } else if (previousSignatures.has(blockSignature(block))) {
      changedBlockCount += 1;
    }
  }
  return { repeatedBlockCount, changedBlockCount };
}

function isContextBlock(block: NormalizedBlock): boolean {
  return block.direction === "request" && (
    block.kind === "harness-system-context"
      || block.kind === "tool-definition"
      || block.kind === "provider-envelope"
  );
}

function isPiRequestContext(input: RequestTransitionInput): boolean {
  return input.requestBlocks.some((block) => {
    if (block.source.includes("pi")) {
      return true;
    }
    return block.kind === "harness-system-context" && /\binside pi\b/i.test(block.text ?? "");
  });
}

function blockSignature(block: NormalizedBlock): string {
  return [
    block.direction,
    block.kind,
    block.role ?? "",
    block.provider_path ?? "",
  ].join(":");
}

function candidateConfidence(input: {
  readonly piCandidate: boolean;
  readonly summaryLikeHistory: boolean;
  readonly historyByteDrop: boolean;
  readonly historyBlockDrop: boolean;
  readonly requestByteDrop: boolean;
  readonly inputTokenDrop: boolean;
}): SpyCompactionConfidence {
  const signalCount = [
    input.summaryLikeHistory,
    input.historyByteDrop,
    input.historyBlockDrop,
    input.requestByteDrop || input.inputTokenDrop,
  ].filter(Boolean).length;
  if (input.piCandidate && signalCount >= 3) {
    return "high";
  }
  return signalCount >= 2 ? "medium" : "low";
}
