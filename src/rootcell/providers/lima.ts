import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { resolveHostTool } from "../host-tools.ts";
import { runAsyncInherited, runCapture, runInherited } from "../process.ts";
import { NonEmptyStringSchema, parseSchema, PositiveSafeIntegerSchema } from "../schema.ts";
import { forgetKnownHost, ProxyJumpSshTransport, type ProxyJumpSshEndpoints } from "../transports/proxyjump-ssh.ts";
import type { RootcellConfig } from "../types.ts";
import type { CommandResult, InheritedCommandResult } from "../types.ts";
import type { LimaUserV2NetworkAttachment } from "./macos-lima-user-v2-network.ts";
import type { CopyToGuestOptions, ExecOptions, VmProvider, VmRole, VmStatus } from "./types.ts";

const LimaProviderSchema = z.custom<"lima">((value) => value === "lima", { message: "provider mismatch" });
const LimaVmRoleSchema = z.custom<VmRole>(
  (value) => value === "agent" || value === "firewall",
  { message: "role mismatch" },
);

const LimaVmStateSchema = z.object({
  provider: LimaProviderSchema,
  name: NonEmptyStringSchema,
  role: LimaVmRoleSchema,
  limaInstance: NonEmptyStringSchema,
  yamlPath: NonEmptyStringSchema,
  privateInterface: NonEmptyStringSchema,
  egressInterface: NonEmptyStringSchema.optional(),
  privateIp: NonEmptyStringSchema,
  networkName: NonEmptyStringSchema,
  hasEgress: z.boolean(),
  sshLocalPort: PositiveSafeIntegerSchema.optional(),
  userV2Ready: z.boolean().optional(),
});

type LimaVmState = Readonly<z.infer<typeof LimaVmStateSchema>>;

export const NIXOS_LIMA_AARCH64_IMAGE = {
  location: "https://github.com/nixos-lima/nixos-lima/releases/download/v0.0.5/nixos-lima-v0.0.5-aarch64.qcow2",
  arch: "aarch64",
  digest: "sha512:e1daeb0dcec65c624253603ab5ec06f0831b0940cd95a88903f9bfd0ee4009b2c45806b868674c7e8cb12941e50799e85d710fc0e9ad659059108cebbc4d19c1",
} as const;

const NIXOS_LIMA_UPSTREAM_YAML = `# Template using latest released nixos-lima images 
images:
  - location: "https://github.com/nixos-lima/nixos-lima/releases/download/v0.0.5/nixos-lima-v0.0.5-aarch64.qcow2"
    arch: "aarch64"
    digest: "sha512:e1daeb0dcec65c624253603ab5ec06f0831b0940cd95a88903f9bfd0ee4009b2c45806b868674c7e8cb12941e50799e85d710fc0e9ad659059108cebbc4d19c1"
  - location: "https://github.com/nixos-lima/nixos-lima/releases/download/v0.0.5/nixos-lima-v0.0.5-x86_64.qcow2"
    arch: "x86_64"
    digest: "sha512:51fbe74c569736f1141f1c6efeaa21a0901dff0bec5bc1e863c04c7765e150c3bebd82b7f50905fb7a0a9a9b050852c250ffbdcacd17b0dc15aeb86d47587436"

mounts:
- location: "~"
  writable: false
  9p:
    # Try choosing "mmap" or "none" if you see a stability issue with the default "fscache".
    cache: "mmap"
- location: "/tmp/lima"
  writable: true
  9p:
    cache: "mmap"

memory: 8GiB

portForwards:
  # Tell Lima's port-forwarding to ignore port 68 to prevent interception of host DHCP packets
  # Apparently this is an issue with NixOS that does not occur on other Linux distros
  # See: https://github.com/nixos-lima/nixos-lima/issues/50
  - proto: udp
    guestPort: 68
    guestIP: 0.0.0.0
    ignore: true

containerd:
  system: false
  user: false
`;

export class LimaVmProvider implements VmProvider<LimaUserV2NetworkAttachment> {
  readonly id = "lima";
  private limactlBin = "";
  private readonly transport: ProxyJumpSshTransport;

