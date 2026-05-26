import { instancePaths, seedRootcellInstanceFiles } from "../instance.ts";
import {
  enabledExtensionIds,
  disabledExtensionIds,
  ensureExtensionsConfig,
  formatExtensionsList,
  type ParsedExtensionsConfig,
  parseExtensionsConfig,
  readExtensionsConfig,
  setExtensionEnabled,
} from "./config.ts";
import {
  ROOTCELL_EXTENSIONS,
  ROOTCELL_EXTENSION_IDS,
  type ExtensionHostCommandContext,
  type RootcellExtensionDefinition,
  type RootcellExtensionHostCommand,
  isRootcellExtensionId,
} from "./registry.ts";

const MANAGEMENT_COMMANDS = ["list", "enable", "disable"] as const;

export interface ExtensionHostCommandContextFactoryInput {
  readonly extension: RootcellExtensionDefinition;
  readonly command: RootcellExtensionHostCommand;
  readonly extensionConfig: ParsedExtensionsConfig;
}

export type ExtensionHostCommandContextFactory = (
  input: ExtensionHostCommandContextFactoryInput,
) => Promise<ExtensionHostCommandContext> | ExtensionHostCommandContext;

export async function runExtensionCommand(input: {
  readonly repoDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly instanceName: string;
  readonly rest: readonly string[];
  readonly log: (message: string) => void;
  readonly createContext: ExtensionHostCommandContextFactory;
  readonly extensions?: readonly RootcellExtensionDefinition[];
}): Promise<number> {
  const extensions = input.extensions ?? ROOTCELL_EXTENSIONS;
  const [commandOrId, idOrCommand, ...extra] = input.rest;
  if (commandOrId === undefined) {
    input.log("usage: rootcell extension list | enable <id> | disable <id> | <id> <command>");
    return 2;
  }

  if (commandOrId === "list") {
    if (idOrCommand !== undefined) {
      input.log("usage: rootcell extension list");
      return 2;
    }
    seedRootcellInstanceFiles(input.repoDir, input.instanceName, input.log, input.env);
    const path = instancePaths(input.repoDir, input.instanceName, input.env).extensionsPath;
    process.stdout.write(formatExtensionsList(ensureExtensionsConfig(path, input.log)));
    return 0;
  }

  if (commandOrId === "enable" || commandOrId === "disable") {
    if (idOrCommand === undefined || extra.length > 0) {
      input.log(`usage: rootcell extension ${commandOrId} <id>`);
      return 2;
    }
    const extension = findExtension(extensions, idOrCommand);
    if (!isRootcellExtensionId(idOrCommand) || extension === undefined) {
      input.log(`unknown extension id '${idOrCommand}' (known: ${knownExtensionIds(extensions).join(", ")})`);
      return 2;
    }

    seedRootcellInstanceFiles(input.repoDir, input.instanceName, input.log, input.env);
    const path = instancePaths(input.repoDir, input.instanceName, input.env).extensionsPath;
    const enabled = commandOrId === "enable";
    const result = setExtensionEnabled(path, idOrCommand, enabled);
    const state = enabled ? "enabled" : "disabled";
    const already = result.changed ? "" : " already";
    process.stdout.write(`${idOrCommand}${already} ${state} for instance '${input.instanceName}'.\n`);
    printApplyGuidance(input.instanceName, extension);
    return 0;
  }

  return await runOperationalExtensionCommand({ ...input, extensions, commandOrId, idOrCommand, extra });
}

