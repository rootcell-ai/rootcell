import type { RootcellConfig } from "../types.ts";
import type { NetworkPlan, NetworkProvider, VmNetworkAttachment, VmRole } from "./types.ts";
import { AwsEc2TerraformProject } from "./aws-ec2-terraform.ts";

export interface AwsEc2NetworkAttachment extends VmNetworkAttachment {
  readonly kind: "aws-ec2";
  readonly role: VmRole;
  readonly privateIp: string;
  readonly privateInterface: string;
  readonly hasPublicControlInterface: boolean;
  readonly hasEgress: boolean;
}

export class AwsEc2NetworkProvider implements NetworkProvider<AwsEc2NetworkAttachment> {
  readonly id = "aws-ec2";
  private readonly terraform: AwsEc2TerraformProject;

  constructor(
    private readonly config: RootcellConfig,
    private readonly log: (message: string) => void,
  ) {
    this.terraform = new AwsEc2TerraformProject(config, log);
  }

  plan(): NetworkPlan<AwsEc2NetworkAttachment> {
    const agentPrivateInterface = "ens5";
    const firewallPrivateInterface = "ens6";
    const firewallEgressInterface = "ens5";
    return {
      provider: this.id,
      guest: {
        firewallIp: this.config.firewallIp,
        agentIp: this.config.agentIp,
        agentDefaultGatewayIp: awsVpcRouterIp(this.config),
        networkPrefix: 24,
        agentPrivateInterface,
        firewallPrivateInterface,
        firewallEgressInterface,
        firewallControlInterface: firewallEgressInterface,
        firewallUpstreamDns: ["1.1.1.1", "8.8.8.8"],
      },
      vms: {
        agent: {
          kind: "aws-ec2",
          role: "agent",
          privateInterface: agentPrivateInterface,
          privateIp: this.config.agentIp,
          hasPublicControlInterface: false,
          hasEgress: false,
        },
        firewall: {
          kind: "aws-ec2",
          role: "firewall",
          privateInterface: firewallPrivateInterface,
          privateIp: this.config.firewallIp,
          hasPublicControlInterface: true,
          hasEgress: true,
        },
      },
    };
  }

  async preflight(): Promise<void> {
    await this.terraform.preflight();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  async remove(): Promise<void> {
    await this.terraform.verifyTerraformStateTags();
    this.terraform.destroy();
    this.terraform.removeLocalState();
  }

  async ensureReady(input: {
    readonly affectedVms: readonly string[];
    readonly force?: boolean;
    readonly stopVmIfRunning: (name: string) => Promise<void>;
  }): Promise<void> {
    await this.terraform.ensureApplied({ force: input.force === true });
  }
}

export function awsVpcRouterIp(config: RootcellConfig): string {
  const subnet = config.firewallIp.slice(0, config.firewallIp.lastIndexOf("."));
  return `${subnet}.1`;
}
