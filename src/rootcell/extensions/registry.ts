import { z } from "zod";
import { NonEmptyStringSchema, parseSchema } from "../schema.ts";

export const RootcellExtensionIdSchema = z.enum(["plannotator", "subagent"]);

export type RootcellExtensionId = z.infer<typeof RootcellExtensionIdSchema>;

export const ExtensionGuestHookSchema = z.enum(["agentNixos", "firewallNixos", "homeManager"]);

export type ExtensionGuestHook = z.infer<typeof ExtensionGuestHookSchema>;

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
}).strict();

type RootcellExtensionGuestHooksOutput = z.infer<typeof RootcellExtensionGuestHooksSchema>;

type RootcellExtensionDefinitionOutput = z.infer<typeof RootcellExtensionDefinitionSchema>;

type RootcellExtensionGuestHooks = Readonly<{
  [K in keyof RootcellExtensionGuestHooksOutput]: readonly RootcellExtensionGuestHooksOutput[K][number][];
}>;

export type RootcellExtensionDefinition = Readonly<
  Omit<RootcellExtensionDefinitionOutput, "guestHooks"> & {
    readonly guestHooks: RootcellExtensionGuestHooks;
  }
>;

const RootcellExtensionDefinitionsSchema = z.array(RootcellExtensionDefinitionSchema);

const NO_GUEST_HOOKS: RootcellExtensionGuestHooks = parseSchema(RootcellExtensionGuestHooksSchema, {
  agentNixos: [],
  firewallNixos: [],
  homeManager: [],
}, "invalid empty rootcell extension guest hooks");

export const ROOTCELL_EXTENSIONS: readonly RootcellExtensionDefinition[] = parseSchema(RootcellExtensionDefinitionsSchema, [
  {
    id: "plannotator",
    description: "Pi Plannotator integration metadata placeholder",
    requiresProvision: true,
    guestHooks: NO_GUEST_HOOKS,
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
