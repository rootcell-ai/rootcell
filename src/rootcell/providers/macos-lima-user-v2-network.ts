import { createHash } from "node:crypto";
import { resolveHostTool } from "../host-tools.ts";
import { runCapture } from "../process.ts";
import type { RootcellConfig } from "../types.ts";
import { assertLimactlSupportsSshOverVsockYaml } from "./lima-version.ts";
import type { NetworkPlan, NetworkProvider, VmNetworkAttachment, VmRole } from "./types.ts";

export interface LimaUserV2NetworkAttachment extends VmNetworkAttachment {
  readonly kind: "lima-user-v2";
  readonly role: VmRole;
  readonly limaInstance: string;
  readonly networkName: string;
  readonly privateInterface: string;
  readonly egressInterface?: string;
  readonly privateIp: string;
  readonly gatewayIp: string;
  readonly dnsIp: string;
  readonly reservedIps: readonly string[];
  readonly hasEgress: boolean;
}

export class MacOsLimaUserV2NetworkProvider implements NetworkProvider<LimaUserV2NetworkAttachment> {
  readonly id = "macos-lima-user-v2";
  private limactlBin = "";

  constructor(
    private readonly config: RootcellConfig,
    private readonly log: (message: string) => void,
  ) {}

  plan(): NetworkPlan<LimaUserV2NetworkAttachment> {
    const reservedIps = limaUserV2ReservedIps(this.config);
    const agentPrivateInterface = "enp0s1";
    const firewallPrivateInterface = "enp0s1";
    const firewallEgressInterface = "enp0s2";
    return {
      provider: this.id,
      guest: {
        firewallIp: this.config.firewallIp,
        agentIp: this.config.agentIp,
        networkPrefix: 24,
        agentPrivateInterface,
        firewallPrivateInterface,
        firewallEgressInterface,
        firewallControlInterface: firewallEgressInterface,
      },
      vms: {
        agent: {
          kind: "lima-user-v2",
          role: "agent",
          limaInstance: this.config.agentVm,
          networkName: limaUserV2NetworkName(this.config),
          privateInterface: agentPrivateInterface,
          privateIp: this.config.agentIp,
          gatewayIp: reservedIps.gatewayIp,
          dnsIp: reservedIps.dnsIp,
          reservedIps: reservedIps.all,
          hasEgress: false,
        },
        firewall: {
          kind: "lima-user-v2",
          role: "firewall",
          limaInstance: this.config.firewallVm,
          networkName: limaUserV2NetworkName(this.config),
          privateInterface: firewallPrivateInterface,
          egressInterface: firewallEgressInterface,
          privateIp: this.config.firewallIp,
          gatewayIp: reservedIps.gatewayIp,
          dnsIp: reservedIps.dnsIp,
          reservedIps: reservedIps.all,
          hasEgress: true,
        },
      },
    };
  }

  preflight(): Promise<void> {
    assertLimactlSupportsSshOverVsockYaml(this.ensureLimactl());
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  remove(): Promise<void> {
    const networkName = limaUserV2NetworkName(this.config);
    const result = runCapture(this.ensureLimactl(), ["--tty=false", "network", "delete", "--force", networkName], {
      allowFailure: true,
    });
    if (result.status !== 0 && !networkMissing(result.stderr + result.stdout)) {
      throw new Error(result.stderr.length > 0 ? result.stderr.trim() : `failed to delete Lima network ${networkName}`);
    }
    return Promise.resolve();
  }

  ensureReady(): Promise<void> {
    this.ensureNetwork();
    return Promise.resolve();
  }

  private ensureNetwork(): void {
    const limactl = this.ensureLimactl();
    const networkName = limaUserV2NetworkName(this.config);
    const listedJson = runCapture(limactl, ["--tty=false", "network", "list", "--json"], {
      allowFailure: true,
    });
    if (listedJson.status === 0 && limaNetworkListIncludes(listedJson.stdout, networkName)) {
      return;
    }
    const listed = runCapture(limactl, ["--tty=false", "network", "list"], {
      allowFailure: true,
    });
    if (listed.status === 0 && limaNetworkListIncludes(listed.stdout, networkName)) {
      return;
    }
    this.log(`creating Lima user-v2 network for instance '${this.config.instanceName}'...`);
    const gateway = `${limaUserV2ReservedIps(this.config).gatewayIp}/${this.config.networkPrefix}`;
    const createArgs = [
      "--tty=false",
      "network",
      "create",
      networkName,
      "--mode",
      "user-v2",
      "--gateway",
      gateway,
    ];
    const created = runCapture(limactl, createArgs, { allowFailure: true });
    if (created.status === 0 || networkAlreadyExists(created.stdout + created.stderr)) {
      return;
    }
    const output = (created.stderr + created.stdout).trim();
    throw new Error(output.length > 0 ? output : `command failed (${String(created.status)}): ${[limactl, ...createArgs].join(" ")}`);
  }

  private ensureLimactl(): string {
    if (this.limactlBin.length === 0) {
      this.limactlBin = resolveHostTool({
        name: "limactl",
        envVars: ["ROOTCELL_LIMACTL", "LIMACTL"],
        purpose: "to manage rootcell Lima networks",
      });
    }
    return this.limactlBin;
  }

}

export function limaUserV2NetworkName(config: RootcellConfig): string {
  const digest = createHash("sha256")
    .update(`${config.repoDir}:${config.instanceName}:user-v2`)
    .digest("hex")
    .slice(0, 12);
  return `rootcell-${digest}`;
}

export function limaUserV2ReservedIps(config: RootcellConfig): {
  readonly gatewayIp: string;
  readonly dnsIp: string;
  readonly all: readonly string[];
} {
  const prefix = config.firewallIp.slice(0, config.firewallIp.lastIndexOf("."));
  const gatewayIp = `${prefix}.2`;
  const dnsIp = `${prefix}.3`;
  return {
    gatewayIp,
    dnsIp,
    all: [gatewayIp, dnsIp],
  };
}

export function limaNetworkListIncludes(stdout: string, name: string): boolean {
  if (limaNetworkJsonIncludes(stdout, name)) {
    return true;
  }
  return limaNetworkTableIncludes(stdout, name);
}

function limaNetworkJsonIncludes(stdout: string, name: string): boolean {
  const values = parseJsonValues(stdout);
  for (const value of values) {
    if (jsonValueIncludesNetworkName(value, name)) {
      return true;
    }
  }
  return false;
}

function parseJsonValues(stdout: string): readonly unknown[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    const values: unknown[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        values.push(JSON.parse(line));
      } catch {
        return [];
      }
    }
    return values;
  }
  return [raw];
}

function jsonValueIncludesNetworkName(raw: unknown, name: string): boolean {
  const stack: unknown[] = [raw];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      for (const nested of value as readonly unknown[]) {
        stack.push(nested);
      }
      continue;
    }
    if (value !== null && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (object.name === name || object.Name === name) {
        return true;
      }
      for (const nested of Object.values(object)) {
        stack.push(nested);
      }
    }
  }
  return false;
}

function limaNetworkTableIncludes(stdout: string, name: string): boolean {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || /^NAME\s+MODE\b/i.test(trimmed)) {
      continue;
    }
    const [networkName] = trimmed.split(/\s+/, 1);
    if (networkName === name) {
      return true;
    }
  }
  return false;
}

function networkMissing(output: string): boolean {
  return /not found|does not exist|no such/i.test(output);
}

function networkAlreadyExists(output: string): boolean {
  return /already exists/i.test(output);
}
