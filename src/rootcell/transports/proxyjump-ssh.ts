import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRootcellGuestCopyPath, rootcellGuestCopyPath } from "../copy.ts";
import { runAsyncInherited, runCapture, runInherited } from "../process.ts";
import type { RootcellConfig } from "../types.ts";
import type { CopyOptions, CopyToGuestOptions, ExecOptions, LocalPortForwardHandle, LocalPortForwardOptions } from "../providers/types.ts";
import type { CommandResult, InheritedCommandResult } from "../types.ts";
import type { GuestTransport } from "./types.ts";

const SSH_CONNECT_TIMEOUT_SECONDS = 15;

export interface ProxyJumpSshEndpoints {
  readonly firewallHost: string;
  readonly firewallPort?: number;
  readonly agentHost: string;
  readonly identityPath: string;
  readonly knownHostsPath: string;
}

export class ProxyJumpSshTransport implements GuestTransport {
  readonly id = "proxyjump-ssh";

  constructor(
    private readonly config: RootcellConfig,
    private readonly endpoints: () => ProxyJumpSshEndpoints,
  ) {}

  exec(name: string, command: readonly string[], options: ExecOptions = {}): Promise<InheritedCommandResult> {
    const result = runInherited("ssh", [
      ...this.sshArgs(name),
      remoteCommand(command, options),
    ], inheritOptions(options));
    return Promise.resolve(result);
  }

  execCapture(name: string, command: readonly string[], options: ExecOptions = {}): Promise<CommandResult> {
    const result = runCapture("ssh", [
      ...this.sshArgs(name),
      remoteCommand(command, options),
    ], {
      allowFailure: options.allowFailure ?? false,
    });
    return Promise.resolve(result);
  }

  async execInteractive(name: string, command: readonly string[], options: ExecOptions = {}): Promise<number> {
    return await runAsyncInherited("ssh", [
      "-t",
      ...this.sshArgs(name),
      remoteCommand(command, options),
    ]);
  }

  copy(name: string, sources: readonly string[], target: string, options: CopyOptions = {}): Promise<void> {
    runInherited("scp", [
      "-F",
      this.writeSshConfig(),
      ...(options.recursive === true ? ["-r"] : []),
      ...sources.map((source) => this.copyOperand(name, source)),
      this.copyOperand(name, target),
    ]);
    return Promise.resolve();
  }

  copyToGuest(name: string, hostPath: string, guestPath: string, options: CopyToGuestOptions = {}): Promise<void> {
    return this.copy(name, [hostPath], `:${guestPath}`, options);
  }

  async forwardLocalPort(name: string, options: LocalPortForwardOptions): Promise<LocalPortForwardHandle> {
    const child = spawn("ssh", [
      "-F",
      this.writeSshConfig(),
      "-N",
      "-L",
      `${options.localHost}:${String(options.localPort)}:${options.remoteHost}:${String(options.remotePort)}`,
      "-o",
      "ExitOnForwardFailure=yes",
      this.aliasFor(name),
    ], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const closed = new Promise<number>((resolve) => {
      child.on("close", (code, signal) => {
        resolve(code ?? statusFromSignal(signal));
      });
    });

    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        child.removeListener("error", onError);
        child.removeListener("close", onClose);
        if (error === undefined) {
          resolve();
          return;
        }
        reject(error);
      };
      const onError = (error: Error): void => {
        finish(error);
      };
      const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
        const status = code ?? statusFromSignal(signal);
        const detail = stderr.trim();
        finish(new Error(`SSH local port forward failed with exit ${String(status)}${detail.length === 0 ? "" : `: ${detail}`}`));
      };
      const timer = setTimeout(() => {
        finish();
      }, 500);
      child.once("error", onError);
      child.once("close", onClose);
    });

    return {
      ...options,
      closed,
      close: async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          await closed;
          return;
        }
        child.kill("SIGTERM");
        const killTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, 2_000);
        try {
          await closed;
        } finally {
          clearTimeout(killTimer);
        }
      },
    };
  }

  forgetHostKey(name: string): void {
    const endpoints = this.endpoints();
    const host = name === this.config.firewallVm ? endpoints.firewallHost : name === this.config.agentVm ? endpoints.agentHost : null;
    if (host === null) {
      throw new Error(`unknown rootcell VM for SSH transport: ${name}`);
    }
    forgetKnownHost(
      endpoints.knownHostsPath,
      host,
      name === this.config.firewallVm ? endpoints.firewallPort : undefined,
    );
  }

  private sshArgs(name: string): readonly string[] {
    return [
      "-F",
      this.writeSshConfig(),
      this.aliasFor(name),
    ];
  }

  private aliasFor(name: string): string {
    if (name === this.config.firewallVm) {
      return "rootcell-firewall";
    }
    if (name === this.config.agentVm) {
      return "rootcell-agent";
    }
    throw new Error(`unknown rootcell VM for SSH transport: ${name}`);
  }

  private copyOperand(name: string, operand: string): string {
    if (!isRootcellGuestCopyPath(operand)) {
      return operand;
    }
    return `${this.aliasFor(name)}:${rootcellGuestCopyPath(operand)}`;
  }

  private writeSshConfig(): string {
    const endpoints = this.endpoints();
    const sshDir = join(this.config.instanceDir, "ssh");
    mkdirSync(sshDir, { recursive: true, mode: 0o700 });
    const path = join(sshDir, "config");
    const content = sshConfig({
      user: this.config.guestUser,
      firewallHost: endpoints.firewallHost,
      ...(endpoints.firewallPort === undefined ? {} : { firewallPort: endpoints.firewallPort }),
      agentHost: endpoints.agentHost,
      identityPath: endpoints.identityPath,
      knownHostsPath: endpoints.knownHostsPath,
    });
    writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
    return path;
  }
}

