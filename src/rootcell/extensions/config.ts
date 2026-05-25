import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { parseSchema } from "../schema.ts";
import {
  ROOTCELL_EXTENSION_IDS,
  RootcellExtensionIdSchema,
  isRootcellExtensionId,
  type RootcellExtensionId,
} from "./registry.ts";

export const ExtensionConfigKeySchema = z.string()
  .regex(/^[a-z](?:[a-z0-9-]*[a-z0-9])?$/, "must be lowercase kebab-case");

const ExtensionCommentLineSchema = z.object({
  kind: z.literal("comment"),
  raw: z.string(),
}).strict();

const ExtensionBlankLineSchema = z.object({
  kind: z.literal("blank"),
  raw: z.literal(""),
}).strict();

const ExtensionEntryLineSchema = z.object({
  kind: z.literal("entry"),
  raw: z.string(),
  key: ExtensionConfigKeySchema,
  enabled: z.boolean(),
  known: z.boolean(),
}).strict();

export const ExtensionConfigLineSchema = z.discriminatedUnion("kind", [
  ExtensionCommentLineSchema,
  ExtensionBlankLineSchema,
  ExtensionEntryLineSchema,
]);

const RootcellExtensionIdSetSchema = z.custom<ReadonlySet<RootcellExtensionId>>(
  (value) => value instanceof Set && [...value].every((id) => RootcellExtensionIdSchema.safeParse(id).success),
  { message: "must be a set of rootcell extension ids" },
);

export const ParsedExtensionsConfigSchema = z.object({
  lines: z.array(ExtensionConfigLineSchema),
  enabled: RootcellExtensionIdSetSchema,
  unknownKeys: z.array(ExtensionConfigKeySchema),
}).strict();

export const ExtensionSetResultSchema = z.object({
  config: ParsedExtensionsConfigSchema,
  changed: z.boolean(),
}).strict();

export type ExtensionConfigLine = Readonly<z.infer<typeof ExtensionConfigLineSchema>>;

type ParsedExtensionsConfigOutput = z.infer<typeof ParsedExtensionsConfigSchema>;

export type ParsedExtensionsConfig = Readonly<
  Omit<ParsedExtensionsConfigOutput, "lines" | "unknownKeys"> & {
    readonly lines: readonly ExtensionConfigLine[];
    readonly unknownKeys: readonly string[];
  }
>;

type ExtensionSetResultOutput = z.infer<typeof ExtensionSetResultSchema>;

export type ExtensionSetResult = Readonly<
  Omit<ExtensionSetResultOutput, "config"> & {
    readonly config: ParsedExtensionsConfig;
  }
>;

export function parseExtensionsConfig(text: string): ParsedExtensionsConfig {
  const lines: ExtensionConfigLine[] = [];
  const enabled = new Set<RootcellExtensionId>();
  const unknownKeys: string[] = [];
  const seen = new Set<string>();
  const rawLines = text.split(/\r?\n/);
  const lineCount = text.length === 0 ? 0 : text.endsWith("\n") ? rawLines.length - 1 : rawLines.length;

  for (let index = 0; index < lineCount; index += 1) {
    const raw = rawLines[index] ?? "";
    if (raw.length === 0) {
      lines.push({ kind: "blank", raw: "" });
      continue;
    }
    if (raw.startsWith("#")) {
      lines.push({ kind: "comment", raw });
      continue;
    }

    const equalsAt = raw.indexOf("=");
    const key = equalsAt === -1 ? raw : raw.slice(0, equalsAt);
    const value = equalsAt === -1 ? "" : raw.slice(equalsAt + 1);
    if (!ExtensionConfigKeySchema.safeParse(key).success) {
      throw new Error(`invalid extension key in extensions.txt on line ${String(index + 1)}: ${key}`);
    }
    if (seen.has(key)) {
      throw new Error(`duplicate extension key in extensions.txt on line ${String(index + 1)}: ${key}`);
    }
    seen.add(key);

    const valueEnabled = parseExtensionBoolean(value, key, index + 1);
    const known = isRootcellExtensionId(key);
    if (known && valueEnabled) {
      enabled.add(key);
    }
    if (!known) {
      unknownKeys.push(key);
    }
    lines.push({ kind: "entry", raw, key, enabled: valueEnabled, known });
  }

  return parseSchema(ParsedExtensionsConfigSchema, { lines, enabled, unknownKeys }, "invalid parsed extensions config");
}

