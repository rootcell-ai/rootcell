import { z } from "zod";
import type { LocalPortForwardHandle, LocalPortForwardOptions, VmRole, VmStatus } from "../providers/types.ts";
import { NonEmptyStringSchema, parseSchema } from "../schema.ts";
import type { RootcellConfig } from "../types.ts";
import type { ParsedExtensionsConfig } from "./config.ts";

export const RootcellExtensionIdSchema = z.enum(["plannotator", "subagent"]);

export type RootcellExtensionId = z.infer<typeof RootcellExtensionIdSchema>;

export const ExtensionGuestHookSchema = z.enum(["agentNixos", "firewallNixos", "homeManager"]);

export type ExtensionGuestHook = z.infer<typeof ExtensionGuestHookSchema>;

export interface ExtensionHostCommandContext {
  readonly repoDir: string;
  readonly instanceName: string;
  readonly extensionConfig: ParsedExtensionsConfig;
  readonly config: RootcellConfig;
  readonly log: (message: string) => void;
  vmStatus(role: VmRole): Promise<VmStatus>;
  forwardLocalPort(role: VmRole, options: LocalPortForwardOptions): Promise<LocalPortForwardHandle>;
}

export interface ExtensionHostCommandCompletionInput {
  readonly args: readonly string[];
  readonly current: string;
}

export type ExtensionHostCommandComplete = (
  input: ExtensionHostCommandCompletionInput,
) => readonly string[] | undefined;

export type ExtensionHostCommandRun = (
  context: ExtensionHostCommandContext,
  args: readonly string[],
) => Promise<number> | number;

export const ExtensionHostCommandNameSchema = z.string()
  .regex(/^[a-z](?:[a-z0-9-]*[a-z0-9])?$/, "must be lowercase kebab-case");

const ExtensionHostCommandCompleteSchema = z.custom<ExtensionHostCommandComplete>(
  (value) => typeof value === "function",
  { message: "must be a completion function" },
);

const ExtensionHostCommandRunSchema = z.custom<ExtensionHostCommandRun>(
  (value) => typeof value === "function",
  { message: "must be a run function" },
);

export const RootcellExtensionHostCommandSchema = z.object({
  name: ExtensionHostCommandNameSchema,
  description: NonEmptyStringSchema,
  complete: ExtensionHostCommandCompleteSchema,
  run: ExtensionHostCommandRunSchema,
}).strict();

export type RootcellExtensionHostCommand = Readonly<z.infer<typeof RootcellExtensionHostCommandSchema>>;

const RootcellExtensionHostCommandsSchema = z.array(RootcellExtensionHostCommandSchema)
  .refine((commands) => new Set(commands.map((command) => command.name)).size === commands.length, {
    message: "extension host command names must be unique",
  });

export const ExtensionGuestModulePathSchema = z.string()
  .regex(/^[A-Za-z0-9_./+-]+$/, "must be a repo-relative Nix module path")
  .refine((path) => !path.includes(".."), "must not traverse parent directories");

const RootcellExtensionGuestHooksSchema = z.object({
  agentNixos: z.array(ExtensionGuestModulePathSchema),
  firewallNixos: z.array(ExtensionGuestModulePathSchema),
  homeManager: z.array(ExtensionGuestModulePathSchema),
}).strict();

export const RootcellExtensionDefinitionSchema = z.object({
  id: RootcellExtensionIdSchema,
  description: NonEmptyStringSchema,
  requiresProvision: z.boolean(),
  guestHooks: RootcellExtensionGuestHooksSchema,
  hostCommands: RootcellExtensionHostCommandsSchema,
}).strict();

type RootcellExtensionGuestHooksOutput = z.infer<typeof RootcellExtensionGuestHooksSchema>;

type RootcellExtensionDefinitionOutput = z.infer<typeof RootcellExtensionDefinitionSchema>;

type RootcellExtensionGuestHooks = Readonly<{
  [K in keyof RootcellExtensionGuestHooksOutput]: readonly RootcellExtensionGuestHooksOutput[K][number][];
}>;

export type RootcellExtensionDefinition = Readonly<
  Omit<RootcellExtensionDefinitionOutput, "guestHooks" | "hostCommands"> & {
    readonly guestHooks: RootcellExtensionGuestHooks;
    readonly hostCommands: readonly RootcellExtensionHostCommand[];
  }
>;

const RootcellExtensionDefinitionsSchema = z.array(RootcellExtensionDefinitionSchema);

const NO_HOST_COMMANDS: readonly RootcellExtensionHostCommand[] = parseSchema(
  RootcellExtensionHostCommandsSchema,
  [],
  "invalid empty rootcell extension host commands",
);

export const ROOTCELL_EXTENSIONS: readonly RootcellExtensionDefinition[] = parseSchema(RootcellExtensionDefinitionsSchema, [
  {
    id: "plannotator",
    description: "Pi Plannotator integration package and remote-session configuration",
    requiresProvision: true,
    guestHooks: {
      agentNixos: [],
      firewallNixos: [],
      homeManager: ["extensions/plannotator/home-manager.nix"],
    },
    hostCommands: NO_HOST_COMMANDS,
  },
  {
    id: "subagent",
    description: "Pi subagent extension and bundled example agents",
    requiresProvision: true,
    guestHooks: {
      agentNixos: [],
      firewallNixos: [],
      homeManager: ["extensions/subagent/home-manager.nix"],
    },
    hostCommands: NO_HOST_COMMANDS,
  },
] as const, "invalid built-in rootcell extension definitions");

export const ROOTCELL_EXTENSION_IDS = RootcellExtensionIdSchema.options;

export function isRootcellExtensionId(value: string): value is RootcellExtensionId {
  return RootcellExtensionIdSchema.safeParse(value).success;
}

export function rootcellExtensionById(id: RootcellExtensionId): RootcellExtensionDefinition {
  const extension = ROOTCELL_EXTENSIONS.find((candidate) => candidate.id === id);
  if (extension === undefined) {
    throw new Error(`unknown rootcell extension id: ${id}`);
  }
  return extension;
}
