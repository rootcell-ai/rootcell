import { ProxyJumpSshTransport, type ProxyJumpSshEndpoints } from "../transports/proxyjump-ssh.ts";
import type { CommandResult, InheritedCommandResult } from "../types.ts";
import type { RootcellConfig } from "../types.ts";
import type { CopyToGuestOptions, ExecOptions, LocalPortForwardHandle, LocalPortForwardOptions, VmProvider, VmRole, VmStatus } from "./types.ts";
import type { AwsEc2NetworkAttachment } from "./aws-ec2-network.ts";
import { AwsEc2TerraformProject } from "./aws-ec2-terraform.ts";

export class AwsEc2VmProvider implements VmProvider<AwsEc2NetworkAttachment> {
  readonly id = "aws-ec2";
  private readonly terraform: AwsEc2TerraformProject;
  private readonly transport: ProxyJumpSshTransport;

  constructor(
    private readonly config: RootcellConfig,
    log: (message: string) => void,
  ) {
    this.terraform = new AwsEc2TerraformProject(config, log);
    this.transport = new ProxyJumpSshTransport(config, () => this.transportEndpoints());
  }

  async status(name: string): Promise<VmStatus> {
    const outputs = this.terraform.readOutputsIfPresent();
    if (outputs === null) {
      return { state: "missing" };
    }
    const instanceId = this.instanceIdForName(name, outputs);
    const state = await this.terraform.instanceStatus(instanceId);
    if (state === "running" || state === "stopped" || state === "missing") {
      return { state };
    }
    return { state: "unexpected", detail: "unexpected AWS EC2 instance state" };
  }

  async forceStopIfRunning(name: string): Promise<void> {
    await this.stopIfRunning(name);
  }

  async stopIfRunning(name: string): Promise<void> {
    if ((await this.status(name)).state !== "running") {
      return;
    }
    await this.terraform.applyDesiredInstanceState("stopped");
  }

  remove(): Promise<void> {
    return Promise.resolve();
  }

  assertCompatible(name: string, network: AwsEc2NetworkAttachment): Promise<void> {
    if (name === this.config.agentVm && network.role !== "agent") {
      throw new Error(`${name} has incompatible AWS EC2 role metadata`);
    }
    if (name === this.config.firewallVm && network.role !== "firewall") {
      throw new Error(`${name} has incompatible AWS EC2 role metadata`);
    }
    return Promise.resolve();
  }

  async ensureRunning(input: {
    readonly role: VmRole;
    readonly name: string;
    readonly network: AwsEc2NetworkAttachment;
  }): Promise<{ readonly created: boolean }> {
    const status = await this.status(input.name);
    if (status.state === "running") {
      await this.waitForSsh(input.name);
      return { created: false };
    }
    if (status.state === "stopped") {
      await this.terraform.applyDesiredInstanceState("running");
      await this.waitForSsh(input.name);
      return { created: false };
    }
    if (status.state === "missing") {
      await this.terraform.ensureApplied({ force: true });
      await this.waitForSsh(input.name);
      return { created: true };
    }
    throw new Error(`${input.name} VM in unexpected state: ${status.detail}`);
  }

  finalizeNetworking(): Promise<void> {
    return Promise.resolve();
  }

  forgetSshHostKey(name: string): Promise<void> {
    this.transport.forgetHostKey(name);
    return Promise.resolve();
  }

  exec(name: string, command: readonly string[], options: ExecOptions = {}): Promise<InheritedCommandResult> {
    return this.transport.exec(name, command, options);
  }

  execCapture(name: string, command: readonly string[], options: ExecOptions = {}): Promise<CommandResult> {
    return this.transport.execCapture(name, command, options);
  }

  async execInteractive(name: string, command: readonly string[], options: ExecOptions = {}): Promise<number> {
    return await this.transport.execInteractive(name, command, options);
  }

  copyToGuest(name: string, hostPath: string, guestPath: string, options: CopyToGuestOptions = {}): Promise<void> {
    return this.transport.copyToGuest(name, hostPath, guestPath, options);
  }

  forwardLocalPort(name: string, options: LocalPortForwardOptions): Promise<LocalPortForwardHandle> {
    return this.transport.forwardLocalPort(name, options);
  }

  private transportEndpoints(): ProxyJumpSshEndpoints {
    const outputs = this.terraform.readOutputsIfPresent();
    if (outputs === null) {
      throw new Error("AWS EC2 Terraform outputs are not available yet");
    }
    return {
      firewallHost: outputs.firewall_public_ip,
      firewallPort: 22,
      agentHost: outputs.agent_private_ip,
      identityPath: this.terraform.controlIdentityPath(),
      knownHostsPath: this.terraform.knownHostsPath(),
    };
  }

  private instanceIdForName(name: string, outputs: {
    readonly agent_instance_id: string;
    readonly firewall_instance_id: string;
  }): string {
    if (name === this.config.agentVm) {
      return outputs.agent_instance_id;
    }
    if (name === this.config.firewallVm) {
      return outputs.firewall_instance_id;
    }
    throw new Error(`unknown rootcell VM for AWS EC2 provider: ${name}`);
  }

  private async waitForSsh(name: string): Promise<void> {
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
      await sleep(1000);
    }
    throw new Error(`timeout waiting for SSH transport to ${name}${lastError.length === 0 ? "" : `: ${lastError}`}`);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  });
}