  constructor(
    private readonly config: RootcellConfig,
    private readonly log: (message: string) => void,
  ) {
    this.transport = new ProxyJumpSshTransport(config, () => this.transportEndpoints());
  }

  status(name: string): Promise<VmStatus> {
    const entry = this.limaListEntry(name);
    if (entry === null) {
      return Promise.resolve({ state: "missing" });
    }
    const rawStatus = entry.status ?? entry.Status;
    const status = typeof rawStatus === "string" ? rawStatus.toLowerCase() : "";
    if (status === "running") {
      return Promise.resolve({ state: "running" });
    }
    if (status === "stopped") {
      return Promise.resolve({ state: "stopped" });
    }
    return Promise.resolve({ state: "unexpected", detail: status.length === 0 ? "unknown Lima status" : status });
  }

  async forceStopIfRunning(name: string): Promise<void> {
    if ((await this.status(name)).state !== "running") {
      return;
    }
    this.log(`stopping ${name} Lima VM...`);
    runInherited(this.ensureLimactl(), ["--tty=false", "stop", "--force", name], {
      allowFailure: true,
    });
  }

  async remove(name: string): Promise<void> {
    await this.forceStopIfRunning(name);
    runInherited(this.ensureLimactl(), ["--tty=false", "delete", "--force", name], {
      allowFailure: true,
      ignoredOutput: true,
    });
    rmSync(this.vmDir(name), { recursive: true, force: true });
  }

  assertCompatible(name: string, network: LimaUserV2NetworkAttachment): Promise<void> {
    const state = this.readVmState(name);
    if (state === null) {
      return Promise.resolve();
    }
    if (
      state.privateInterface !== network.privateInterface
      || state.egressInterface !== network.egressInterface
      || state.privateIp !== network.privateIp
      || state.networkName !== network.networkName
      || state.hasEgress !== network.hasEgress
    ) {
      throw new Error(`${name} exists with incompatible Lima network attachments; delete and recreate it`);
    }
    return Promise.resolve();
  }

  async ensureRunning(input: {
    readonly role: VmRole;
    readonly name: string;
    readonly network: LimaUserV2NetworkAttachment;
  }): Promise<{ readonly created: boolean }> {
    this.ensureLimactl();
    const status = await this.status(input.name);
    switch (status.state) {
      case "running":
        this.refreshVmState(input);
        await this.waitForLimaSsh(input.name);
        return { created: false };
      case "stopped":
        this.log(`starting ${input.name} Lima VM...`);
        this.startVm(input);
        await this.waitForLimaSsh(input.name);
        return { created: false };
      case "missing":
        this.log(`${input.name} Lima VM not found; creating from nixos-lima image...`);
        this.createVm(input);
        await this.forgetSshHostKey(input.name);
        await this.waitForLimaSsh(input.name);
        return { created: true };
      case "unexpected":
        throw new Error(`${input.name} VM in unexpected state: ${status.detail}`);
    }
  }

  async finalizeNetworking(input: {
    readonly role: VmRole;
    readonly name: string;
    readonly network: LimaUserV2NetworkAttachment;
  }): Promise<void> {
    if (input.role !== "agent") {
      this.refreshVmState(input);
      return;
    }
    await this.waitForFinalSsh(input.name);
    await this.proveUserV2IfAgent(input);
    this.refreshVmState(input, { userV2Ready: true });
  }

  exec(name: string, command: readonly string[], options: ExecOptions = {}): Promise<InheritedCommandResult> {
    if (this.shouldUseBootstrapSsh(name)) {
      return this.execBootstrap(name, command, options);
    }
    return this.transport.exec(name, command, options);
  }

  execCapture(name: string, command: readonly string[], options: ExecOptions = {}): Promise<CommandResult> {
    if (this.shouldUseBootstrapSsh(name)) {
      return this.execBootstrapCapture(name, command, options);
    }
    return this.transport.execCapture(name, command, options);
  }

  async execInteractive(name: string, command: readonly string[], options: ExecOptions = {}): Promise<number> {
    if (this.shouldUseBootstrapSsh(name)) {
      return await this.execBootstrapInteractive(name, command, options);
    }
    return await this.transport.execInteractive(name, command, options);
  }

