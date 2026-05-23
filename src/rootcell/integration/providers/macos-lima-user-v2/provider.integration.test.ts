import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { AGENT_IP, AGENT_VM_NAME, FIREWALL_IP, FIREWALL_VM_NAME, TEST_INSTANCE } from "../../common/fixtures.ts";
import { createProvisionedIntegrationFlow, IntegrationFlow } from "../../common/rootcell-flow.ts";
import { selectedIntegrationProvider } from "../../common/provider-spec.ts";
import type { LimaUserV2NetworkAttachment } from "../../../providers/macos-lima-user-v2-network.ts";
import { NIXOS_LIMA_AARCH64_IMAGE } from "../../../providers/lima.ts";
import { instancePaths } from "../../../instance.ts";
import { limaStatePath, limaYamlPath, macOsLimaUserV2IntegrationProvider, readJson } from "./provider.ts";
import { LimaNetworkAttachmentSchema, LimaVmStateFileSchema } from "./schemas.ts";

const shouldRun = selectedIntegrationProvider().id === macOsLimaUserV2IntegrationProvider.id;
let flow: IntegrationFlow<LimaUserV2NetworkAttachment>;

describe.skipIf(!shouldRun)("macos-lima-user-v2 integration provider", { concurrent: false }, () => {
  beforeAll(async () => {
    flow = await createProvisionedIntegrationFlow(macOsLimaUserV2IntegrationProvider, import.meta.url);
  });

  test("exposes Lima user-v2 network attachment shape through the provider bundle", () => {
    const plan = flow.providers.network.plan();
    expect(plan.provider).toBe("macos-lima-user-v2");
    expect(plan.vms.agent).toEqual(expect.schemaMatching(LimaNetworkAttachmentSchema.extend({
      role: z.literal("agent"),
      privateIp: z.literal(AGENT_IP),
      hasEgress: z.literal(false),
    })));
    expect(plan.vms.firewall).toEqual(expect.schemaMatching(LimaNetworkAttachmentSchema.extend({
      role: z.literal("firewall"),
      privateIp: z.literal(FIREWALL_IP),
      hasEgress: z.literal(true),
    })));
    expect(plan.vms.agent.reservedIps).toEqual(["192.168.109.2"]);
  });

  test("records running Lima VM state files and generated YAML", () => {
    const agent = readJson(limaStatePath(flow.repoDir, AGENT_VM_NAME));
    const firewall = readJson(limaStatePath(flow.repoDir, FIREWALL_VM_NAME));
    expect(agent).toEqual(expect.schemaMatching(LimaVmStateFileSchema.extend({
      name: z.literal(AGENT_VM_NAME),
      role: z.literal("agent"),
      hasEgress: z.literal(false),
      sshLocalPort: z.number().int().positive(),
      userV2Ready: z.literal(true),
    })));
    expect(firewall).toEqual(expect.schemaMatching(LimaVmStateFileSchema.extend({
      name: z.literal(FIREWALL_VM_NAME),
      role: z.literal("firewall"),
      hasEgress: z.literal(true),
      sshLocalPort: z.number().int().positive(),
    })));
    const firewallYaml = readFileSync(limaYamlPath(flow.repoDir, FIREWALL_VM_NAME), "utf8");
    const agentYaml = readFileSync(limaYamlPath(flow.repoDir, AGENT_VM_NAME), "utf8");
    expect(firewallYaml).toContain(`location: "${NIXOS_LIMA_AARCH64_IMAGE.location}"`);
    expect(firewallYaml).toContain(`digest: "${NIXOS_LIMA_AARCH64_IMAGE.digest}"`);
    expect(firewallYaml).toContain("overVsock: true");
    expect(firewallYaml).toContain("containerd:\n  system: false\n  user: false");
    expect(firewallYaml).toContain("mounts: []");
    expect(firewallYaml).toContain("vzNAT: true");
    expect(agentYaml).not.toContain("vzNAT");
    expect(`${firewallYaml}\n${agentYaml}`).not.toContain("provision:");
    for (const removedRuntime of removedRuntimeNames()) {
      expect(`${firewallYaml}\n${agentYaml}`).not.toContain(removedRuntime);
    }
  });

  test("writes an SSH config for direct firewall and proxied agent access", () => {
    const config = readFileSync(sshConfigPath(flow.repoDir), "utf8");
    expect(config).toContain("Host rootcell-firewall");
    expect(config).toContain("HostName 127.0.0.1");
    expect(config).toContain("Port ");
    expect(config).toContain("Host rootcell-agent");
    expect(config).toContain(`HostName ${AGENT_IP}`);
    expect(config).toContain("ProxyCommand ssh -F /dev/null -W %h:%p");
    expect(config).not.toContain("ControlPath");
  });

  test("supports host SSH to firewall and agent through the Lima SSH transport", () => {
    sshGuest(flow, "rootcell-firewall", "true");
    sshGuest(flow, "rootcell-agent", "true");
  });

  test("keeps Lima VSOCK control after VM restarts", () => {
    flow.hostCommandOk("limactl", ["shell", AGENT_VM_NAME, "true"]);
    flow.hostCommandOk("limactl", ["shell", FIREWALL_VM_NAME, "true"]);
    for (const vm of [AGENT_VM_NAME, FIREWALL_VM_NAME]) {
      flow.hostCommandOk("limactl", ["stop", vm]);
      flow.hostCommandOk("limactl", ["start", "--timeout", "3m", vm]);
      flow.hostCommandOk("limactl", ["shell", vm, "true"]);
    }
  });

  test("passes the strict no-bypass user-v2 proof gate", async () => {
    const agentInterface = flow.providers.network.plan().vms.agent.privateInterface;
    await flow.agentSh("test \"$(find /sys/class/net -mindepth 1 -maxdepth 1 ! -name lo | wc -l | tr -d \" \")\" = 1");
    await flow.agentSh(`ip -4 addr show dev ${shellQuote(agentInterface)} | grep -q ${shellQuote(` ${AGENT_IP}/24`)}`);
    await flow.agentSh(`! ip -4 -o addr show scope global | grep -v ${shellQuote(`^[0-9]\\+: ${agentInterface}\\b`)} | grep -q .`);
    await flow.agentSh(`ip route show default | grep -q '^default via ${FIREWALL_IP} '`);
    await flow.agentSh(`ping -c 1 -W 2 ${FIREWALL_IP} >/dev/null`);
    flow.hostCommandFails("ssh", [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=3",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      `luser@${AGENT_IP}`,
      "true",
    ]);
  });
});

function sshConfigPath(repoDir: string): string {
  return join(instancePaths(repoDir, TEST_INSTANCE, process.env).dir, "ssh", "config");
}

function sshGuest(flow: IntegrationFlow, alias: "rootcell-agent" | "rootcell-firewall", script: string): string {
  return flow.hostCommandOk("ssh", ["-F", sshConfigPath(flow.repoDir), alias, `bash -lc ${shellQuote(script)}`]);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function removedRuntimeNames(): readonly string[] {
  return [["vf", "kit"].join(""), ["socket", "_vmnet"].join("")];
}
