import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { loadDotEnv } from "../env.ts";
import { resolveHostTool } from "../host-tools.ts";
import { runCapture, runInherited } from "../process.ts";
import { NonEmptyStringSchema, parseSchema } from "../schema.ts";
import type { RootcellConfig } from "../types.ts";
import { DefaultAwsEc2Api } from "./aws-ec2-aws.ts";
import type { AwsEc2Api } from "./aws-ec2-aws.ts";

const AWS_PROVIDER_VERSION = "~> 6.0";
const METADATA_VERSION = 1;

const AwsEc2TerraformOutputsSchema = z.object({
  agent_instance_id: z.string(),
  firewall_instance_id: z.string(),
  firewall_public_ip: z.string(),
  agent_private_ip: z.string(),
  firewall_private_ip: z.string(),
  nixos_ami_id: z.string(),
  nixos_ami_name: z.string(),
  applied_control_cidr: z.string(),
}).strict();

export type AwsEc2TerraformOutputs = Readonly<z.infer<typeof AwsEc2TerraformOutputsSchema>>;

const AwsEc2ProviderMetadataSchema = z.object({
  schemaVersion: z.literal(METADATA_VERSION),
  rootcellInstanceId: NonEmptyStringSchema,
  accountId: NonEmptyStringSchema,
  region: NonEmptyStringSchema,
  terraformDir: NonEmptyStringSchema,
  outputs: AwsEc2TerraformOutputsSchema.optional(),
}).strict();

export type AwsEc2ProviderMetadata = Readonly<z.infer<typeof AwsEc2ProviderMetadataSchema>>;

export interface TerraformRunner {
  init(cwd: string, env: NodeJS.ProcessEnv): void;
  apply(cwd: string, env: NodeJS.ProcessEnv): void;
  destroy(cwd: string, env: NodeJS.ProcessEnv): void;
  outputJson(cwd: string, env: NodeJS.ProcessEnv): string;
}

interface EnsureAppliedOptions {
  readonly force: boolean;
}

type DesiredInstanceState = "running" | "stopped";

interface TerraformVars {
  readonly aws_profile: string;
  readonly aws_region: string;
  readonly instance_name: string;
  readonly rootcell_instance_id: string;
  readonly vpc_cidr: string;
  readonly firewall_private_ip: string;
  readonly agent_private_ip: string;
  readonly control_cidr: string;
  readonly public_key_path: string;
  readonly guest_user: string;
  readonly desired_instance_state: DesiredInstanceState;
  readonly agent_instance_type: string;
  readonly firewall_instance_type: string;
  readonly agent_root_volume_gib: number;
  readonly firewall_root_volume_gib: number;
  readonly nixos_ami_owner_id: string;
  readonly nixos_ami_name_pattern: string;
}

export class AwsEc2TerraformProject {
  private terraformBin = "";
  private readonly runner: TerraformRunner;
  private readonly api: AwsEc2Api;

  constructor(
    private readonly config: RootcellConfig,
    private readonly log: (message: string) => void,
    options: {
      readonly runner?: TerraformRunner;
      readonly api?: AwsEc2Api;
    } = {},
  ) {
    this.runner = options.runner ?? new TerraformCliRunner(() => this.ensureTerraform());
    this.api = options.api ?? new DefaultAwsEc2Api(config);
  }

  async preflight(): Promise<void> {
    this.requireAwsConfig();
    this.ensureTerraform();
    await this.api.accountId();
  }