  copyToGuest(name: string, hostPath: string, guestPath: string, options: CopyToGuestOptions = {}): Promise<void> {
    if (this.shouldUseBootstrapSsh(name)) {
      return this.copyToGuestBootstrap(name, hostPath, guestPath, options);
    }
    return this.transport.copyToGuest(name, hostPath, guestPath, options);
  }

  forgetSshHostKey(name: string): Promise<void> {
    this.transport.forgetHostKey(name);
    const state = this.readVmState(name);
    if (state?.sshLocalPort !== undefined) {
      forgetKnownHost(this.knownHostsPath(), "127.0.0.1", state.sshLocalPort);
    }
    return Promise.resolve();
  }

  private createVm(input: { readonly role: VmRole; readonly name: string; readonly network: LimaUserV2NetworkAttachment }): void {
    mkdirSync(this.vmDir(input.name), { recursive: true, mode: 0o700 });
    const yamlPath = this.writeLimaYaml(input);
    runInherited(this.ensureLimactl(), ["--tty=false", "create", "--name", input.name, yamlPath]);
    this.startVm(input);
  }

  private shouldUseBootstrapSsh(name: string): boolean {
    return name === this.config.agentVm && this.readVmState(name)?.userV2Ready !== true;
  }

  private execBootstrap(name: string, command: readonly string[], options: ExecOptions = {}): Promise<InheritedCommandResult> {
    const result = runInherited("ssh", [
      "-F",
      this.writeBootstrapSshConfig(name),
      this.bootstrapAlias(name),
      remoteCommand(command, options),
    ], inheritOptions(options));
    return Promise.resolve(result);
  }

  private execBootstrapCapture(name: string, command: readonly string[], options: ExecOptions = {}): Promise<CommandResult> {
    const result = runCapture("ssh", [
      "-F",
      this.writeBootstrapSshConfig(name),
      this.bootstrapAlias(name),
      remoteCommand(command, options),
    ], {
      allowFailure: options.allowFailure ?? false,
    });
    return Promise.resolve(result);
  }

  private async execBootstrapInteractive(name: string, command: readonly string[], options: ExecOptions = {}): Promise<number> {
    return await runAsyncInherited("ssh", [
      "-t",
      "-F",
      this.writeBootstrapSshConfig(name),
      this.bootstrapAlias(name),
      remoteCommand(command, options),
    ]);
  }

  private copyToGuestBootstrap(name: string, hostPath: string, guestPath: string, options: CopyToGuestOptions = {}): Promise<void> {
    runInherited("scp", [
      "-F",
      this.writeBootstrapSshConfig(name),
      ...(options.recursive === true ? ["-r"] : []),
      hostPath,
      `${this.bootstrapAlias(name)}:${guestPath}`,
    ]);
    return Promise.resolve();
  }

  private writeBootstrapSshConfig(name: string): string {
    const sshDir = join(this.config.instanceDir, "ssh");
    mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    const path = join(sshDir, `${this.vmRoleDir(name)}-bootstrap.config`);
    writeFileSync(path, directSshConfig({
      hostAlias: this.bootstrapAlias(name),
      user: this.config.guestUser,
      host: "127.0.0.1",
      port: this.bootstrapSshPort(name),
      identityPath: this.identityPath(),
      knownHostsPath: this.knownHostsPath(),
    }), { encoding: "utf8", mode: 0o600 });
    return path;
  }

  private bootstrapAlias(name: string): string {
    return name === this.config.agentVm ? "rootcell-agent-bootstrap" : "rootcell-firewall-bootstrap";
  }

  private bootstrapSshPort(name: string): number {
    return this.readVmState(name)?.sshLocalPort ?? this.sshLocalPort(name);
  }

  private startVm(input: { readonly role: VmRole; readonly name: string; readonly network: LimaUserV2NetworkAttachment }): void {
    runInherited(this.ensureLimactl(), ["--tty=false", "start", input.name]);
    this.refreshVmState(input);
  }

