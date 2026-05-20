import { describe, expect, test } from "vitest";
import { z } from "zod";
import { parseRootcellArgs } from "./args.ts";
import { ROOTCELL_SUBCOMMANDS } from "./metadata.ts";
import { loadDotEnv, parseSecretMappings } from "./env.ts";
import { resolveHostTool } from "./host-tools.ts";
import { buildConfig, formatVmList } from "./rootcell.ts";
import { deriveVmNames, instancePaths, listRootcellVmInstanceNames, loadRootcellInstance, seedRootcellInstanceFiles } from "./instance.ts";
import { runCapture } from "./process.ts";
import { createProviderBundle } from "./providers/factory.ts";
import {
  limaNetworkListIncludes,
  limaUserV2NetworkName,
  limaUserV2ReservedIps,
  MacOsLimaUserV2NetworkProvider,
} from "./providers/macos-lima-user-v2-network.ts";
import { directSshConfig, LimaVmProvider, limaYaml, NIXOS_LIMA_AARCH64_IMAGE, parseLimaVmState, userV2ProofScript } from "./providers/lima.ts";
import {
  ImageStore,
  imageDownloadUrl,
  parseRootcellImageManifest,
  imageForRole,
  ROOTCELL_GUEST_API_VERSION,
  ROOTCELL_IMAGE_SCHEMA_VERSION,
  RootcellImageManifestSchema,
} from "./images.ts";
import { forgetKnownHost, sshConfig } from "./transports/proxyjump-ssh.ts";
import { dnsmasqAllowlistConfig, generatedLineCount } from "../bin/reload.ts";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ParsedRootcellRunArgsSchema,
  RootcellConfigSchema,
  RootcellInstanceSchema,
  type ParsedRootcellRunArgs,
  type RootcellInstance,
} from "./types.ts";
import { MacOsKeychainSecretProvider } from "./secrets/macos-keychain.ts";
import { StaticSecretProviderRegistry } from "./secrets/registry.ts";
import { SecretEnvMappingSchema } from "./secrets/types.ts";

const EmptyStringArraySchema = z.array(z.string()).length(0);
const DefaultSpyOptionsSchema = z.object({
  raw: z.literal(false),
  dedupe: z.literal(true),
  tui: z.literal(false),
}).strict();

const ignoreLog = (): void => undefined;

function expectRunArgs(value: ParsedRootcellRunArgs): void {
  expect(value).toEqual(expect.schemaMatching(ParsedRootcellRunArgsSchema));
}

describe("rootcell argument parsing", () => {
  test("parses known subcommands", () => {
    const parsed = runArgs(["provision"]);
    expectRunArgs(parsed);
    expect(parsed.rest).toEqual(expect.schemaMatching(EmptyStringArraySchema));
    expect(parsed.spyOptions).toEqual(expect.schemaMatching(DefaultSpyOptionsSchema));
    expect(parsed).toEqual({
      kind: "run",
      instanceName: "default",
      subcommand: "provision",
      rest: [],
      spyOptions: { raw: false, dedupe: true, tui: false },
    });
    expect(() => parseRootcellArgs(["provision", "ignored"])).toThrow("Too many non-option arguments");
  });

  test("parses lifecycle subcommands", () => {
    const list = runArgs(["list"]);
    expectRunArgs(list);
    expect(list).toEqual({
      kind: "run",
      instanceName: "default",
      subcommand: "list",
      rest: [],
      spyOptions: { raw: false, dedupe: true, tui: false },
    });
    const stop = runArgs(["stop", "--instance", "dev"]);
    expectRunArgs(stop);
    expect(stop).toEqual({
      kind: "run",
      instanceName: "dev",
      subcommand: "stop",
      rest: [],
      spyOptions: { raw: false, dedupe: true, tui: false },
    });
    const remove = runArgs(["remove", "--instance=dev"]);
    expectRunArgs(remove);
    expect(remove).toEqual({
      kind: "run",
      instanceName: "dev",
      subcommand: "remove",
      rest: [],
      spyOptions: { raw: false, dedupe: true, tui: false },
    });
  });

  test("parses pass-through guest commands", () => {
    const explicit = runArgs(["--", "nix", "flake", "update"]);
    expectRunArgs(explicit);
    expect(explicit).toEqual({
      kind: "run",
      instanceName: "default",
      subcommand: "",
      rest: ["nix", "flake", "update"],
      spyOptions: { raw: false, dedupe: true, tui: false },
    });
    const implicit = runArgs(["pi", "--model", "sonnet"]);
    expectRunArgs(implicit);
    expect(implicit).toEqual({
      kind: "run",
      instanceName: "default",
      subcommand: "",
      rest: ["pi", "--model", "sonnet"],
      spyOptions: { raw: false, dedupe: true, tui: false },
    });
    const numericOptions = runArgs(["--", "curl", "--connect-timeout", "5", "--max-time", "20", "https://github.com"]);
    expectRunArgs(numericOptions);
    expect(numericOptions.rest).toEqual(["curl", "--connect-timeout", "5", "--max-time", "20", "https://github.com"]);
  });

  test("parses instance flags in any command position", () => {
    const beforeCommand = runArgs(["--instance", "dev", "provision"]);
    expectRunArgs(beforeCommand);
    expect(beforeCommand).toEqual({
      kind: "run",
      instanceName: "dev",
      subcommand: "provision",
      rest: [],
      spyOptions: { raw: false, dedupe: true, tui: false },
    });
    const afterCommand = runArgs(["allow", "--instance=dev"]);
    expectRunArgs(afterCommand);
    expect(afterCommand).toEqual({
      kind: "run",
      instanceName: "dev",
      subcommand: "allow",
      rest: [],
      spyOptions: { raw: false, dedupe: true, tui: false },
    });
    const passThrough = runArgs(["pi", "--instance", "dev", "--model", "sonnet"]);
    expectRunArgs(passThrough);
    expect(passThrough).toEqual({
      kind: "run",
      instanceName: "dev",
      subcommand: "",
      rest: ["pi", "--model", "sonnet"],
      spyOptions: { raw: false, dedupe: true, tui: false },
    });
  });

  test("rejects invalid instance names", () => {
    expect(() => parseRootcellArgs(["--instance", "../dev"])).toThrow("invalid instance name");
    expect(() => parseRootcellArgs(["provision", "--instance", "dev-"])).toThrow("invalid instance name");
  });

  test("parses spy flags", () => {
    const parsed = runArgs(["spy", "--tui", "--raw", "--no-dedupe"]);
    expectRunArgs(parsed);
    expect(parsed).toEqual({
      kind: "run",
      instanceName: "default",
      subcommand: "spy",
      rest: [],
      spyOptions: { raw: true, dedupe: false, tui: true },
    });
  });

  test("rejects unknown spy flags", () => {
    expect(() => parseRootcellArgs(["spy", "--bogus"])).toThrow("Unknown argument: bogus");
  });

  test("rejects unknown rootcell flags before commands", () => {
    expect(() => parseRootcellArgs(["--bogus", "provision"])).toThrow("Unknown argument: bogus");
    expect(() => parseRootcellArgs(["--raw", "spy"])).toThrow("Unknown argument: raw");
  });

  test("prints help without selecting a VM command", () => {
    const result = runCapture("./rootcell", ["--help"]);
    expect(result.stdout).toContain("Commands:");
    expect(result.stdout).toContain("rootcell completion");

    const helpCommand = runCapture("./rootcell", ["help"]);
    expect(helpCommand.stdout).toContain("Commands:");
  });
});