export function readExtensionsConfig(path: string): ParsedExtensionsConfig {
  if (!existsSync(path)) {
    return parseExtensionsConfig("");
  }
  return parseExtensionsConfig(readFileSync(path, "utf8"));
}

export function ensureExtensionsConfig(
  path: string,
  log?: (message: string) => void,
): ParsedExtensionsConfig {
  const existed = existsSync(path);
  const config = readExtensionsConfig(path);
  const rendered = renderExtensionsConfig(config);
  const existingText = existed ? readFileSync(path, "utf8") : "";
  if (!existed || rendered !== existingText) {
    writeExtensionsConfig(path, rendered);
    if (!existed) {
      log?.(`seeded extensions at ${path}`);
    }
  }
  return parseExtensionsConfig(rendered);
}

export function setExtensionEnabled(
  path: string,
  id: RootcellExtensionId,
  enabled: boolean,
): ExtensionSetResult {
  const config = ensureExtensionsConfig(path);
  const before = config.enabled.has(id);
  const rendered = renderExtensionsConfig(config, new Map([[id, enabled]]));
  const changed = before !== enabled;
  if (changed) {
    writeExtensionsConfig(path, rendered);
  }
  return parseSchema(ExtensionSetResultSchema, {
    config: parseExtensionsConfig(rendered),
    changed,
  }, "invalid extension set result");
}

export function enabledExtensionIds(config: ParsedExtensionsConfig): readonly RootcellExtensionId[] {
  return ROOTCELL_EXTENSION_IDS.filter((id) => config.enabled.has(id));
}

export function disabledExtensionIds(config: ParsedExtensionsConfig): readonly RootcellExtensionId[] {
  return ROOTCELL_EXTENSION_IDS.filter((id) => !config.enabled.has(id));
}

export function renderExtensionsConfig(
  config: ParsedExtensionsConfig,
  overrides: ReadonlyMap<RootcellExtensionId, boolean> = new Map(),
): string {
  const present = new Set<string>();
  const lines: string[] = [];

  for (const line of config.lines) {
    if (line.kind !== "entry") {
      lines.push(line.raw);
      continue;
    }
    present.add(line.key);
    if (isRootcellExtensionId(line.key) && overrides.has(line.key)) {
      lines.push(`${line.key}=${overrides.get(line.key) === true ? "true" : "false"}`);
      continue;
    }
    lines.push(line.raw);
  }

  for (const id of ROOTCELL_EXTENSION_IDS) {
    if (!present.has(id)) {
      lines.push(`${id}=false`);
    }
  }

  return `${lines.join("\n")}\n`;
}

export function formatExtensionsList(config: ParsedExtensionsConfig): string {
  const rows = [
    ["ID", "STATUS"],
    ...ROOTCELL_EXTENSION_IDS.map((id) => [id, config.enabled.has(id) ? "enabled" : "disabled"]),
  ];
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
  const table = rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd()).join("\n");
  const unknown = config.unknownKeys.length === 0
    ? ""
    : `\n\nUnknown extension keys preserved in extensions.txt:\n${config.unknownKeys.join("\n")}`;
  return `${table}${unknown}\n`;
}

function writeExtensionsConfig(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const mode = existsSync(path) ? statSync(path).mode : 0o644;
  writeFileSync(path, text, { encoding: "utf8", mode });
}

function parseExtensionBoolean(value: string, key: string, line: number): boolean {
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off", ""].includes(normalized)) {
    return false;
  }
  throw new Error(`invalid boolean value for extension '${key}' in extensions.txt on line ${String(line)}: ${value}`);
}