  async ensureApplied(options: EnsureAppliedOptions): Promise<void> {
    const metadata = await this.ensureMetadata();
    const controlCidr = this.resolveControlCidr();
    if (metadata.outputs !== undefined && !options.force) {
      if (metadata.outputs.applied_control_cidr !== controlCidr) {
        throw new Error(
          `AWS control CIDR is now ${controlCidr}, but this instance was applied with ${metadata.outputs.applied_control_cidr}; run rootcell --instance ${this.config.instanceName} provision to update firewall SSH ingress`,
        );
      }
      return;
    }

    this.log(`applying AWS EC2 infrastructure for instance '${this.config.instanceName}'...`);
    this.writeTerraformFiles(metadata, "running", controlCidr);
    this.runner.init(this.terraformDir(), this.terraformEnv());
    this.runner.apply(this.terraformDir(), this.terraformEnv());
    this.writeMetadata({
      ...metadata,
      outputs: this.readOutputs(),
    });
  }

  async applyDesiredInstanceState(state: DesiredInstanceState): Promise<void> {
    const metadata = await this.ensureMetadata();
    const controlCidr = metadata.outputs?.applied_control_cidr ?? this.resolveControlCidr();
    this.writeTerraformFiles(metadata, state, controlCidr);
    this.runner.init(this.terraformDir(), this.terraformEnv());
    this.runner.apply(this.terraformDir(), this.terraformEnv());
    this.writeMetadata({
      ...metadata,
      outputs: this.readOutputs(),
    });
  }

  destroy(): void {
    if (!existsSync(this.terraformStatePath())) {
      return;
    }
    this.runner.init(this.terraformDir(), this.terraformEnv());
    this.runner.destroy(this.terraformDir(), this.terraformEnv());
  }

  async verifyTerraformStateTags(): Promise<void> {
    const resources = this.destructiveResourceIdsFromState();
    const tags = ownershipTags(this.config.instanceName);
    if (resources.ec2ResourceIds.length > 0) {
      await this.api.assertTagged(resources.ec2ResourceIds, tags);
    }
    if (resources.keyPairNames.length > 0) {
      await this.api.assertKeyPairsTagged(resources.keyPairNames, tags);
    }
  }

  removeLocalState(): void {
    rmSync(this.awsDir(), { recursive: true, force: true });
  }

  readOutputsIfPresent(): AwsEc2TerraformOutputs | null {
    return this.readMetadata()?.outputs ?? null;
  }