describe("environment parsing", () => {
  test("pre-existing environment wins over .env", () => {
    const env: NodeJS.ProcessEnv = { FIREWALL_IP: "1.2.3.4" };
    const path = "/tmp/rootcell-env-test";
    writeFileSync(path, "FIREWALL_IP=5.6.7.8\nAGENT_IP=9.9.9.9\n#SKIP=yes\n", "utf8");
    loadDotEnv(path, env);
    expect(env.FIREWALL_IP).toBe("1.2.3.4");
    expect(env.AGENT_IP).toBe("9.9.9.9");
    expect(env["#SKIP"]).toBeUndefined();
  });

  test("loads no-equals env entries as empty values", () => {
    const env: NodeJS.ProcessEnv = {};
    const path = "/tmp/rootcell-env-empty-test";
    writeFileSync(path, "EMPTY_VALUE\n", "utf8");
    loadDotEnv(path, env);
    expect(env.EMPTY_VALUE).toBe("");
  });

  test("validates secret mappings", () => {
    const mappings = parseSecretMappings([
      "AWS_BEARER_TOKEN_BEDROCK=macos-keychain:aws-bedrock-api-key",
      "AWS_SECRET_ACCESS_KEY=aws-prod:arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/key",
      "ONEPASSWORD_TOKEN=1password:op://Private/token/password",
      "",
    ].join("\n"));
    expect(mappings).toEqual(expect.schemaMatching(z.array(SecretEnvMappingSchema)));
    expect(mappings).toEqual([
      {
        envName: "AWS_BEARER_TOKEN_BEDROCK",
        secret: { providerId: "macos-keychain", reference: "aws-bedrock-api-key" },
      },
      {
        envName: "AWS_SECRET_ACCESS_KEY",
        secret: {
          providerId: "aws-prod",
          reference: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/key",
        },
      },
      {
        envName: "ONEPASSWORD_TOKEN",
        secret: { providerId: "1password", reference: "op://Private/token/password" },
      },
    ]);
    expect(() => parseSecretMappings("1BAD=macos-keychain:service\n")).toThrow("invalid secret environment variable name");
    expect(() => parseSecretMappings("BAD\n")).toThrow("invalid secret entry");
    expect(() => parseSecretMappings("BAD=\n")).toThrow("empty secret reference");
    expect(() => parseSecretMappings("BAD=service\n")).toThrow("must include a provider id");
    expect(() => parseSecretMappings("BAD=:service\n")).toThrow("empty secret provider id");
    expect(() => parseSecretMappings("BAD=bad/id:service\n")).toThrow("invalid secret provider id");
    expect(() => parseSecretMappings("BAD=macos-keychain:\n")).toThrow("empty secret reference");
  });

  test("builds config from instance state", () => {
    const instance = fakeInstance("dev");
    expect(instance).toEqual(expect.schemaMatching(RootcellInstanceSchema));
    const config = buildConfig("/repo", {}, instance);
    expect(config).toEqual(expect.schemaMatching(RootcellConfigSchema));
    expect(config.agentVm).toBe("agent-dev");
    expect(config.firewallVm).toBe("firewall-dev");
    expect(config.firewallIp).toBe("192.168.109.10");
    expect(config.agentIp).toBe("192.168.109.11");
    expect(config.imageManifestUrl).toBe("https://github.com/rootcell-ai/rootcell/releases/latest/download/manifest.json");
  });
});

