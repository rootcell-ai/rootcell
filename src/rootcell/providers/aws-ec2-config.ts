import { parseSchema } from "../schema.ts";
import { AwsEc2ConfigSchema, RootcellVmProviderIdSchema, type AwsEc2Config, type RootcellVmProviderId } from "../types.ts";

export const ROOTCELL_VM_PROVIDER_ENV = "ROOTCELL_VM_PROVIDER";
export const ROOTCELL_AWS_PROFILE_ENV = "ROOTCELL_AWS_PROFILE";
export const ROOTCELL_AWS_REGION_ENV = "ROOTCELL_AWS_REGION";
export const ROOTCELL_AWS_CONTROL_CIDR_ENV = "ROOTCELL_AWS_CONTROL_CIDR";
const NIXOS_AMI_OWNER_ID = "427812963091";

export function parseRootcellVmProvider(env: NodeJS.ProcessEnv): RootcellVmProviderId {
  const raw = env[ROOTCELL_VM_PROVIDER_ENV];
  if (raw === undefined || raw.length === 0) {
    return "lima";
  }
  return parseSchema(RootcellVmProviderIdSchema, raw, `invalid ${ROOTCELL_VM_PROVIDER_ENV}`);
}

export function parseAwsEc2Config(env: NodeJS.ProcessEnv): AwsEc2Config {
  return parseSchema(AwsEc2ConfigSchema, {
    profile: requiredEnv(env, ROOTCELL_AWS_PROFILE_ENV),
    region: requiredEnv(env, ROOTCELL_AWS_REGION_ENV),
    controlCidr: env[ROOTCELL_AWS_CONTROL_CIDR_ENV] ?? "auto",
    agentInstanceType: env.ROOTCELL_AWS_AGENT_INSTANCE_TYPE ?? "t4g.2xlarge",
    firewallInstanceType: env.ROOTCELL_AWS_FIREWALL_INSTANCE_TYPE ?? "t4g.small",
    agentRootVolumeGiB: positiveIntegerEnv(env, "ROOTCELL_AWS_AGENT_ROOT_VOLUME_GIB", 60),
    firewallRootVolumeGiB: positiveIntegerEnv(env, "ROOTCELL_AWS_FIREWALL_ROOT_VOLUME_GIB", 64),
    nixosAmiOwnerId: env.ROOTCELL_AWS_NIXOS_AMI_OWNER_ID ?? NIXOS_AMI_OWNER_ID,
    nixosAmiNamePattern: env.ROOTCELL_AWS_NIXOS_AMI_NAME_PATTERN ?? "nixos/26.05*",
  }, "invalid AWS EC2 provider config");
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required when ${ROOTCELL_VM_PROVIDER_ENV}=aws-ec2`);
  }
  return value;
}

function positiveIntegerEnv(env: NodeJS.ProcessEnv, name: string, defaultValue: number): number {
  const raw = env[name];
  if (raw === undefined || raw.length === 0) {
    return defaultValue;
  }
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(raw);
}