  private refreshVmState(
    input: { readonly role: VmRole; readonly name: string; readonly network: LimaUserV2NetworkAttachment },
    overrides: { readonly userV2Ready?: boolean } = {},
  ): void {
    const previous = this.readVmState(input.name);
    const state: LimaVmState = {
      provider: "lima",
      name: input.name,
      role: input.role,
      limaInstance: input.network.limaInstance,
      yamlPath: this.yamlPath(input.name),
      privateInterface: input.network.privateInterface,
      ...(input.network.egressInterface === undefined ? {} : { egressInterface: input.network.egressInterface }),
      privateIp: input.network.privateIp,
      networkName: input.network.networkName,
      hasEgress: input.network.hasEgress,
      sshLocalPort: this.sshLocalPort(input.name),
      ...(input.role === "agent" && (overrides.userV2Ready ?? previous?.userV2Ready) === true ? { userV2Ready: true } : {}),
    };
    this.writeVmState(input.name, state);
  }

  private writeLimaYaml(input: {
    readonly role: VmRole;
    readonly name: string;
    readonly network: LimaUserV2NetworkAttachment;
  }): string {
    const path = this.yamlPath(input.name);
    writeFileSync(path, limaYaml({
      role: input.role,
      user: this.config.guestUser,
      instanceName: this.config.instanceName,
      cpus: input.role === "agent" ? 8 : 2,
      memoryGiB: input.role === "agent" ? 16 : 4,
      diskGiB: input.role === "agent" ? 60 : 16,
      network: input.network,
      firewallIp: this.config.firewallIp,
      agentIp: this.config.agentIp,
      networkPrefix: this.config.networkPrefix,
    }), { encoding: "utf8", mode: 0o600 });
    return path;
  }