export function completeExtensionCommand(input: {
  readonly repoDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly instanceName: string;
  readonly words: readonly string[];
  readonly current: string;
  readonly extensions?: readonly RootcellExtensionDefinition[];
}): readonly string[] | undefined {
  const extensions = input.extensions ?? ROOTCELL_EXTENSIONS;
  const extensionAt = input.words.indexOf("extension");
  if (extensionAt === -1) {
    return undefined;
  }
  const after = input.words.slice(extensionAt + 1);
  const first = after[0];
  if (after.length <= 1) {
    const config = safeReadExtensionsConfig(input.repoDir, input.env, input.instanceName);
    return startsWith([
      ...MANAGEMENT_COMMANDS,
      ...enabledOperationalExtensionIds(extensions, config),
    ], input.current);
  }
  if ((first === "enable" || first === "disable") && after.length <= 2) {
    const config = safeReadExtensionsConfig(input.repoDir, input.env, input.instanceName);
    const completions = first === "enable"
      ? disabledExtensionIds(config)
      : ROOTCELL_EXTENSION_IDS.filter((id) => config.enabled.has(id));
    return startsWith(completions, input.current);
  }
  if (first !== undefined && after.length <= 2) {
    const config = safeReadExtensionsConfig(input.repoDir, input.env, input.instanceName);
    const extension = findExtension(extensions, first);
    if (extension === undefined || !config.enabled.has(extension.id)) {
      return [];
    }
    return startsWith(extension.hostCommands.map((command) => command.name), input.current);
  }
  if (first !== undefined && after.length > 2) {
    const config = safeReadExtensionsConfig(input.repoDir, input.env, input.instanceName);
    const extension = findExtension(extensions, first);
    if (extension === undefined || !config.enabled.has(extension.id)) {
      return [];
    }
    const command = extension.hostCommands.find((candidate) => candidate.name === after[1]);
    return command?.complete({ args: after.slice(2), current: input.current }) ?? [];
  }
  return [];
}

async function runOperationalExtensionCommand(input: {
  readonly repoDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly instanceName: string;
  readonly log: (message: string) => void;
  readonly createContext: ExtensionHostCommandContextFactory;
  readonly extensions: readonly RootcellExtensionDefinition[];
  readonly commandOrId: string;
  readonly idOrCommand: string | undefined;
  readonly extra: readonly string[];
}): Promise<number> {
  const extension = findExtension(input.extensions, input.commandOrId);
  if (extension === undefined) {
    input.log(`unknown extension command or id '${input.commandOrId}' (expected ${MANAGEMENT_COMMANDS.join(", ")}, or one of: ${knownExtensionIds(input.extensions).join(", ")})`);
    return 2;
  }

  const extensionConfig = readExtensionsConfig(instancePaths(input.repoDir, input.instanceName, input.env).extensionsPath);
  if (!extensionConfig.enabled.has(extension.id)) {
    input.log(`extension '${extension.id}' is disabled for instance '${input.instanceName}'.`);
    input.log(`run ./rootcell --instance ${input.instanceName} extension enable ${extension.id}, then ./rootcell --instance ${input.instanceName} provision.`);
    return 1;
  }

  if (input.idOrCommand === undefined) {
    input.log(`usage: rootcell extension ${extension.id} <command>`);
    logKnownHostCommands(input.log, extension);
    return 2;
  }
  const command = extension.hostCommands.find((candidate) => candidate.name === input.idOrCommand);
  if (command === undefined) {
    input.log(`unknown command for extension '${extension.id}': '${input.idOrCommand}'`);
    logKnownHostCommands(input.log, extension);
    return 2;
  }

  const context = await input.createContext({ extension, command, extensionConfig });
  return await command.run(context, input.extra);
}

function printApplyGuidance(instanceName: string, extension: RootcellExtensionDefinition): void {
  if (extension.requiresProvision) {
    process.stdout.write(`run ./rootcell --instance ${instanceName} provision to apply VM changes.\n`);
    return;
  }
  process.stdout.write("no provision is needed for this extension change.\n");
}

function logKnownHostCommands(
  log: (message: string) => void,
  extension: RootcellExtensionDefinition,
): void {
  const known = extension.hostCommands.map((command) => command.name);
  if (known.length === 0) {
    log(`extension '${extension.id}' has no host commands in this Rootcell version.`);
    return;
  }
  log(`known commands for '${extension.id}': ${known.join(", ")}`);
}

function findExtension(
  extensions: readonly RootcellExtensionDefinition[],
  id: string,
): RootcellExtensionDefinition | undefined {
  return extensions.find((extension) => extension.id === id);
}

function knownExtensionIds(extensions: readonly RootcellExtensionDefinition[]): readonly string[] {
  return extensions.map((extension) => extension.id);
}

function enabledOperationalExtensionIds(
  extensions: readonly RootcellExtensionDefinition[],
  config: ParsedExtensionsConfig,
): readonly string[] {
  const enabled = new Set(enabledExtensionIds(config));
  return extensions
    .filter((extension) => enabled.has(extension.id) && extension.hostCommands.length > 0)
    .map((extension) => extension.id);
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
