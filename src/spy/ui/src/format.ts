import type { NormalizedBlock, SpyCallSummary, SpyUsageSummary } from "./types.ts";

export interface FormattedHttpTarget {
  readonly raw: string;
  readonly path: string;
  readonly query: string | null;
  readonly fragment: string | null;
  readonly display: string;
}

const NUMBER_FORMAT = new Intl.NumberFormat("en-US");
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export function currentSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function secondsForPreset(preset: "10m" | "1h" | "today", now = new Date()): number {
  if (preset === "10m") {
    return Math.floor(now.getTime() / 1000) - 10 * 60;
  }
  if (preset === "1h") {
    return Math.floor(now.getTime() / 1000) - 60 * 60;
  }
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return Math.floor(start.getTime() / 1000);
}

export function formatTime(seconds: number): string {
  return TIME_FORMAT.format(new Date(seconds * 1000));
}

export function formatDateTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) {
    return "pending";
  }
  return DATE_TIME_FORMAT.format(new Date(seconds * 1000));
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) {
    return "pending";
  }
  if (ms < 1000) {
    return `${String(ms)} ms`;
  }
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  const units = ["KiB", "MiB", "GiB"] as const;
  let value = bytes / 1024;
  let unit: (typeof units)[number] = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index] ?? unit;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
}

export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "-" : NUMBER_FORMAT.format(value);
}

export function formatCount(value: number, singular: string, plural = `${singular}s`): string {
  return `${formatNumber(value)} ${value === 1 ? singular : plural}`;
}

export function formatUsageTotal(usage: SpyUsageSummary): string {
  return usage.totalTokens === null ? "usage n/a" : `${formatCompactNumber(usage.totalTokens)} tok`;
}

function formatCompactNumber(value: number): string {
  if (value < 1000) {
    return formatNumber(value);
  }
  if (value < 10_000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return `${Math.round(value / 1000).toString()}k`;
}

export function shortModelId(modelId: string): string {
  const parts = modelId.split(".");
  if (parts.length > 2 && parts[0]?.length === 2) {
    return parts.slice(2).join(".");
  }
  if (parts.length <= 2) {
    return modelId;
  }
  return parts.slice(-2).join(".");
}

export function formatHttpTarget(rawTarget: string): FormattedHttpTarget {
  const parsed = parseHttpTarget(rawTarget);
  const path = decodePath(parsed.path);
  const query = parsed.query === null ? null : decodeQuery(parsed.query);
  const fragment = parsed.fragment === null ? null : safeDecodeComponent(parsed.fragment);
  return {
    raw: rawTarget,
    path,
    query,
    fragment,
    display: `${path}${query === null ? "" : `?${query}`}${fragment === null ? "" : `#${fragment}`}`,
  };
}

export function statusTone(status: SpyCallSummary["call"]["status"]): "green" | "amber" | "red" | "neutral" {
  switch (status) {
    case "complete":
      return "green";
    case "pending":
      return "amber";
    case "error":
    case "dropped":
      return "red";
  }
}

export function blockKindLabel(kind: NormalizedBlock["kind"]): string {
  return kind
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function blockText(block: NormalizedBlock): string {
  if (block.text !== undefined) {
    return block.text;
  }
  if (block.json !== undefined) {
    return JSON.stringify(block.json, null, 2);
  }
  return "";
}

export function clipped(value: string, max = 280): string {
  return value.length <= max ? value : `${value.slice(0, max).trimEnd()}...`;
}

function parseHttpTarget(rawTarget: string): { readonly path: string; readonly query: string | null; readonly fragment: string | null } {
  try {
    const url = new URL(rawTarget, "http://rootcell.invalid");
    return {
      path: url.pathname,
      query: url.search.length === 0 ? null : url.search.slice(1),
      fragment: url.hash.length === 0 ? null : url.hash.slice(1),
    };
  } catch {
    return parseHttpTargetFallback(rawTarget);
  }
}

function parseHttpTargetFallback(rawTarget: string): { readonly path: string; readonly query: string | null; readonly fragment: string | null } {
  const hashIndex = rawTarget.indexOf("#");
  const withoutFragment = hashIndex === -1 ? rawTarget : rawTarget.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? null : rawTarget.slice(hashIndex + 1);
  const queryIndex = withoutFragment.indexOf("?");
  return {
    path: queryIndex === -1 ? withoutFragment : withoutFragment.slice(0, queryIndex),
    query: queryIndex === -1 ? null : withoutFragment.slice(queryIndex + 1),
    fragment,
  };
}

function decodePath(path: string): string {
  return path.split("/").map(safeDecodeComponent).join("/");
}

function decodeQuery(query: string): string {
  return query
    .split("&")
    .map((part) => {
      const equalsIndex = part.indexOf("=");
      if (equalsIndex === -1) {
        return safeDecodeQueryComponent(part);
      }
      const name = safeDecodeQueryComponent(part.slice(0, equalsIndex));
      const value = safeDecodeQueryComponent(part.slice(equalsIndex + 1));
      return `${name}=${value}`;
    })
    .join("&");
}

function safeDecodeQueryComponent(value: string): string {
  return safeDecodeComponent(value.replaceAll("+", " "));
}

function safeDecodeComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function summarizeBlocks(blocks: readonly NormalizedBlock[]): readonly {
  readonly kind: NormalizedBlock["kind"];
  readonly count: number;
  readonly bytes: number;
}[] {
  const byKind = new Map<NormalizedBlock["kind"], { count: number; bytes: number }>();
  for (const block of blocks) {
    const current = byKind.get(block.kind) ?? { count: 0, bytes: 0 };
    byKind.set(block.kind, {
      count: current.count + 1,
      bytes: current.bytes + block.byte_size,
    });
  }
  return [...byKind.entries()].map(([kind, summary]) => ({ kind, ...summary }));
}