  private async waitForLimaSsh(name: string): Promise<void> {
    let lastError = "";
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const result = await this.execBootstrapCapture(name, ["true"], {
        allowFailure: true,
      });
      if (result.status === 0) {
        return;
      }
      const message = `${result.stderr}${result.stdout}`.trim();
      if (message.length > 0) {
        lastError = message;
      }
      if (/Operation not permitted/i.test(message)) {
        throw new Error(`host cannot connect to Lima SSH endpoint for ${name}: ${message}`);
      }
      await sleep(500);
    }
    throw new Error(`timeout waiting for SSH transport to ${name}${lastError.length === 0 ? "" : `: ${lastError}`}`);
  }

  private async waitForFinalSsh(name: string): Promise<void> {
    let lastError = "";
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const result = await this.transport.execCapture(name, ["true"], {
        allowFailure: true,
      });
      if (result.status === 0) {
        return;
      }
      const message = `${result.stderr}${result.stdout}`.trim();
      if (message.length > 0) {
        lastError = message;
      }
      await sleep(500);
    }
    throw new Error(`timeout waiting for final SSH transport to ${name}${lastError.length === 0 ? "" : `: ${lastError}`}`);
  }

  private async proveUserV2IfAgent(input: {
    readonly role: VmRole;
    readonly name: string;
    readonly network: LimaUserV2NetworkAttachment;
  }): Promise<void> {
    if (input.role !== "agent") {
      return;
    }
    const script = userV2ProofScript({
      agentIp: this.config.agentIp,
      firewallIp: this.config.firewallIp,
      networkPrefix: this.config.networkPrefix,
      agentPrivateInterface: input.network.privateInterface,
    });
    const result = await this.transport.exec(this.config.agentVm, ["sudo", "bash", "-lc", script], {
      allowFailure: true,
      ignoredOutput: true,
    });
    if (result.status !== 0) {
      throw new Error("Lima user-v2 proof gate failed: agent has a bypass network path or the private route is not established");
    }
  }

  private transportEndpoints(): ProxyJumpSshEndpoints {
    const firewall = this.readVmState(this.config.firewallVm);
    if (firewall?.sshLocalPort === undefined) {
      throw new Error("firewall Lima SSH local port is not known yet");
    }
    return {
      firewallHost: "127.0.0.1",
      firewallPort: firewall.sshLocalPort,
      agentHost: this.config.agentIp,
      identityPath: this.identityPath(),
      knownHostsPath: this.knownHostsPath(),
    };
  }

  private limaListEntry(name: string): Record<string, unknown> | null {
    const result = runCapture(this.ensureLimactl(), ["list", "--format", "json", name], {
      allowFailure: true,
    });
    if (result.status !== 0 || result.stdout.trim().length === 0) {
      return null;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      return null;
    }
    const entries = Array.isArray(raw) ? raw : [raw];
    for (const entry of entries) {
      if (entry !== null && typeof entry === "object") {
        const object = entry as Record<string, unknown>;
        if (object.name === name || object.Name === name) {
          return object;
        }
      }
    }
    return null;
  }

  private sshLocalPort(name: string): number {
    const result = runCapture(this.ensureLimactl(), ["list", "--format", "{{.SSHLocalPort}}", name]);
    const port = Number(result.stdout.trim());
    if (!Number.isSafeInteger(port) || port <= 0) {
      throw new Error(`invalid Lima SSH local port for ${name}: ${result.stdout.trim()}`);
    }
    return port;
  }

  private ensureLimactl(): string {
    if (this.limactlBin.length === 0) {
      this.limactlBin = resolveHostTool({
        name: "limactl",
        envVars: ["ROOTCELL_LIMACTL", "LIMACTL"],
        purpose: "to manage rootcell VMs with Lima",
      });
    }
    return this.limactlBin;
  }

  private readVmState(name: string): LimaVmState | null {
    const path = this.statePath(name);
    if (!existsSync(path)) {
      return null;
    }
    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      return parseLimaVmState(raw);
    } catch {
      return null;
    }
  }

  private writeVmState(name: string, state: LimaVmState): void {
    writeFileSync(this.statePath(name), `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  private vmDir(name: string): string {
    return join(this.config.instanceDir, "v", this.vmRoleDir(name));
  }

  private statePath(name: string): string {
    return join(this.vmDir(name), "state.json");
  }

  private yamlPath(name: string): string {
    return join(this.vmDir(name), "lima.yaml");
  }

  private identityPath(): string {
    return join(limaHome(), "_config", "user");
  }

  private knownHostsPath(): string {
    return join(this.config.instanceDir, "ssh", "known_hosts");
  }

  private vmRoleDir(name: string): "a" | "f" {
    if (name === this.config.agentVm) {
      return "a";
    }
    if (name === this.config.firewallVm) {
      return "f";
    }
    throw new Error(`unknown rootcell VM for Lima provider: ${name}`);
  }
}

export function limaYaml(input: {
  readonly role: VmRole;
  readonly user: string;
  readonly instanceName: string;
  readonly cpus: number;
  readonly memoryGiB: number;
  readonly diskGiB: number;
  readonly network: LimaUserV2NetworkAttachment;
  readonly firewallIp: string;
  readonly agentIp: string;
  readonly networkPrefix: string;
}): string {
  const egressInterface = input.network.egressInterface ?? "enp0s2";
  let yaml = NIXOS_LIMA_UPSTREAM_YAML;
  yaml = replaceTopLevelYamlBlock(yaml, "mounts", ["mounts: []", ""]);
  yaml = replaceTopLevelYamlBlock(yaml, "ssh", [
    "ssh:",
    "  overVsock: true",
  ]);
  yaml = replaceTopLevelYamlBlock(yaml, "user", [
    "user:",
    `  name: ${yamlString(input.user)}`,
    `  home: ${yamlString(`/home/${input.user}`)}`,
  ]);
  yaml = replaceTopLevelYamlBlock(yaml, "networks", [
    "networks:",
    ...(input.network.hasEgress ? [
      "  - vzNAT: true",
      `    interface: ${yamlString(egressInterface)}`,
    ] : []),
    `  - lima: ${yamlString(input.network.networkName)}`,
    `    interface: ${yamlString(input.network.privateInterface)}`,
  ]);
  return [
    "# Generated by rootcell from nixos-lima v0.0.5 nixos.yaml. DO NOT EDIT.",
    stripTrailingBlankLine(yaml),
    "",
  ].join("\n");
}

export function userV2ProofScript(input: {
  readonly agentIp: string;
  readonly firewallIp: string;
  readonly networkPrefix: string;
  readonly agentPrivateInterface: string;
}): string {
  return [
    "set -euo pipefail",
    `agent_ip=${shellQuote(input.agentIp)}`,
    `firewall_ip=${shellQuote(input.firewallIp)}`,
    `prefix=${shellQuote(input.networkPrefix)}`,
    `iface=${shellQuote(input.agentPrivateInterface)}`,
    "test -d \"/sys/class/net/$iface\"",
    "test \"$(find /sys/class/net -mindepth 1 -maxdepth 1 ! -name lo | wc -l | tr -d ' ')\" = 1",
    "ip -4 addr show dev \"$iface\" | grep -q \" $agent_ip/$prefix\"",
    "test \"$(ip route show default | wc -l | tr -d ' ')\" = 1",
    "ip route show default | grep -q \"^default via $firewall_ip dev $iface\\b\"",
    "! ip -4 -o addr show scope global | grep -v \" $agent_ip/$prefix\" | grep -q .",
    "! ip route show default | grep -qv \"via $firewall_ip dev $iface\"",
    "ping -c 1 -W 2 \"$firewall_ip\" >/dev/null",
    "",
  ].join("\n");
}

export function parseLimaVmState(raw: unknown): LimaVmState {
  return parseSchema(LimaVmStateSchema, raw, "invalid Lima VM state");
}

function replaceTopLevelYamlBlock(yaml: string, key: string, replacement: readonly string[]): string {
  const lines = stripTrailingBlankLine(yaml).split("\n");
  const start = lines.findIndex((line) => line === `${key}:` || line.startsWith(`${key}: `));
  if (start === -1) {
    return [
      stripTrailingBlankLine(yaml),
      "",
      ...replacement,
      "",
    ].join("\n");
  }
  let end = start + 1;
  while (end < lines.length && !isTopLevelYamlKey(lines[end] ?? "")) {
    end += 1;
  }
  return [
    ...lines.slice(0, start),
    ...replacement,
    ...lines.slice(end),
  ].join("\n");
}

function isTopLevelYamlKey(line: string): boolean {
  return /^[A-Za-z0-9_-]+:/.test(line);
}

function stripTrailingBlankLine(value: string): string {
  return value.replace(/\n+$/, "");
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function directSshConfig(input: {
  readonly hostAlias: string;
  readonly user: string;
  readonly host: string;
  readonly port: number;
  readonly identityPath: string;
  readonly knownHostsPath: string;
}): string {
  return [
    `Host ${input.hostAlias}`,
    `  HostName ${input.host}`,
    `  Port ${String(input.port)}`,
    `  User ${input.user}`,
    `  IdentityFile ${input.identityPath}`,
    `  UserKnownHostsFile ${input.knownHostsPath}`,
    "  StrictHostKeyChecking accept-new",
    "  NoHostAuthenticationForLocalhost yes",
    "  IdentitiesOnly yes",
    "  BatchMode yes",
    "  PasswordAuthentication no",
    "  KbdInteractiveAuthentication no",
    "  ConnectTimeout 5",
    "  ServerAliveInterval 5",
    "  ServerAliveCountMax 3",
    "  LogLevel ERROR",
    "",
  ].join("\n");
}

function inheritOptions(options: ExecOptions): { readonly allowFailure?: boolean; readonly ignoredOutput?: boolean } {
  return {
    ...(options.allowFailure === undefined ? {} : { allowFailure: options.allowFailure }),
    ...(options.ignoredOutput === undefined ? {} : { ignoredOutput: options.ignoredOutput }),
  };
}

function remoteCommand(command: readonly string[], options: ExecOptions): string {
  const full = options.env === undefined || options.env.length === 0
    ? command
    : ["env", ...options.env, ...command];
  return full.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  });
}

function limaHome(): string {
  const configured = process.env.LIMA_HOME;
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }
  const home = process.env.HOME;
  if (home !== undefined && home.length > 0) {
    return join(home, ".lima");
  }
  return join(homedir(), ".lima");
}