export function forgetKnownHost(knownHostsPath: string, host: string, port?: number): void {
  if (!existsSync(knownHostsPath)) {
    return;
  }
  const original = readFileSync(knownHostsPath, "utf8");
  const lines = original.split(/\r?\n/);
  const kept = lines.filter((line) => !knownHostsLineMatchesHost(line, host, port));
  if (kept.length === lines.length) {
    return;
  }
  writeFileSync(knownHostsPath, kept.join("\n"), { encoding: "utf8", mode: 0o600 });
}

function statusFromSignal(signal: NodeJS.Signals | null): number {
  if (signal === "SIGINT") {
    return 130;
  }
  if (signal === "SIGTERM") {
    return 143;
  }
  return 1;
}

function knownHostsLineMatchesHost(line: string, host: string, port?: number): boolean {
  const trimmed = line.trimStart();
  if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("|")) {
    return false;
  }
  const marker = trimmed.split(/\s+/, 1)[0];
  if (marker === undefined) {
    return false;
  }
  return marker.split(",").some((candidate) => candidate === host || candidate === `[${host}]:${String(port ?? 22)}`);
}

function inheritOptions(options: ExecOptions): { readonly allowFailure?: boolean; readonly ignoredOutput?: boolean } {
  return {
    ...(options.allowFailure === undefined ? {} : { allowFailure: options.allowFailure }),
    ...(options.ignoredOutput === undefined ? {} : { ignoredOutput: options.ignoredOutput }),
  };
}

export function sshConfig(input: {
  readonly user: string;
  readonly firewallHost: string;
  readonly firewallPort?: number;
  readonly agentHost: string;
  readonly identityPath: string;
  readonly knownHostsPath: string;
  readonly controlPath?: string;
}): string {
  const multiplexing = input.controlPath === undefined
    ? []
    : [
      "  ControlMaster auto",
      "  ControlPersist 60s",
      `  ControlPath ${sshConfigValue(input.controlPath)}`,
    ];
  return [
    "Host rootcell-firewall",
    `  HostName ${sshConfigValue(input.firewallHost)}`,
    ...(input.firewallPort === undefined ? [] : [`  Port ${String(input.firewallPort)}`]),
    `  User ${sshConfigValue(input.user)}`,
    `  IdentityFile ${sshConfigValue(input.identityPath)}`,
    `  UserKnownHostsFile ${sshConfigValue(input.knownHostsPath)}`,
    ...multiplexing,
    "  StrictHostKeyChecking accept-new",
    "  IdentitiesOnly yes",
    "  BatchMode yes",
    "  PasswordAuthentication no",
    "  KbdInteractiveAuthentication no",
    `  ConnectTimeout ${String(SSH_CONNECT_TIMEOUT_SECONDS)}`,
    "  ServerAliveInterval 5",
    "  ServerAliveCountMax 3",
    "  LogLevel ERROR",
    "",
    "Host rootcell-agent",
    `  HostName ${sshConfigValue(input.agentHost)}`,
    `  User ${sshConfigValue(input.user)}`,
    `  ProxyCommand ${proxyCommand(input)}`,
    `  IdentityFile ${sshConfigValue(input.identityPath)}`,
    `  UserKnownHostsFile ${sshConfigValue(input.knownHostsPath)}`,
    ...multiplexing,
    "  StrictHostKeyChecking accept-new",
    "  IdentitiesOnly yes",
    "  BatchMode yes",
    "  PasswordAuthentication no",
    "  KbdInteractiveAuthentication no",
    `  ConnectTimeout ${String(SSH_CONNECT_TIMEOUT_SECONDS)}`,
    "  ServerAliveInterval 5",
    "  ServerAliveCountMax 3",
    "  LogLevel ERROR",
    "",
  ].join("\n");
}

export function sshConfigValue(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) {
    return value;
  }
  if (/[\r\n]/.test(value)) {
    throw new Error("SSH config values must not contain newlines");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function proxyCommand(input: {
  readonly user: string;
  readonly firewallHost: string;
  readonly firewallPort?: number;
  readonly identityPath: string;
  readonly knownHostsPath: string;
}): string {
  return [
    "ssh",
    "-F",
    "/dev/null",
    "-W",
    "%h:%p",
    ...(input.firewallPort === undefined ? [] : ["-p", String(input.firewallPort)]),
    "-l",
    input.user,
    "-i",
    input.identityPath,
    "-o",
    `UserKnownHostsFile=${input.knownHostsPath}`,
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    `ConnectTimeout=${String(SSH_CONNECT_TIMEOUT_SECONDS)}`,
    "-o",
    "ServerAliveInterval=5",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "LogLevel=ERROR",
    input.firewallHost,
  ].map(shellQuote).join(" ");
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

export function guestTransportPath(config: RootcellConfig, ...parts: readonly string[]): string {
  return join(config.instanceDir, ...parts);
}

export function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}
