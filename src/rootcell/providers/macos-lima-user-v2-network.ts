import { createHash } from "node:crypto";
import { resolveHostTool } from "../host-tools.ts";
import { runCapture, runInherited } from "../process.ts";
import type { RootcellConfig } from "../types.ts";
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
    this.ensureLimactl();
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
    const listed = runCapture(limactl, ["network", "list", "--json"], {
      allowFailure: true,
    });
    const networkName = limaUserV2NetworkName(this.config);
    if (listed.status === 0 && limaNetworkListIncludes(listed.stdout, networkName)) {
      return;
    }
    this.log(`creating Lima user-v2 network for instance '${this.config.instanceName}'...`);
    const gateway = `${limaUserV2ReservedIps(this.config).gatewayIp}/${this.config.networkPrefix}`;
    runInherited(limactl, [
      "--tty=false",
      "network",
      "create",
      networkName,
      "--mode",
      "user-v2",
      "--gateway",
      gateway,
    ]);
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
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return false;
  }
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

function networkMissing(output: string): boolean {
  return /not found|does not exist|no such/i.test(output);
}
