import type { SpawnSyncReturns } from "node:child_process";
import { z } from "zod";
import { isRootcellSubcommand, type RootcellSubcommand } from "./metadata.ts";
import {
  NonEmptyStringSchema,
  NonNegativeSafeIntegerSchema,
} from "./schema.ts";
import { AwsSecretsManagerSecretProviderConfigSchema } from "./secrets/aws-secrets-manager-config.ts";

export const RootcellVmProviderIdSchema = z.enum(["lima", "aws-ec2"]);

export type RootcellVmProviderId = z.infer<typeof RootcellVmProviderIdSchema>;

const AwsControlCidrSchema = z.string().refine(
  (value) => value === "auto" || isIpv4Cidr(value),
  { message: "must be 'auto' or an IPv4 CIDR block" },
);

export const AwsEc2ConfigSchema = z.object({
  profile: NonEmptyStringSchema,
  region: NonEmptyStringSchema,
  controlCidr: AwsControlCidrSchema,
  agentInstanceType: NonEmptyStringSchema,
  firewallInstanceType: NonEmptyStringSchema,
  agentRootVolumeGiB: z.number().int().positive(),
  firewallRootVolumeGiB: z.number().int().positive(),
  nixosAmiOwnerId: NonEmptyStringSchema,
  nixosAmiNamePattern: NonEmptyStringSchema,
}).strict();

export type AwsEc2Config = Readonly<z.infer<typeof AwsEc2ConfigSchema>>;

function isIpv4Cidr(value: string): boolean {
  const parts = value.split("/");
  if (parts.length !== 2) {
    return false;
  }
  const [address, prefix] = parts;
  if (address === undefined || prefix === undefined || !/^[0-9]+$/.test(prefix)) {
    return false;
  }
  const prefixLength = Number(prefix);
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) {
    return false;
  }
  const octets = address.split(".");
  if (octets.length !== 4) {
    return false;
  }
  return octets.every((octet) => /^[0-9]+$/.test(octet) && Number(octet) <= 255);
}

export const CommandResultSchema = z.object({
  status: NonNegativeSafeIntegerSchema,
  stdout: z.string(),
  stderr: z.string(),
});

export type CommandResult = Readonly<z.infer<typeof CommandResultSchema>>;

export const InheritedCommandResultSchema = z.object({
  status: NonNegativeSafeIntegerSchema,
});

export type InheritedCommandResult = Readonly<z.infer<typeof InheritedCommandResultSchema>>;

export const RootcellConfigSchema = z.object({
  repoDir: NonEmptyStringSchema,
  instanceName: NonEmptyStringSchema,
  instanceDir: NonEmptyStringSchema,
  envPath: NonEmptyStringSchema,
  secretsPath: NonEmptyStringSchema,
  proxyDir: NonEmptyStringSchema,
  pkiDir: NonEmptyStringSchema,
  generatedDir: NonEmptyStringSchema,
  agentVm: NonEmptyStringSchema,
  firewallVm: NonEmptyStringSchema,
  guestUser: NonEmptyStringSchema,
  guestRepoDir: NonEmptyStringSchema,
  firewallIp: NonEmptyStringSchema,
  agentIp: NonEmptyStringSchema,
  networkPrefix: NonEmptyStringSchema,
  imageManifestUrl: NonEmptyStringSchema,
  imageDir: NonEmptyStringSchema.optional(),
  awsSecretsManagerProviders: z.array(AwsSecretsManagerSecretProviderConfigSchema),
  vmProvider: RootcellVmProviderIdSchema,
  awsEc2: AwsEc2ConfigSchema.optional(),
});

export type RootcellConfig = Readonly<z.infer<typeof RootcellConfigSchema>>;

export const SpyOptionsSchema = z.object({
  raw: z.boolean(),
  dedupe: z.boolean(),
  tui: z.boolean(),
});

export type SpyOptions = Readonly<z.infer<typeof SpyOptionsSchema>>;

const RootcellSubcommandOrEmptySchema = z.custom<RootcellSubcommand | "">(
  (value) => value === "" || (typeof value === "string" && isRootcellSubcommand(value)),
  { message: "must be a rootcell subcommand" },
);

export const ParsedRootcellRunArgsSchema = z.object({
  kind: z.literal("run"),
  instanceName: NonEmptyStringSchema,
  subcommand: RootcellSubcommandOrEmptySchema,
  rest: z.array(z.string()),
  spyOptions: SpyOptionsSchema,
});

type ParsedRootcellRunArgsOutput = z.infer<typeof ParsedRootcellRunArgsSchema>;

export type ParsedRootcellRunArgs = Readonly<
  Omit<ParsedRootcellRunArgsOutput, "rest" | "spyOptions"> & {
    readonly rest: readonly string[];
    readonly spyOptions: SpyOptions;
  }
>;

export const ParsedRootcellHandledArgsSchema = z.object({
  kind: z.literal("handled"),
  status: NonNegativeSafeIntegerSchema,
});

export type ParsedRootcellHandledArgs = Readonly<z.infer<typeof ParsedRootcellHandledArgsSchema>>;

export const ParsedRootcellArgsSchema = z.discriminatedUnion("kind", [
  ParsedRootcellRunArgsSchema,
  ParsedRootcellHandledArgsSchema,
]);

export type ParsedRootcellArgs = ParsedRootcellRunArgs | ParsedRootcellHandledArgs;

export const InstanceStateSchema = z.object({
  schemaVersion: z.literal(1),
  subnet: NonEmptyStringSchema,
  networkPrefix: z.literal(24),
  firewallIp: NonEmptyStringSchema,
  agentIp: NonEmptyStringSchema,
});

export type InstanceState = Readonly<z.infer<typeof InstanceStateSchema>>;

export const RootcellInstanceSchema = z.object({
  name: NonEmptyStringSchema,
  dir: NonEmptyStringSchema,
  envPath: NonEmptyStringSchema,
  secretsPath: NonEmptyStringSchema,
  proxyDir: NonEmptyStringSchema,
  pkiDir: NonEmptyStringSchema,
  generatedDir: NonEmptyStringSchema,
  statePath: NonEmptyStringSchema,
  state: InstanceStateSchema,
});

type RootcellInstanceOutput = z.infer<typeof RootcellInstanceSchema>;

export type RootcellInstance = Readonly<
  Omit<RootcellInstanceOutput, "state"> & {
    readonly state: InstanceState;
  }
>;

export interface VmFileSet {
  readonly agent: readonly string[];
  readonly firewall: readonly string[];
}

export type SyncSpawnResult = SpawnSyncReturns<string>;
