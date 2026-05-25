import { instancePaths, seedRootcellInstanceFiles } from "../instance.ts";
import {
  disabledExtensionIds,
  ensureExtensionsConfig,
  formatExtensionsList,
  parseExtensionsConfig,
  readExtensionsConfig,
  setExtensionEnabled,
} from "./config.ts";
import {
  ROOTCELL_EXTENSION_IDS,
  isRootcellExtensionId,
} from "./registry.ts";

export function runExtensionCommand(input: {
  readonly repoDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly instanceName: string;
  readonly rest: readonly string[];
  readonly log: (message: string) => void;
}): number {
  const [command, id, ...extra] = input.rest;
  if (command === undefined) {
    input.log("usage: rootcell extension list | enable <id> | disable <id>");
    return 2;
  }

  seedRootcellInstanceFiles(input.repoDir, input.instanceName, input.log, input.env);
  const path = instancePaths(input.repoDir, input.instanceName, input.env).extensionsPath;

  if (command === "list") {
    if (id !== undefined) {
      input.log("usage: rootcell extension list");
      return 2;
    }
    process.stdout.write(formatExtensionsList(ensureExtensionsConfig(path, input.log)));
    return 0;
  }

  if (command !== "enable" && command !== "disable") {
    input.log(`unknown extension command '${command}' (expected list, enable, disable)`);
    return 2;
  }
  if (id === undefined || extra.length > 0) {
    input.log(`usage: rootcell extension ${command} <id>`);
    return 2;
  }
  if (!isRootcellExtensionId(id)) {
    input.log(`unknown extension id '${id}' (known: ${ROOTCELL_EXTENSION_IDS.join(", ")})`);
    return 2;
  }

  const enabled = command === "enable";
  const result = setExtensionEnabled(path, id, enabled);
  const state = enabled ? "enabled" : "disabled";
  const already = result.changed ? "" : " already";
  process.stdout.write(`${id}${already} ${state} for instance '${input.instanceName}'.\n`);
  process.stdout.write(`run ./rootcell --instance ${input.instanceName} provision to apply VM changes.\n`);
  return 0;
}

export function completeExtensionCommand(input: {
  readonly repoDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly instanceName: string;
  readonly words: readonly string[];
  readonly current: string;
}): readonly string[] | undefined {
  const extensionAt = input.words.indexOf("extension");
  if (extensionAt === -1) {
    return undefined;
  }
  const after = input.words.slice(extensionAt + 1);
  const first = after[0];
  if (after.length <= 1) {
    return startsWith(["list", "enable", "disable"], input.current);
  }
  if ((first === "enable" || first === "disable") && after.length <= 2) {
    const config = safeReadExtensionsConfig(input.repoDir, input.env, input.instanceName);
    const completions = first === "enable"
      ? disabledExtensionIds(config)
      : ROOTCELL_EXTENSION_IDS.filter((id) => config.enabled.has(id));
    return startsWith(completions, input.current);
  }
  return [];
}

function safeReadExtensionsConfig(
  repoDir: string,
  env: NodeJS.ProcessEnv,
  instanceName: string,
): ReturnType<typeof readExtensionsConfig> {
  try {
    return readExtensionsConfig(instancePaths(repoDir, instanceName, env).extensionsPath);
  } catch {
    return parseExtensionsConfig("");
  }
}

function startsWith<T extends string>(values: readonly T[], current: string): readonly T[] {
  return values.filter((value) => value.startsWith(current));
}