describe("host tool resolution", () => {
  const limaSpec = {
    name: "limactl",
    envVars: ["ROOTCELL_LIMACTL", "LIMACTL"],
    purpose: "to start test VMs",
  };

  test("prefers explicit environment overrides", () => {
    expect(resolveHostTool(limaSpec, {
      env: { ROOTCELL_LIMACTL: "/opt/rootcell/bin/limactl" },
      commandExists: () => false,
    })).toBe("/opt/rootcell/bin/limactl");
    expect(resolveHostTool(limaSpec, {
      env: { LIMACTL: "/usr/local/bin/limactl" },
      commandExists: () => false,
    })).toBe("/usr/local/bin/limactl");
  });

  test("uses PATH before asking the user to install anything", () => {
    expect(resolveHostTool(limaSpec, {
      env: {},
      commandExists: (command) => command === "limactl",
    })).toBe("limactl");
  });

  test("missing tools produce package-manager instructions", () => {
    expect(() => resolveHostTool(limaSpec, {
      env: {},
      commandExists: () => false,
    })).toThrow("brew install bun lima");
    expect(() => resolveHostTool(limaSpec, {
      env: {},
      commandExists: () => false,
    })).toThrow("nix shell .#hostTools --command ./rootcell");
  });

  test("runtime host tools do not fall back to host-side nix builds", () => {
    for (const file of [
      "src/rootcell/images.ts",
      "src/rootcell/providers/lima.ts",
      "src/rootcell/providers/macos-lima-user-v2-network.ts",
    ]) {
      expect(readFileSync(file, "utf8")).not.toMatch(/run(?:Capture|Inherited)\("nix"/);
    }
  });
});

describe("secret providers", () => {
  test("registry routes provider-qualified references", async () => {
    const calls: string[] = [];
    const registry = new StaticSecretProviderRegistry([
      {
        id: "macos-keychain",
        read: (reference) => {
          calls.push(`macos-keychain:${reference}`);
          return Promise.resolve(`mac:${reference}`);
        },
      },
      {
        id: "aws-prod",
        read: (reference) => {
          calls.push(`aws-prod:${reference}`);
          return Promise.resolve(`prod:${reference}`);
        },
      },
      {
        id: "aws-dev",
        read: (reference) => {
          calls.push(`aws-dev:${reference}`);
          return Promise.resolve(`dev:${reference}`);
        },
      },
    ]);

    await expect(registry.read({ providerId: "macos-keychain", reference: "service" })).resolves.toBe("mac:service");
    await expect(registry.read({ providerId: "aws-prod", reference: "secret/name" })).resolves.toBe("prod:secret/name");
    await expect(registry.read({ providerId: "aws-dev", reference: "secret/name" })).resolves.toBe("dev:secret/name");
    expect(calls).toEqual([
      "macos-keychain:service",
      "aws-prod:secret/name",
      "aws-dev:secret/name",
    ]);
  });

  test("registry rejects unknown or duplicate secret providers", async () => {
    const registry = new StaticSecretProviderRegistry([
      { id: "macos-keychain", read: () => Promise.resolve("secret") },
    ]);

    await expect(registry.read({ providerId: "missing", reference: "do-not-print" })).rejects.toThrow("unknown secret provider 'missing'");
    try {
      await registry.read({ providerId: "missing", reference: "do-not-print" });
      throw new Error("expected secret lookup to fail");
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain("do-not-print");
    }
    expect(() => new StaticSecretProviderRegistry([
      { id: "aws-prod", read: () => Promise.resolve("one") },
      { id: "aws-prod", read: () => Promise.resolve("two") },
    ])).toThrow("duplicate secret provider id");
  });

  test("macOS Keychain provider reads generic passwords", async () => {
    const calls: { command: string; args: readonly string[]; allowFailure: boolean | undefined }[] = [];
    const provider = new MacOsKeychainSecretProvider("macos-keychain", (command, args, options) => {
      calls.push({ command, args, allowFailure: options?.allowFailure });
      return { status: 0, stdout: "secret-value\n", stderr: "" };
    });

    await expect(provider.read("aws-bedrock-api-key")).resolves.toBe("secret-value");
    expect(calls).toEqual([
      {
        command: "security",
        args: ["find-generic-password", "-s", "aws-bedrock-api-key", "-w"],
        allowFailure: true,
      },
    ]);
  });

  test("macOS Keychain provider reports missing secrets with add guidance", async () => {
    const provider = new MacOsKeychainSecretProvider("macos-keychain", () => ({
      status: 44,
      stdout: "",
      stderr: "not found",
    }));

    await expect(provider.read("anthropic-api-key")).rejects.toThrow("macOS Keychain secret not found");
    await expect(provider.read("anthropic-api-key")).rejects.toThrow("security add-generic-password");
  });
});

describe("VM and network providers", () => {
  test("factory defaults to Lima providers", () => {
    const providers = createProviderBundle(buildConfig("/repo", {}, fakeInstance("dev")), ignoreLog);
    expect(providers.network.id).toBe("macos-lima-user-v2");
    expect(providers.vm.id).toBe("lima");
    expect(providers.secrets.ids).toEqual(["macos-keychain"]);
  });

  test("macOS Lima user-v2 provider exposes egress firewall and private-only agent attachments", () => {
    const config = buildConfig("/repo", {}, fakeInstance("dev"));
    const plan = new MacOsLimaUserV2NetworkProvider(config, ignoreLog).plan();
    const networkName = limaUserV2NetworkName(config);
    expect(plan).toEqual(expect.schemaMatching(z.object({
      provider: z.literal("macos-lima-user-v2"),
      guest: z.object({
        firewallIp: z.literal("192.168.109.10"),
        agentIp: z.literal("192.168.109.11"),
        networkPrefix: z.literal(24),
        agentPrivateInterface: z.literal("enp0s1"),
        firewallPrivateInterface: z.literal("enp0s1"),
        firewallEgressInterface: z.literal("enp0s2"),
        firewallControlInterface: z.literal("enp0s2"),
      }).strict(),
      vms: z.object({
        agent: z.object({
          kind: z.literal("lima-user-v2"),
          role: z.literal("agent"),
          limaInstance: z.literal("agent-dev"),
          networkName: z.literal(networkName),
          privateInterface: z.literal("enp0s1"),
          privateIp: z.literal("192.168.109.11"),
          gatewayIp: z.literal("192.168.109.2"),
          dnsIp: z.literal("192.168.109.3"),
          reservedIps: z.array(z.string()),
          hasEgress: z.literal(false),
        }).strict(),
        firewall: z.object({
          kind: z.literal("lima-user-v2"),
          role: z.literal("firewall"),
          limaInstance: z.literal("firewall-dev"),
          networkName: z.literal(networkName),
          privateInterface: z.literal("enp0s1"),
          egressInterface: z.literal("enp0s2"),
          privateIp: z.literal("192.168.109.10"),
          gatewayIp: z.literal("192.168.109.2"),
          dnsIp: z.literal("192.168.109.3"),
          reservedIps: z.array(z.string()),
          hasEgress: z.literal(true),
        }).strict(),
      }).strict(),
    }).strict()));
    expect(plan.provider).toBe("macos-lima-user-v2");
    expect(plan.guest).toEqual({
      firewallIp: "192.168.109.10",
      agentIp: "192.168.109.11",
      networkPrefix: 24,
      agentPrivateInterface: "enp0s1",
      firewallPrivateInterface: "enp0s1",
      firewallEgressInterface: "enp0s2",
      firewallControlInterface: "enp0s2",
    });
    expect(plan.vms.agent.kind).toBe("lima-user-v2");
    expect(plan.vms.agent.hasEgress).toBe(false);
    expect(plan.vms.firewall.hasEgress).toBe(true);
    expect(plan.vms.agent.reservedIps).toEqual(["192.168.109.2", "192.168.109.3"]);
  });

  test("user-v2 network plan reserves Lima gateway and DNS IPs", () => {
    const config = buildConfig("/repo", {}, fakeInstance("dev"));
    expect(limaUserV2ReservedIps(config)).toEqual({
      gatewayIp: "192.168.109.2",
      dnsIp: "192.168.109.3",
      all: ["192.168.109.2", "192.168.109.3"],
    });
  });

  test("Lima user-v2 network names are per repo instance and short for UNIX socket paths", () => {
    const config = buildConfig("/repo", {}, fakeInstance("dev"));
    const otherInstance = buildConfig("/repo", {}, fakeInstance("prod"));
    const otherWorktree = buildConfig("/other-repo", {}, fakeInstance("dev", "/other-repo"));

    expect(limaUserV2NetworkName(config)).toMatch(/^rootcell-[a-f0-9]{12}$/);
    expect(limaUserV2NetworkName(config)).not.toBe(limaUserV2NetworkName(otherInstance));
    expect(limaUserV2NetworkName(config)).not.toBe(limaUserV2NetworkName(otherWorktree));
  });

  test("Lima YAML starts from upstream nixos-lima and applies Rootcell-only overrides", () => {
    const config = buildConfig("/repo", {}, fakeInstance("dev"));
    const network = new MacOsLimaUserV2NetworkProvider(config, ignoreLog).plan().vms.firewall;
    const yaml = limaYaml({
      role: "firewall",
      user: "luser",
      instanceName: "dev",
      cpus: 2,
      memoryGiB: 4,
      diskGiB: 16,
      network,
      firewallIp: "192.168.109.10",
      agentIp: "192.168.109.11",
      networkPrefix: "24",
    });
    expect(yaml).toContain("Generated by rootcell from nixos-lima v0.0.5 nixos.yaml");
    expect(yaml).toContain("# Template using latest released nixos-lima images");
    expect(yaml).toContain(`  - location: "${NIXOS_LIMA_AARCH64_IMAGE.location}"`);
    expect(yaml).toContain(`    digest: "${NIXOS_LIMA_AARCH64_IMAGE.digest}"`);
    expect(yaml).toContain("mounts: []");
    expect(yaml).not.toContain('location: "~"');
    expect(yaml).not.toContain("/tmp/lima");
    expect(yaml).toContain("containerd:\n  system: false\n  user: false");
    expect(yaml).toContain("ssh:\n  overVsock: true");
    expect(yaml).toContain("guestPort: 68");
    expect(yaml).toContain("ignore: true");
    expect(yaml).toContain("user:\n  name: \"luser\"\n  home: \"/home/luser\"");
    expect(yaml).toContain("  - vzNAT: true");
    expect(yaml).toContain('    interface: "enp0s2"');
    expect(yaml).toContain(`  - lima: "${network.networkName}"`);
    expect(yaml).toContain('    interface: "enp0s1"');
    expect(yaml).not.toContain("macAddress:");
    for (const removedRuntime of removedRuntimeNames()) {
      expect(yaml).not.toContain(removedRuntime);
    }
    expect(yaml).not.toContain("file://");
    expect(yaml).not.toContain("provision:");
    expect(yaml).not.toContain("addr=192.");
    expect(yaml).not.toContain("overVsock: false");
    expect(yaml).not.toContain("hostResolver:");
    expect(yaml).not.toContain("propagateProxyEnv:");
  });

  test("Lima YAML uses the same nixos-lima image for agent and firewall", () => {
    const config = buildConfig("/repo", {}, fakeInstance("dev"));
    const plan = new MacOsLimaUserV2NetworkProvider(config, ignoreLog).plan();
    const imageLines = [
      `  - location: "${NIXOS_LIMA_AARCH64_IMAGE.location}"`,
      `    arch: "${NIXOS_LIMA_AARCH64_IMAGE.arch}"`,
      `    digest: "${NIXOS_LIMA_AARCH64_IMAGE.digest}"`,
    ].join("\n");
    const commonInput = {
      user: "luser",
      instanceName: "dev",
      firewallIp: "192.168.109.10",
      agentIp: "192.168.109.11",
      networkPrefix: "24",
    };

    const agentYaml = limaYaml({
      ...commonInput,
      role: "agent",
      cpus: 8,
      memoryGiB: 16,
      diskGiB: 60,
      network: plan.vms.agent,
    });
    const firewallYaml = limaYaml({
      ...commonInput,
      role: "firewall",
      cpus: 2,
      memoryGiB: 4,
      diskGiB: 16,
      network: plan.vms.firewall,
    });

    expect(agentYaml).toContain(imageLines);
    expect(firewallYaml).toContain(imageLines);
    expect(agentYaml).not.toContain("agent.raw");
    expect(firewallYaml).not.toContain("firewall.raw");
  });

  test("rebuilt NixOS guests keep the Lima readiness contract", () => {
    const commonModule = readFileSync("common.nix", "utf8");

    expect(commonModule).toContain("isSystemUser = true;");
    expect(commonModule).toContain("uid = lib.mkDefault 501;");
    expect(commonModule).toContain('home = lib.mkDefault "/home/${username}";');
    expect(commonModule).toContain("ln -sfn /run/current-system/sw/bin/bash /bin/bash");
    expect(commonModule).toContain("services.lima.enable = true;");
    expect(commonModule).toContain("networking.nat.enable = lib.mkForce false;");

    const firewallModule = readFileSync("firewall-vm.nix", "utf8");
    expect(firewallModule).toContain("systemd.network.wait-online.enable = false;");
    expect(firewallModule).toContain("linkConfig.RequiredForOnline = false;");
  });

  test("user-v2 proof gate rejects extra agent interfaces and default-route bypasses", () => {
    const script = userV2ProofScript({
      agentIp: "192.168.109.11",
      firewallIp: "192.168.109.10",
      networkPrefix: "24",
      agentPrivateInterface: "enp0s1",
    });
    expect(script).toContain("find /sys/class/net -mindepth 1 -maxdepth 1 ! -name lo");
    expect(script).toContain("test \"$(ip route show default | wc -l | tr -d ' ')\" = 1");
    expect(script).toContain("ip route show default | grep -q \"^default via $firewall_ip dev $iface\\b\"");
    expect(script).toContain("! ip -4 -o addr show scope global | grep -v");
  });

  test("detects existing Lima networks from limactl JSON output", () => {
    expect(limaNetworkListIncludes(JSON.stringify([{ name: "rootcell-123456abcdef" }]), "rootcell-123456abcdef")).toBe(true);
    expect(limaNetworkListIncludes(JSON.stringify([{ Name: "other" }]), "rootcell-123456abcdef")).toBe(false);
  });

  test("detects existing Lima networks from Lima 2 JSON-lines output", () => {
    const output = [
      JSON.stringify({ name: "bridged", mode: "bridged" }),
      JSON.stringify({ name: "rootcell-123456abcdef", mode: "user-v2", gateway: "192.168.100.2" }),
    ].join("\n");
    expect(limaNetworkListIncludes(output, "rootcell-123456abcdef")).toBe(true);
  });

  test("detects existing Lima networks from limactl table output", () => {
    const output = [
      "NAME                     MODE       GATEWAY             INTERFACE",
      "bridged                  bridged    -                   en0",
      "rootcell-123456abcdef    user-v2    192.168.100.2/24    -",
      "shared                   shared     192.168.105.1/24    -",
    ].join("\n");
    expect(limaNetworkListIncludes(output, "rootcell-123456abcdef")).toBe(true);
    expect(limaNetworkListIncludes(output, "rootcell-fedcba654321")).toBe(false);
  });

  test("ssh config uses direct firewall and proxied agent aliases", () => {
    const configText = sshConfig({
      user: "luser",
      firewallHost: "127.0.0.1",
      firewallPort: 60022,
      agentHost: "192.168.109.11",
      identityPath: "/instance/ssh/rootcell_control_ed25519",
      knownHostsPath: "/instance/ssh/known_hosts",
      controlPath: "/state/rootcell-ssh-test/%C",
    });
    expect(configText).toContain("Host rootcell-firewall");
    expect(configText).toContain("HostName 127.0.0.1");
    expect(configText).toContain("Port 60022");
    expect(configText).toContain("Host rootcell-agent");
    expect(configText).toContain("HostName 192.168.109.11");
    expect(configText).toContain("ProxyCommand ssh -F /dev/null -W %h:%p -p 60022 -l luser");
    expect(configText).toContain("IdentityFile /instance/ssh/rootcell_control_ed25519");
    expect(configText).toContain("BatchMode yes");
    expect(configText).toContain("PasswordAuthentication no");
    expect(configText).toContain("KbdInteractiveAuthentication no");
    expect(configText).toContain("ServerAliveInterval 5");
    expect(configText).toContain("ServerAliveCountMax 3");
    expect(configText).toContain("ControlMaster auto");
    expect(configText).toContain("ControlPersist 60s");
    expect(configText).toContain("ControlPath /state/rootcell-ssh-test/%C");
  });

  test("ssh configs quote paths with spaces", () => {
    const identityPath = "/Users/jmp/Library/Mobile Documents/rootcell/ssh/rootcell_control_ed25519";
    const knownHostsPath = "/Users/jmp/Library/Mobile Documents/rootcell/ssh/known_hosts";
    const configText = sshConfig({
      user: "luser",
      firewallHost: "127.0.0.1",
      firewallPort: 60022,
      agentHost: "192.168.109.11",
      identityPath,
      knownHostsPath,
    });
    expect(configText).toContain(`IdentityFile "${identityPath}"`);
    expect(configText).toContain(`UserKnownHostsFile "${knownHostsPath}"`);
    expect(configText).toContain(`-i '${identityPath}'`);
    expect(configText).toContain(`-o 'UserKnownHostsFile=${knownHostsPath}'`);
    expect(configText).not.toContain("ProxyJump");

    const bootstrapConfig = directSshConfig({
      hostAlias: "rootcell-agent-bootstrap",
      user: "luser",
      host: "127.0.0.1",
      port: 60022,
      identityPath,
      knownHostsPath,
    });
    expect(bootstrapConfig).toContain(`IdentityFile "${identityPath}"`);
    expect(bootstrapConfig).toContain(`UserKnownHostsFile "${knownHostsPath}"`);
  });

  test("proxyjump known_hosts removal clears only the rotated VM host", () => {
    const dir = mkdtempSync(join(tmpdir(), "rootcell-known-hosts-"));
    try {
      const path = join(dir, "known_hosts");
      writeFileSync(path, [
        "[127.0.0.1]:60022 ssh-ed25519 firewall",
        "192.168.109.11 ssh-ed25519 old-agent",
        "[192.168.109.11]:22 ssh-ed25519 bracketed-agent",
        "github.com ssh-ed25519 github",
        "",
      ].join("\n"));

      forgetKnownHost(path, "192.168.109.11");

      const content = readFileSync(path, "utf8");
      expect(content).toContain("[127.0.0.1]:60022 ssh-ed25519 firewall");
      expect(content).not.toContain("old-agent");
      expect(content).not.toContain("bracketed-agent");
      expect(content).toContain("github.com ssh-ed25519 github");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("proxyjump known_hosts removal supports Lima localhost SSH ports", () => {
    const dir = mkdtempSync(join(tmpdir(), "rootcell-known-hosts-"));
    try {
      const path = join(dir, "known_hosts");
      writeFileSync(path, [
        "[127.0.0.1]:60022 ssh-ed25519 old-firewall",
        "[127.0.0.1]:60023 ssh-ed25519 other-vm",
        "",
      ].join("\n"));

      forgetKnownHost(path, "127.0.0.1", 60022);

      const content = readFileSync(path, "utf8");
      expect(content).not.toContain("old-firewall");
      expect(content).toContain("other-vm");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Lima state parser validates running state shape", () => {
    const state = parseLimaVmState({
      provider: "lima",
      name: "firewall-dev",
      role: "firewall",
      privateInterface: "enp0s1",
      egressInterface: "enp0s2",
      privateIp: "192.168.109.10",
      networkName: "rootcell-123456abcdef",
      hasEgress: true,
      limaInstance: "firewall-dev",
      yamlPath: "/vm/lima.yaml",
      sshLocalPort: 60022,
    });
    expect(state).toEqual(expect.schemaMatching(z.object({
      provider: z.literal("lima"),
      name: z.literal("firewall-dev"),
      role: z.literal("firewall"),
      privateInterface: z.literal("enp0s1"),
      egressInterface: z.literal("enp0s2"),
      privateIp: z.literal("192.168.109.10"),
      networkName: z.literal("rootcell-123456abcdef"),
      hasEgress: z.literal(true),
      limaInstance: z.literal("firewall-dev"),
      yamlPath: z.literal("/vm/lima.yaml"),
      sshLocalPort: z.literal(60022),
    }).strict()));
    expect(state.sshLocalPort).toBe(60022);
    expect(() => parseLimaVmState({ provider: "unknown" })).toThrow("provider mismatch");
  });

  test("Lima transport refreshes stale firewall SSH local ports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rootcell-lima-port-test-"));
    const oldPath = process.env.PATH;
    const oldLimactl = process.env.ROOTCELL_LIMACTL;
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin, { recursive: true });
      const limactl = join(bin, "limactl");
      writeFileSync(limactl, [
        "#!/bin/sh",
        "if [ \"$1\" = \"list\" ] && [ \"$2\" = \"--format\" ] && [ \"$3\" = \"{{.SSHLocalPort}}\" ]; then",
        "  printf '61000\\n'",
        "  exit 0",
        "fi",
        "echo unexpected limactl \"$@\" >&2",
        "exit 1",
        "",
      ].join("\n"), "utf8");
      chmodSync(limactl, 0o755);
      const ssh = join(bin, "ssh");
      writeFileSync(ssh, [
        "#!/bin/sh",
        "config=",
        "while [ \"$#\" -gt 0 ]; do",
        "  if [ \"$1\" = \"-F\" ]; then",
        "    config=$2",
        "    shift 2",
        "    continue",
        "  fi",
        "  shift",
        "done",
        "if grep -q 'Port 61000' \"$config\"; then",
        "  exit 0",
        "fi",
        "echo stale SSH port >&2",
        "exit 255",
        "",
      ].join("\n"), "utf8");
      chmodSync(ssh, 0o755);

      process.env.ROOTCELL_LIMACTL = limactl;
      process.env.PATH = `${bin}:${oldPath ?? ""}`;
      const config = buildConfig(dir, {}, fakeInstance("dev", dir));
      const stateDir = join(config.instanceDir, "v", "f");
      mkdirSync(stateDir, { recursive: true });
      const statePath = join(stateDir, "state.json");
      writeFileSync(statePath, `${JSON.stringify({
        provider: "lima",
        name: config.firewallVm,
        role: "firewall",
        limaInstance: config.firewallVm,
        yamlPath: join(stateDir, "lima.yaml"),
        privateInterface: "enp0s1",
        egressInterface: "enp0s2",
        privateIp: config.firewallIp,
        networkName: limaUserV2NetworkName(config),
        hasEgress: true,
        sshLocalPort: 60000,
      }, null, 2)}\n`, "utf8");

      const provider = new LimaVmProvider(config, ignoreLog);
      const result = await provider.execCapture(config.firewallVm, ["true"], { allowFailure: true });

      expect(result.status).toBe(0);
      expect(parseLimaVmState(JSON.parse(readFileSync(statePath, "utf8"))).sshLocalPort).toBe(61000);
    } finally {
      process.env.PATH = oldPath;
      if (oldLimactl === undefined) {
        delete process.env.ROOTCELL_LIMACTL;
      } else {
        process.env.ROOTCELL_LIMACTL = oldLimactl;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("formats VM state list", () => {
    expect(formatVmList([
      { instance: "default", vm: "agent", state: "running" },
      { instance: "dev", vm: "firewall-dev", state: "stopped" },
    ])).toBe([
      "INSTANCE  VM            STATE",
      "default   agent         running",
      "dev       firewall-dev  stopped",
      "",
    ].join("\n"));
    expect(formatVmList([])).toBe("No rootcell VMs found.\n");
  });
});

describe("rootcell image manifest contract", () => {
  test("parses compatible manifest and selects role images", () => {
    const manifest = parseRootcellImageManifest(fakeManifest());
    expect(manifest).toEqual(expect.schemaMatching(RootcellImageManifestSchema));
    expect(manifest.schemaVersion).toBe(ROOTCELL_IMAGE_SCHEMA_VERSION);
    expect(manifest.guestApiVersion).toBe(ROOTCELL_GUEST_API_VERSION);
    expect(imageForRole(manifest, "agent").fileName).toBe("agent.raw.zst");
  });

  test("resolves relative image asset URLs against the manifest URL", () => {
    expect(imageDownloadUrl(
      "agent.raw.zst",
      "https://github.com/rootcell-ai/rootcell/releases/download/guest-v1/manifest.json",
    )).toBe("https://github.com/rootcell-ai/rootcell/releases/download/guest-v1/agent.raw.zst");
    expect(imageDownloadUrl(
      "https://downloads.example/rootcell/agent.raw.zst",
      "https://github.com/rootcell-ai/rootcell/releases/download/guest-v1/manifest.json",
    )).toBe("https://downloads.example/rootcell/agent.raw.zst");
  });

  test("rejects incompatible guest API and CLI contract", () => {
    expect(() => parseRootcellImageManifest({ ...fakeManifest(), guestApiVersion: 99 })).toThrow("guestApiVersion");
    const missingContract = fakeManifest();
    delete missingContract.rootcellCliContract;
    expect(() => parseRootcellImageManifest(missingContract)).toThrow("rootcellCliContract");
    expect(() => parseRootcellImageManifest({
      ...fakeManifest(),
      rootcellCliContract: { min: 2, max: 2 },
    })).toThrow("CLI image contract");
  });

  test("caches parsed manifests by image source", () => {
    const repo = makeInstanceRepo();
    const imageDir = join(repo, "images");
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(join(imageDir, "manifest.json"), `${JSON.stringify(fakeManifest())}\n`, "utf8");
    try {
      const config = buildConfig("/repo", { ROOTCELL_IMAGE_DIR: imageDir }, fakeInstance("dev"));
      expect(new ImageStore(config, ignoreLog).loadManifest().rootcellSourceRevision).toBe("abc123");
      writeFileSync(join(imageDir, "manifest.json"), `${JSON.stringify({
        ...fakeManifest(),
        guestApiVersion: 99,
      })}\n`, "utf8");
      expect(new ImageStore(config, ignoreLog).loadManifest().rootcellSourceRevision).toBe("abc123");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("instance state", () => {
  test("derives VM names from instance names", () => {
    expect(deriveVmNames("default")).toEqual({ agentVm: "agent", firewallVm: "firewall" });
    expect(deriveVmNames("dev")).toEqual({ agentVm: "agent-dev", firewallVm: "firewall-dev" });
  });

  test("defaults instance state to cwd instances directory", () => {
    expect(instancePaths("/repo", "default", {}).dir).toBe("/repo/instances/default");
    expect(instancePaths("/repo", "dev", {}).dir).toBe("/repo/instances/dev");
  });

  test("allocates stable unique /24 networks", () => {
    const repo = makeInstanceRepo();
    try {
      const envA = instanceEnv(repo);
      seedRootcellInstanceFiles(repo, "default", ignoreLog, envA);
      loadDotEnv(instancePaths(repo, "default", envA).envPath, envA);
      const defaultInstance = loadRootcellInstance(repo, "default", envA);
      expect(defaultInstance).toEqual(expect.schemaMatching(RootcellInstanceSchema));

      const envB = instanceEnv(repo);
      seedRootcellInstanceFiles(repo, "dev", ignoreLog, envB);
      loadDotEnv(instancePaths(repo, "dev", envB).envPath, envB);
      const devInstance = loadRootcellInstance(repo, "dev", envB);
      expect(devInstance).toEqual(expect.schemaMatching(RootcellInstanceSchema));

      expect(defaultInstance.state.subnet).toBe("192.168.100.0");
      expect(defaultInstance.state.firewallIp).toBe("192.168.100.10");
      expect(devInstance.state.subnet).toBe("192.168.101.0");
      expect(devInstance.state.agentIp).toBe("192.168.101.11");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("honors explicit first-run .10/.11 subnet pins", () => {
    const repo = makeInstanceRepo();
    try {
      const env = {
        ...instanceEnv(repo),
        FIREWALL_IP: "192.168.109.10",
        AGENT_IP: "192.168.109.11",
        NETWORK_PREFIX: "24",
      };
      seedRootcellInstanceFiles(repo, "dev", ignoreLog, env);
      const instance = loadRootcellInstance(repo, "dev", env);
      expect(instance.state.subnet).toBe("192.168.109.0");
      expect(instance.state.firewallIp).toBe("192.168.109.10");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("rejects duplicate instance subnets", () => {
    const repo = makeInstanceRepo();
    try {
      const env = instanceEnv(repo);
      seedRootcellInstanceFiles(repo, "default", ignoreLog, env);
      seedRootcellInstanceFiles(repo, "dev", ignoreLog, env);
      writeFileSync(instancePaths(repo, "default", env).statePath, stateJson("default", "192.168.100"), "utf8");
      writeFileSync(instancePaths(repo, "dev", env).statePath, stateJson("dev", "192.168.100"), "utf8");
      expect(() => loadRootcellInstance(repo, "default", env)).toThrow("allocated to multiple rootcell instances");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("lists only instances with Lima VM state", () => {
    const repo = makeInstanceRepo();
    try {
      const env = instanceEnv(repo);
      seedRootcellInstanceFiles(repo, "default", ignoreLog, env);
      seedRootcellInstanceFiles(repo, "dev", ignoreLog, env);
      mkdirSync(join(instancePaths(repo, "dev", env).dir, "v", "a"), { recursive: true });
      writeFileSync(instancePaths(repo, "default", env).statePath, stateJson("default", "192.168.100"), "utf8");
      writeFileSync(instancePaths(repo, "dev", env).statePath, stateJson("dev", "192.168.101"), "utf8");

      expect(listRootcellVmInstanceNames(repo, env)).toEqual(["dev"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("reload helper", () => {
  test("generates dnsmasq server entries from non-comment lines", () => {
    const config = dnsmasqAllowlistConfig("# comment\n\nexample.com\n*.example.org\n");
    expect(config).toBe("server=/example.com/127.0.0.53\nserver=/*.example.org/127.0.0.53\n");
    expect(generatedLineCount(config)).toBe(2);
  });

  test("generates dnsmasq catch-all entry from wildcard line", () => {
    const config = dnsmasqAllowlistConfig("  *  \n");
    expect(config).toBe("server=/#/127.0.0.53\n");
    expect(generatedLineCount(config)).toBe(1);
  });
});

describe("completion files", () => {
  test("bash and zsh completions are generated by yargs", () => {
    const bash = readFileSync("completions/rootcell.bash", "utf8");
    const zsh = readFileSync("completions/rootcell.zsh", "utf8");
    expect(bash).toBe(generatedCompletion("/bin/bash"));
    expect(zsh).toBe(generatedCompletion("/bin/zsh"));
    expect(bash).toContain("yargs command completion script");
    expect(zsh).toContain("yargs command completion script");
  });

  test("yargs completion API includes all typed subcommands", () => {
    const choices = runCapture("./rootcell", ["--get-yargs-completions", "rootcell", ""], {
      env: completionEnv("/bin/bash"),
    }).stdout;
    for (const subcommand of ROOTCELL_SUBCOMMANDS) {
      expect(choices).toContain(subcommand.name);
    }
  });
});

function runArgs(args: readonly string[]): ParsedRootcellRunArgs {
  const parsed = parseRootcellArgs(args);
  if (parsed.kind !== "run") {
    throw new Error("expected parsed rootcell run args");
  }
  return parsed;
}

function generatedCompletion(shell: string): string {
  return stripTrailingBlankLine(runCapture("./rootcell", ["completion"], { env: completionEnv(shell) }).stdout);
}

function completionEnv(shell: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, SHELL: shell };
  delete env.ZSH_NAME;
  return env;
}

function stripTrailingBlankLine(text: string): string {
  return text.endsWith("\n\n") ? text.slice(0, -1) : text;
}

function removedRuntimeNames(): readonly string[] {
  return [["vf", "kit"].join(""), ["socket", "_vmnet"].join("")];
}

function fakeInstance(name: string, repo = "/repo", env: NodeJS.ProcessEnv = {}): RootcellInstance {
  const paths = instancePaths(repo, name, env);
  return {
    name,
    dir: paths.dir,
    envPath: paths.envPath,
    secretsPath: paths.secretsPath,
    proxyDir: paths.proxyDir,
    pkiDir: paths.pkiDir,
    generatedDir: paths.generatedDir,
    statePath: paths.statePath,
    state: {
      schemaVersion: 1,
      subnet: "192.168.109.0",
      networkPrefix: 24,
      firewallIp: "192.168.109.10",
      agentIp: "192.168.109.11",
    },
  };
}

function instanceEnv(repo: string): NodeJS.ProcessEnv {
  return { ROOTCELL_STATE_DIR: join(repo, ".state") };
}

function makeInstanceRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "rootcell-instance-test-"));
  mkdirSync(join(repo, "proxy"), { recursive: true });
  writeFileSync(join(repo, ".env.defaults"), "AWS_REGION=us-east-1\n", "utf8");
  writeFileSync(join(repo, "secrets.env.defaults"), "AWS_BEARER_TOKEN_BEDROCK=macos-keychain:aws-bedrock-api-key\n", "utf8");
  for (const file of ["allowed-https.txt", "allowed-ssh.txt", "allowed-dns.txt"]) {
    writeFileSync(join(repo, "proxy", `${file}.defaults`), "\n", "utf8");
  }
  return repo;
}

function stateJson(name: string, prefix: string): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    subnet: `${prefix}.0`,
    networkPrefix: 24,
    firewallIp: `${prefix}.10`,
    agentIp: `${prefix}.11`,
  }, null, 2)}\n`;
}

function fakeManifest(): Record<string, unknown> {
  const image = {
    role: "agent",
    architecture: "aarch64-linux",
    fileName: "agent.raw.zst",
    url: "https://example.invalid/agent.raw.zst",
    compression: "zstd",
    compressedSize: 100,
    rawSize: 1000,
    sha256: "0".repeat(64),
  };
  return {
    schemaVersion: ROOTCELL_IMAGE_SCHEMA_VERSION,
    guestApiVersion: ROOTCELL_GUEST_API_VERSION,
    rootcellSourceRevision: "abc123",
    nixpkgsRevision: "def456",
    rootcellCliContract: { min: 1, max: 1 },
    images: [
      image,
      { ...image, role: "firewall", fileName: "firewall.raw.zst", url: "https://example.invalid/firewall.raw.zst" },
      { ...image, role: "builder", fileName: "builder.raw.zst", url: "https://example.invalid/builder.raw.zst" },
    ],
  };
}