  readMetadata(): AwsEc2ProviderMetadata | null {
    const path = this.metadataPath();
    if (!existsSync(path)) {
      return null;
    }
    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      return parseSchema(AwsEc2ProviderMetadataSchema, raw, "invalid AWS EC2 provider metadata");
    } catch {
      return null;
    }
  }

  controlIdentityPath(): string {
    return join(this.config.instanceDir, "ssh", "aws_control_ed25519");
  }

  knownHostsPath(): string {
    return join(this.config.instanceDir, "ssh", "known_hosts");
  }

  async instanceStatus(instanceId: string): Promise<"missing" | "running" | "stopped" | "unexpected"> {
    return await this.api.instanceStatus(instanceId);
  }

  private async ensureMetadata(): Promise<AwsEc2ProviderMetadata> {
    const existing = this.readMetadata();
    if (existing !== null) {
      return existing;
    }
    const accountId = await this.api.accountId();
    const metadata: AwsEc2ProviderMetadata = {
      schemaVersion: METADATA_VERSION,
      rootcellInstanceId: randomUUID(),
      accountId,
      region: this.requireAwsConfig().region,
      terraformDir: this.terraformDir(),
    };
    this.writeMetadata(metadata);
    return metadata;
  }

  private writeMetadata(metadata: AwsEc2ProviderMetadata): void {
    mkdirSync(this.awsDir(), { recursive: true, mode: 0o700 });
    writeFileSync(this.metadataPath(), `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private writeTerraformFiles(
    metadata: AwsEc2ProviderMetadata,
    desiredState: DesiredInstanceState,
    controlCidr: string,
  ): void {
    const terraformDir = this.terraformDir();
    mkdirSync(terraformDir, { recursive: true, mode: 0o700 });
    const vars = this.terraformVars(metadata.rootcellInstanceId, desiredState, controlCidr);
    writeFileSync(join(terraformDir, "main.tf"), awsEc2TerraformMain(), { encoding: "utf8", mode: 0o600 });
    writeFileSync(join(terraformDir, "variables.tf"), awsEc2TerraformVariables(), { encoding: "utf8", mode: 0o600 });
    writeFileSync(join(terraformDir, "outputs.tf"), awsEc2TerraformOutputs(), { encoding: "utf8", mode: 0o600 });
    writeFileSync(join(terraformDir, "terraform.tfvars.json"), `${JSON.stringify(vars, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private terraformVars(rootcellInstanceId: string, desiredState: DesiredInstanceState, controlCidr: string): TerraformVars {
    const aws = this.requireAwsConfig();
    const keys = this.ensureControlKey();
    return {
      aws_profile: aws.profile,
      aws_region: aws.region,
      instance_name: this.config.instanceName,
      rootcell_instance_id: rootcellInstanceId,
      vpc_cidr: `${this.subnetPrefix()}.0/24`,
      firewall_private_ip: this.config.firewallIp,
      agent_private_ip: this.config.agentIp,
      control_cidr: controlCidr,
      public_key_path: keys.publicKeyPath,
      guest_user: this.config.guestUser,
      desired_instance_state: desiredState,
      agent_instance_type: aws.agentInstanceType,
      firewall_instance_type: aws.firewallInstanceType,
      agent_root_volume_gib: aws.agentRootVolumeGiB,
      firewall_root_volume_gib: aws.firewallRootVolumeGiB,
      nixos_ami_owner_id: aws.nixosAmiOwnerId,
      nixos_ami_name_pattern: aws.nixosAmiNamePattern,
    };
  }

  private ensureControlKey(): { readonly privateKeyPath: string; readonly publicKeyPath: string } {
    const sshDir = join(this.config.instanceDir, "ssh");
    mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    const privateKeyPath = this.controlIdentityPath();
    const publicKeyPath = `${privateKeyPath}.pub`;
    if (!existsSync(privateKeyPath) || !existsSync(publicKeyPath)) {
      runInherited("ssh-keygen", [
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        `rootcell-${this.config.instanceName}`,
        "-f",
        privateKeyPath,
      ], { ignoredOutput: true });
    }
    return { privateKeyPath, publicKeyPath };
  }

  private readOutputs(): AwsEc2TerraformOutputs {
    const raw = JSON.parse(this.runner.outputJson(this.terraformDir(), this.terraformEnv())) as unknown;
    if (raw === null || typeof raw !== "object") {
      throw new Error("invalid terraform output: expected object");
    }
    const object = raw as Record<string, unknown>;
    const flattened: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(object)) {
      if (value !== null && typeof value === "object" && "value" in value) {
        flattened[key] = (value as { readonly value?: unknown }).value;
      }
    }
    return parseSchema(AwsEc2TerraformOutputsSchema, flattened, "invalid AWS EC2 Terraform outputs");
  }

  private destructiveResourceIdsFromState(): {
    readonly ec2ResourceIds: readonly string[];
    readonly keyPairNames: readonly string[];
  } {
    const path = this.terraformStatePath();
    if (!existsSync(path)) {
      return { ec2ResourceIds: [], keyPairNames: [] };
    }
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const state = TerraformStateSchema.safeParse(raw);
    if (!state.success) {
      throw new Error("invalid Terraform state; refusing to destroy AWS resources");
    }
    const ec2ResourceIds: string[] = [];
    const keyPairNames: string[] = [];
    const taggable = new Set([
      "aws_instance",
      "aws_network_interface",
      "aws_eip",
      "aws_vpc",
      "aws_subnet",
      "aws_internet_gateway",
      "aws_route_table",
      "aws_security_group",
      "aws_vpc_security_group_ingress_rule",
      "aws_vpc_security_group_egress_rule",
    ]);
    for (const resource of state.data.resources) {
      if (resource.type === "aws_key_pair") {
        for (const instance of resource.instances) {
          const attributes = instance.attributes as Record<string, unknown>;
          const id = stringAttribute(attributes, "id");
          if (id !== null) {
            keyPairNames.push(id);
          }
        }
        continue;
      }
      if (!taggable.has(resource.type)) {
        continue;
      }
      for (const instance of resource.instances) {
        const attributes = instance.attributes as Record<string, unknown>;
        const id = stringAttribute(attributes, "id");
        if (id !== null) {
          ec2ResourceIds.push(id);
        }
        if (resource.type === "aws_instance") {
          ec2ResourceIds.push(...rootVolumeIds(attributes));
        }
      }
    }
    return { ec2ResourceIds, keyPairNames };
  }

  private resolveControlCidr(): string {
    const configured = this.requireAwsConfig().controlCidr;
    if (configured !== "auto") {
      return configured;
    }
    const result = runCapture("curl", ["-fsSL", "--connect-timeout", "5", "--max-time", "20", "https://checkip.amazonaws.com"]);
    const ip = result.stdout.trim();
    if (!/^[0-9]+(?:\.[0-9]+){3}$/.test(ip)) {
      throw new Error(`failed to resolve current public IPv4 for ${this.config.instanceName}: ${ip}`);
    }
    return `${ip}/32`;
  }

  private terraformEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    loadDotEnv(this.config.envPath, env);
    env.AWS_PROFILE = this.requireAwsConfig().profile;
    env.AWS_REGION = this.requireAwsConfig().region;
    env.AWS_DEFAULT_REGION = this.requireAwsConfig().region;
    return env;
  }

  private ensureTerraform(): string {
    if (this.terraformBin.length === 0) {
      this.terraformBin = resolveHostTool({
        name: "tofu",
        envVar: "ROOTCELL_TERRAFORM",
        purpose: "to manage rootcell AWS EC2 resources",
      });
    }
    return this.terraformBin;
  }

  private requireAwsConfig(): NonNullable<RootcellConfig["awsEc2"]> {
    if (this.config.awsEc2 === undefined) {
      throw new Error("AWS EC2 provider config is missing");
    }
    return this.config.awsEc2;
  }

  private awsDir(): string {
    return join(this.config.instanceDir, "v", "aws-ec2");
  }

  private terraformDir(): string {
    return join(this.awsDir(), "terraform");
  }

  private terraformStatePath(): string {
    return join(this.terraformDir(), "terraform.tfstate");
  }

  private metadataPath(): string {
    return join(this.awsDir(), "metadata.json");
  }

  private subnetPrefix(): string {
    return this.config.firewallIp.slice(0, this.config.firewallIp.lastIndexOf("."));
  }

}

export class TerraformCliRunner implements TerraformRunner {
  constructor(private readonly terraformBin: () => string) {}

  init(cwd: string, env: NodeJS.ProcessEnv): void {
    runInherited(this.terraformBin(), ["init", "-input=false"], { cwd, env });
  }

  apply(cwd: string, env: NodeJS.ProcessEnv): void {
    runInherited(this.terraformBin(), ["apply", "-input=false", "-auto-approve"], { cwd, env });
  }

  destroy(cwd: string, env: NodeJS.ProcessEnv): void {
    runInherited(this.terraformBin(), ["destroy", "-input=false", "-auto-approve"], { cwd, env });
  }

  outputJson(cwd: string, env: NodeJS.ProcessEnv): string {
    return runCapture(this.terraformBin(), ["output", "-json"], { cwd, env }).stdout;
  }
}

const TerraformStateSchema = z.looseObject({
  resources: z.array(z.looseObject({
    type: z.string(),
    instances: z.array(z.looseObject({
      attributes: z.looseObject({
        id: z.unknown().optional(),
      }),
    })),
  })),
});

function stringAttribute(attributes: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = attributes[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function rootVolumeIds(attributes: Readonly<Record<string, unknown>>): readonly string[] {
  const rootBlockDevice = attributes.root_block_device;
  if (!Array.isArray(rootBlockDevice)) {
    return [];
  }
  const ids: string[] = [];
  for (const block of rootBlockDevice) {
    if (block === null || typeof block !== "object" || Array.isArray(block)) {
      continue;
    }
    const volumeId = stringAttribute(block as Record<string, unknown>, "volume_id");
    if (volumeId !== null) {
      ids.push(volumeId);
    }
  }
  return ids;
}

export function ownershipTags(instanceName: string): Record<string, string> {
  return {
    RootcellManaged: "true",
    RootcellInstanceName: instanceName,
  };
}

export function awsEc2TerraformMain(): string {
  return `terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "${AWS_PROVIDER_VERSION}"
    }
  }
}

provider "aws" {
  profile = var.aws_profile
  region  = var.aws_region

  default_tags {
    tags = local.rootcell_tags
  }
}

locals {
  rootcell_tags = {
    RootcellManaged      = "true"
    RootcellInstanceName = var.instance_name
  }
  ssh_public_key = trimspace(file(var.public_key_path))
  rootcell_bootstrap_user_data = <<-ROOTCELL_USER_DATA
#!/bin/sh
set -eu
PATH=/run/current-system/sw/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
user=\${var.guest_user}
home=/home/\${var.guest_user}

if ! getent group users >/dev/null 2>&1; then
  groupadd -r users
fi

if ! id -u "$user" >/dev/null 2>&1; then
  useradd -m -u 501 -g users -G wheel -s /run/current-system/sw/bin/bash "$user"
else
  usermod -a -G wheel "$user"
  mkdir -p "$home"
  chown "$user:users" "$home"
fi

install -d -m 0700 -o "$user" -g users "$home/.ssh"
cat > "$home/.ssh/authorized_keys" <<'ROOTCELL_AUTHORIZED_KEYS'
\${local.ssh_public_key}
ROOTCELL_AUTHORIZED_KEYS
chown "$user:users" "$home/.ssh/authorized_keys"
chmod 0600 "$home/.ssh/authorized_keys"

if ! grep -q "^$user .*NOPASSWD" /etc/sudoers; then
  printf '%s ALL=(ALL:ALL) NOPASSWD: SETENV: ALL\\n' "$user" >> /etc/sudoers
fi
ROOTCELL_USER_DATA
}

data "aws_ami" "nixos_arm64" {
  owners      = [var.nixos_ami_owner_id]
  most_recent = true

  filter {
    name   = "name"
    values = [var.nixos_ami_name_pattern]
  }

  filter {
    name   = "architecture"
    values = ["arm64"]
  }

  filter {
    name   = "root-device-type"
    values = ["ebs"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = false
  enable_dns_hostnames = false
  tags                 = local.rootcell_tags
}

resource "aws_subnet" "private" {
  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 1, 0)
  availability_zone = data.aws_availability_zones.available.names[0]
  tags              = local.rootcell_tags
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 1, 1)
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = false
  tags                    = local.rootcell_tags
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = local.rootcell_tags
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = local.rootcell_tags
}

resource "aws_route" "public_default" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  tags   = local.rootcell_tags
}

resource "aws_route" "private_default" {
  route_table_id         = aws_route_table.private.id
  destination_cidr_block = "0.0.0.0/0"
  network_interface_id   = aws_network_interface.firewall_private.id
  depends_on             = [aws_network_interface_attachment.firewall_private]
}

resource "aws_route_table_association" "private" {
  subnet_id      = aws_subnet.private.id
  route_table_id = aws_route_table.private.id
}

resource "aws_security_group" "firewall_public" {
  name_prefix = "rootcell-\${var.instance_name}-firewall-public-"
  description = "rootcell firewall public SSH"
  vpc_id      = aws_vpc.this.id
  tags        = local.rootcell_tags
}

resource "aws_vpc_security_group_ingress_rule" "firewall_public_ssh" {
  security_group_id = aws_security_group.firewall_public.id
  cidr_ipv4         = var.control_cidr
  from_port         = 22
  ip_protocol       = "tcp"
  to_port           = 22
  tags              = local.rootcell_tags
}

resource "aws_vpc_security_group_egress_rule" "firewall_public_all" {
  security_group_id = aws_security_group.firewall_public.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  tags              = local.rootcell_tags
}

resource "aws_security_group" "firewall_private" {
  name_prefix = "rootcell-\${var.instance_name}-firewall-private-"
  description = "rootcell firewall private policy ingress"
  vpc_id      = aws_vpc.this.id
  tags        = local.rootcell_tags
}

resource "aws_vpc_security_group_ingress_rule" "firewall_private_https" {
  security_group_id            = aws_security_group.firewall_private.id
  referenced_security_group_id = aws_security_group.agent.id
  from_port                    = 443
  ip_protocol                  = "tcp"
  to_port                      = 443
  tags                         = local.rootcell_tags
}

resource "aws_vpc_security_group_ingress_rule" "firewall_private_connect" {
  security_group_id            = aws_security_group.firewall_private.id
  referenced_security_group_id = aws_security_group.agent.id
  from_port                    = 8080
  ip_protocol                  = "tcp"
  to_port                      = 8081
  tags                         = local.rootcell_tags
}

resource "aws_vpc_security_group_ingress_rule" "firewall_private_dns" {
  security_group_id            = aws_security_group.firewall_private.id
  referenced_security_group_id = aws_security_group.agent.id
  from_port                    = 53
  ip_protocol                  = "udp"
  to_port                      = 53
  tags                         = local.rootcell_tags
}

resource "aws_vpc_security_group_egress_rule" "firewall_private_all" {
  security_group_id = aws_security_group.firewall_private.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
  tags              = local.rootcell_tags
}

resource "aws_security_group" "agent" {
  name_prefix = "rootcell-\${var.instance_name}-agent-"
  description = "rootcell agent private-only network"
  vpc_id      = aws_vpc.this.id
  tags        = local.rootcell_tags
}

resource "aws_vpc_security_group_ingress_rule" "agent_ssh_from_firewall" {
  security_group_id            = aws_security_group.agent.id
  referenced_security_group_id = aws_security_group.firewall_private.id
  from_port                    = 22
  ip_protocol                  = "tcp"
  to_port                      = 22
  tags                         = local.rootcell_tags
}

resource "aws_vpc_security_group_egress_rule" "agent_https" {
  security_group_id = aws_security_group.agent.id
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 443
  ip_protocol       = "tcp"
  to_port           = 443
  tags              = local.rootcell_tags
}

resource "aws_vpc_security_group_egress_rule" "agent_connect" {
  security_group_id = aws_security_group.agent.id
  cidr_ipv4         = "\${var.firewall_private_ip}/32"
  from_port         = 8080
  ip_protocol       = "tcp"
  to_port           = 8080
  tags              = local.rootcell_tags
}

resource "aws_vpc_security_group_egress_rule" "agent_dns" {
  security_group_id = aws_security_group.agent.id
  cidr_ipv4         = "\${var.firewall_private_ip}/32"
  from_port         = 53
  ip_protocol       = "udp"
  to_port           = 53
  tags              = local.rootcell_tags
}

resource "aws_key_pair" "control" {
  key_name_prefix = "rootcell-\${var.instance_name}-"
  public_key      = file(var.public_key_path)
  tags            = local.rootcell_tags
}

resource "aws_network_interface" "firewall_public" {
  subnet_id       = aws_subnet.public.id
  security_groups = [aws_security_group.firewall_public.id]
  tags            = local.rootcell_tags
}

resource "aws_network_interface" "firewall_private" {
  subnet_id           = aws_subnet.private.id
  private_ips         = [var.firewall_private_ip]
  security_groups     = [aws_security_group.firewall_private.id]
  source_dest_check   = false
  tags                = local.rootcell_tags
}

resource "aws_network_interface" "agent" {
  subnet_id       = aws_subnet.private.id
  private_ips     = [var.agent_private_ip]
  security_groups = [aws_security_group.agent.id]
  tags            = local.rootcell_tags
}

resource "aws_eip" "firewall" {
  domain = "vpc"
  tags   = local.rootcell_tags
}

resource "aws_eip_association" "firewall" {
  allocation_id        = aws_eip.firewall.id
  network_interface_id = aws_network_interface.firewall_public.id
}

resource "aws_instance" "firewall" {
  ami           = data.aws_ami.nixos_arm64.id
  instance_type = var.firewall_instance_type
  key_name      = aws_key_pair.control.key_name
  user_data     = local.rootcell_bootstrap_user_data

  primary_network_interface {
    network_interface_id = aws_network_interface.firewall_public.id
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    volume_size = var.firewall_root_volume_gib
    volume_type = "gp3"
    tags        = local.rootcell_tags
  }

  tags = local.rootcell_tags
}

resource "aws_network_interface_attachment" "firewall_private" {
  instance_id          = aws_instance.firewall.id
  network_interface_id = aws_network_interface.firewall_private.id
  device_index         = 1
}

resource "aws_instance" "agent" {
  ami           = data.aws_ami.nixos_arm64.id
  instance_type = var.agent_instance_type
  key_name      = aws_key_pair.control.key_name
  user_data     = local.rootcell_bootstrap_user_data

  primary_network_interface {
    network_interface_id = aws_network_interface.agent.id
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    volume_size = var.agent_root_volume_gib
    volume_type = "gp3"
    tags        = local.rootcell_tags
  }

  tags = local.rootcell_tags
}

resource "aws_ec2_instance_state" "firewall" {
  instance_id = aws_instance.firewall.id
  state       = var.desired_instance_state
  depends_on  = [aws_network_interface_attachment.firewall_private]
}

resource "aws_ec2_instance_state" "agent" {
  instance_id = aws_instance.agent.id
  state       = var.desired_instance_state
}
`;
}

export function awsEc2TerraformVariables(): string {
  return `variable "aws_profile" { type = string }
variable "aws_region" { type = string }
variable "instance_name" { type = string }
variable "rootcell_instance_id" { type = string }
variable "vpc_cidr" { type = string }
variable "firewall_private_ip" { type = string }
variable "agent_private_ip" { type = string }
variable "control_cidr" { type = string }
variable "public_key_path" { type = string }
variable "guest_user" { type = string }
variable "desired_instance_state" {
  type = string
  validation {
    condition     = contains(["running", "stopped"], var.desired_instance_state)
    error_message = "desired_instance_state must be running or stopped."
  }
}
variable "agent_instance_type" { type = string }
variable "firewall_instance_type" { type = string }
variable "agent_root_volume_gib" { type = number }
variable "firewall_root_volume_gib" { type = number }
variable "nixos_ami_owner_id" { type = string }
variable "nixos_ami_name_pattern" { type = string }
`;
}

export function awsEc2TerraformOutputs(): string {
  return `output "agent_instance_id" { value = aws_instance.agent.id }
output "firewall_instance_id" { value = aws_instance.firewall.id }
output "firewall_public_ip" { value = aws_eip.firewall.public_ip }
output "agent_private_ip" { value = var.agent_private_ip }
output "firewall_private_ip" { value = var.firewall_private_ip }
output "nixos_ami_id" { value = data.aws_ami.nixos_arm64.id }
output "nixos_ami_name" { value = data.aws_ami.nixos_arm64.name }
output "applied_control_cidr" { value = var.control_cidr }
`;
}
