import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseRootcellArgs } from "./args.ts";
import { loadDotEnv, nixString, parseSecretMappings } from "./env.ts";
import { runExtensionCommand } from "./extensions/commands.ts";
import type { ExtensionHostCommandContext } from "./extensions/registry.ts";
import { enabledExtensionIds, ensureExtensionsConfig } from "./extensions/config.ts";
import { GENERATED_EXTENSION_HOOK_FILES, writeExtensionNixAggregators } from "./extensions/nix.ts";
import { DEFAULT_IMAGE_MANIFEST_URL } from "./images.ts";
import { initRootcellInstanceEnv } from "./init-env.ts";
import {
  deriveVmNames,
  instancePaths,
  listRootcellVmInstanceNames,
  loadExistingRootcellInstance,
  loadRootcellInstance,
  readSelectedRootcellInstance,
  seedRootcellInstanceFiles,
  SelectedInstanceStateError,
  writeSelectedRootcellInstance,
} from "./instance.ts";
import { runCapture, runInherited } from "./process.ts";
import { parseAwsEc2Config, parseRootcellVmProvider } from "./providers/aws-ec2-config.ts";
import { createProviderBundle } from "./providers/factory.ts";
import type { NetworkPlan, ProviderBundle, VmNetworkAttachment, VmRole, VmStatus } from "./providers/types.ts";
import { parseSchema } from "./schema.ts";
import { parseAwsSecretsManagerProviderConfigs } from "./secrets/aws-secrets-manager-config.ts";
import { openRoleTargetTunnel, waitForForegroundTunnel, type PortAvailabilityCheck } from "./tunnels.ts";
import { RootcellConfigSchema, type RootcellConfig, type RootcellInstance, type SpyOptions, type VmFileSet } from "./types.ts";

const GUEST_USER = "luser";

const EDIT_PROXY_FILES = {
  http: "allowed-https.txt",
  https: "allowed-https.txt",
  dns: "allowed-dns.txt",
  ssh: "allowed-ssh.txt",
} as const;

const EDIT_TARGETS = ["env", "http", "https", "dns", "ssh", "extensions"] as const;

const VM_FILES: VmFileSet = {
  agent: [
    "flake.nix",
    "flake.lock",
    "common.nix",
    "agent-vm.nix",
    "home.nix",
    "network.nix",
    "pi",
    "extensions",
  ],
  firewall: [
    "flake.nix",
    "flake.lock",
    "common.nix",
    "firewall-vm.nix",
    "network.nix",
    "extensions",
    "proxy",
    "src/bin/reload.ts",
    "dist/spy-service.js",
    "dist/spy-ui",
  ],
};

const SPY_REMOTE_HOST = "127.0.0.1";
const SPY_DEFAULT_PORT = 6174;
const SPY_ENV_DEFAULTS = {
  ROOTCELL_SPY_ENABLED: "false",
  ROOTCELL_SPY_RETENTION_DAYS: "7",
  ROOTCELL_SPY_MAX_BYTES: "6442450944",
  ROOTCELL_SPY_SPOOL_MAX_BYTES: "1073741824",
  ROOTCELL_SPY_STORE_RAW: "false",
  ROOTCELL_SPY_TOKEN_COUNT_MODE: "provider",
  ROOTCELL_SPY_BIND: SPY_REMOTE_HOST,
  ROOTCELL_SPY_PORT: String(SPY_DEFAULT_PORT),
} as const;
const SPY_ENV_KEYS = Object.keys(SPY_ENV_DEFAULTS) as (keyof typeof SPY_ENV_DEFAULTS)[];
const SPY_BEDROCK_SECRET_ENV_NAMES = new Set([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
]);

export interface VmListEntry {
  readonly instance: string;
  readonly vm: string;
  readonly state: string;
}

export interface VmListFormatOptions {
  readonly selectedInstance?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdoutIsTty?: boolean;
  readonly color?: boolean;
}

export interface RootcellAppOptions {
  readonly tunnelPortAvailable?: PortAvailabilityCheck;
}

function log(message: string): void {
  console.error(`rootcell: ${message}`);
}

export function formatVmList(entries: readonly VmListEntry[], options: VmListFormatOptions = {}): string {
  if (entries.length === 0) {
    return "No rootcell VMs found.\n";
  }
  const rows = [
    ["INSTANCE", "VM", "STATE"],
    ...entries.map((entry) => [formatInstanceCell(entry.instance, options.selectedInstance), entry.vm, entry.state]),
  ];
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
  return `${rows.map((row, index) => {
    const line = row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ").trimEnd();
    const entry = entries[index - 1];
    if (entry !== undefined && entry.instance === options.selectedInstance && shouldStyleSelectedRows(options)) {
      return ansiBoldGreen(line);
    }
    return line;
  }).join("\n")}\n`;
}

function formatInstanceCell(instance: string, selectedInstance: string | undefined): string {
  return instance === selectedInstance ? `${instance} (selected)` : instance;
}

function shouldStyleSelectedRows(options: VmListFormatOptions): boolean {
  if (options.color !== undefined) {
    return options.color;
  }
  const env = options.env ?? process.env;
  const stdoutIsTty = options.stdoutIsTty ?? process.stdout.isTTY;
  return stdoutIsTty && env.NO_COLOR === undefined;
}

function ansiBoldGreen(value: string): string {
  return `\u001b[1;32m${value}\u001b[0m`;
}

function statusText(status: VmStatus): string {
  return status.state === "unexpected" ? `unexpected: ${status.detail}` : status.state;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const AGENT_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";
const AGENT_CA_DIR = "/etc/ssl/certs";
const AGENT_CA_DAYS = "3650";
const AGENT_CA_SUBJECT = "/CN=agent-vm proxy CA";
const AGENT_CA_EXTENSIONS = [
  "basicConstraints=critical,CA:TRUE,pathlen:0",
  "keyUsage=critical,keyCertSign,cRLSign",
  "subjectKeyIdentifier=hash",
  "authorityKeyIdentifier=keyid:always",
] as const;
const AGENT_CA_ENV = [
  ["NODE_EXTRA_CA_CERTS", AGENT_CA_BUNDLE],
  ["NIX_SSL_CERT_FILE", AGENT_CA_BUNDLE],
  ["SSL_CERT_FILE", AGENT_CA_BUNDLE],
  ["SSL_CERT_DIR", AGENT_CA_DIR],
  ["REQUESTS_CA_BUNDLE", AGENT_CA_BUNDLE],
  ["CURL_CA_BUNDLE", AGENT_CA_BUNDLE],
  ["GIT_SSL_CAINFO", AGENT_CA_BUNDLE],
  ["PIP_CERT", AGENT_CA_BUNDLE],
  ["AWS_CA_BUNDLE", AGENT_CA_BUNDLE],
  ["UV_NATIVE_TLS", "true"],
] as const;

function agentCaEnv(bundlePath = AGENT_CA_BUNDLE): readonly string[] {
  return AGENT_CA_ENV.map(([key, value]) => `${key}=${value === AGENT_CA_BUNDLE ? bundlePath : value}`);
}

function exportAgentCaEnvScript(bundlePath: string): string {
  return agentCaEnv(bundlePath).map((entry) => `export ${entry}`).join("\n");
}

function sudoAgentCaEnvScript(): string {
  return AGENT_CA_ENV.map(([key]) => `  ${key}="$${key}" \\`).join("\n");
}

function agentCaExtensionArgs(): readonly string[] {
  return AGENT_CA_EXTENSIONS.flatMap((extension) => ["-addext", extension]);
}

function agentCaHasStrictExtensions(crt: string): boolean {
  const result = runCapture("openssl", ["x509", "-in", crt, "-noout", "-text"], {
    allowFailure: true,
  });
  return result.status === 0
    && result.stdout.includes("X509v3 Subject Key Identifier")
    && result.stdout.includes("X509v3 Authority Key Identifier");
}

function nixStringList(values: readonly string[]): string {
  return `[ ${values.map(nixString).join(" ")} ]`;
}

function repoDirFromImportMeta(importMetaPath: string): string {
  let dir = dirname(resolve(importMetaPath));
  for (;;) {
    if (existsSync(join(dir, "flake.nix")) && existsSync(join(dir, "src/rootcell"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return resolve(dirname(importMetaPath), "../..");
    }
    dir = parent;
  }
}

export function buildConfig(repoDir: string, env: NodeJS.ProcessEnv, instance: RootcellInstance): RootcellConfig {
  const vmNames = deriveVmNames(instance.name);
  const vmProvider = parseRootcellVmProvider(env);
  return parseSchema(RootcellConfigSchema, {
    repoDir,
    instanceName: instance.name,
    instanceDir: instance.dir,
    envPath: instance.envPath,
    secretsPath: instance.secretsPath,
    extensionsPath: instance.extensionsPath,
    proxyDir: instance.proxyDir,
    pkiDir: instance.pkiDir,
    generatedDir: instance.generatedDir,
    agentVm: vmNames.agentVm,
    firewallVm: vmNames.firewallVm,
    guestUser: GUEST_USER,
    guestRepoDir: `/home/${GUEST_USER}/rootcell`,
    firewallIp: instance.state.firewallIp,
    agentIp: instance.state.agentIp,
    networkPrefix: String(instance.state.networkPrefix),
    imageManifestUrl: env.ROOTCELL_IMAGE_MANIFEST_URL ?? DEFAULT_IMAGE_MANIFEST_URL,
    ...(env.ROOTCELL_IMAGE_DIR === undefined || env.ROOTCELL_IMAGE_DIR.length === 0 ? {} : { imageDir: env.ROOTCELL_IMAGE_DIR }),
    awsSecretsManagerProviders: parseAwsSecretsManagerProviderConfigs(env),
    vmProvider,
    ...(vmProvider === "aws-ec2" ? { awsEc2: parseAwsEc2Config(env) } : {}),
  }, `invalid rootcell config for ${instance.name}`);
}

export class RootcellApp<TAttachment extends VmNetworkAttachment> {
  private readonly networkPlan: NetworkPlan<TAttachment>;

  constructor(
    private readonly config: RootcellConfig,
    private readonly providers: ProviderBundle<TAttachment>,
    private readonly options: RootcellAppOptions = {},
  ) {
    this.networkPlan = this.providers.network.plan();
  }

  async runAfterEnvironment(subcommand: string, rest: readonly string[], spyOptions: SpyOptions): Promise<number> {
    if (subcommand === "list") {
      process.stdout.write(formatVmList(await this.listVms()));
      return 0;
    }
    if (subcommand === "stop") {
      await this.stopVms();
      process.stdout.write(`stopped ${this.config.instanceName}\n`);
      return 0;
    }
    if (subcommand === "remove") {
      await this.removeVms();
      process.stdout.write(`stopped ${this.config.instanceName}, deleted state\n`);
      return 0;
    }

    this.writeNetworkLocalNix();
    const extensions = this.writeExtensionAggregators();
    if (subcommand === "provision") {
      log(`enabled extensions: ${enabledExtensionIds(extensions).join(", ") || "none"}`);
    }

    if (subcommand === "pubkey") {
      return await this.printPubkey();
    }

    if (subcommand === "spy" && !this.isSpyEnabled()) {
      this.printSpyReadinessFailure("disabled");
      return 1;
    }

    await this.providers.network.preflight();
    await this.ensureExistingVmNetworksCompatible();

    if (subcommand === "allow") {
      const status = await this.providers.vm.status(this.config.firewallVm);
      if (status.state !== "running") {
        log("firewall VM not running; start it with ./rootcell first.");
        return 1;
      }
      await this.syncAllowlists();
      log("allowlists reloaded.");
      return 0;
    }

    await this.providers.network.ensureReady({
      affectedVms: [this.config.agentVm, this.config.firewallVm],
      force: subcommand === "provision",
      stopVmIfRunning: async (name) => {
        await this.providers.vm.forceStopIfRunning(name);
      },
    });
    const caChanged = this.ensureCa();
    const needsProvisionForCa = subcommand === "provision" || caChanged;
    if (!await this.ensureFirewall(needsProvisionForCa, { allowProvision: subcommand !== "spy" })) {
      return 1;
    }
    await this.syncAllowlists();
    await this.waitForFirewallListeners();

    if (subcommand === "spy") {
      return await this.runSpy(spyOptions);
    }

    await this.ensureAgent(needsProvisionForCa);
    if (subcommand === "provision") {
      log("done.");
      return 0;
    }

    const injectedSecretEnv = await this.readSecretEnv();
    const command = rest.length === 0 ? ["bash", "-l"] : [...rest];
    return await this.providers.vm.execInteractive(this.config.agentVm, command, {
      allowFailure: true,
      env: [
        ...injectedSecretEnv,
        `AWS_REGION=${this.config.awsEc2?.region ?? process.env.AWS_REGION ?? "us-east-1"}`,
        ...agentCaEnv(),
      ],
    });
  }

  async listVms(): Promise<readonly VmListEntry[]> {
    return await Promise.all(this.vmEntries().map(async (entry) => ({
      instance: this.config.instanceName,
      vm: entry.name,
      state: statusText(await this.providers.vm.status(entry.name)),
    })));
  }

  async stopVms(): Promise<void> {
    for (const entry of this.vmEntries()) {
      await this.providers.vm.stopIfRunning(entry.name);
    }
    await this.waitForVmsStopped();
    await this.providers.network.stop();
  }

  async removeVms(): Promise<void> {
    await this.stopVms();
    for (const entry of this.vmEntries()) {
      await this.providers.vm.remove(entry.name);
    }
    await this.providers.network.remove();
  }

  private vmEntries(): readonly [
    { readonly role: "agent"; readonly name: string },
    { readonly role: "firewall"; readonly name: string },
  ] {
    return [
      { role: "agent", name: this.config.agentVm },
      { role: "firewall", name: this.config.firewallVm },
    ];
  }

  private async waitForVmsStopped(): Promise<void> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const statuses = await Promise.all(this.vmEntries().map(async (entry) => ({
        name: entry.name,
        status: await this.providers.vm.status(entry.name),
      })));
      const running = statuses.filter((entry) => entry.status.state === "running");
      if (running.length === 0) {
        return;
      }
      await sleep(200);
    }
    const statuses = await Promise.all(this.vmEntries().map(async (entry) => ({
      name: entry.name,
      status: statusText(await this.providers.vm.status(entry.name)),
    })));
    throw new Error(`timed out waiting for VMs to stop: ${statuses.map((entry) => `${entry.name}=${entry.status}`).join(", ")}`);
  }

  private writeNetworkLocalNix(): void {
    const network = this.networkPlan.guest;
    const content = [
      "# Generated by ./rootcell from this instance's state. DO NOT EDIT.",
      "{",
      `  provider      = ${nixString(this.networkPlan.provider)};`,
      `  firewallIp    = ${nixString(network.firewallIp)};`,
      `  agentIp       = ${nixString(network.agentIp)};`,
      `  agentDefaultGatewayIp = ${nixString(network.agentDefaultGatewayIp ?? network.firewallIp)};`,
      `  networkPrefix = ${String(network.networkPrefix)};`,
      `  agentPrivateInterface    = ${nixString(network.agentPrivateInterface)};`,
      `  firewallPrivateInterface = ${nixString(network.firewallPrivateInterface)};`,
      `  firewallEgressInterface  = ${nixString(network.firewallEgressInterface)};`,
      ...(network.firewallControlInterface === undefined ? [] : [
        `  firewallControlInterface = ${nixString(network.firewallControlInterface)};`,
      ]),
      ...(network.firewallUpstreamDns === undefined ? [] : [
        `  firewallUpstreamDns = ${nixStringList(network.firewallUpstreamDns)};`,
      ]),
      "}",
      "",
    ].join("\n");
    writeFileSync(join(this.config.generatedDir, "network-local.nix"), content, "utf8");
  }

  private writeExtensionAggregators(): ReturnType<typeof ensureExtensionsConfig> {
    const extensions = ensureExtensionsConfig(this.config.extensionsPath, log);
    writeExtensionNixAggregators(this.config.generatedDir, extensions);
    return extensions;
  }

  private async printPubkey(): Promise<number> {
    const status = await this.providers.vm.status(this.config.agentVm);
    if (status.state !== "running") {
      log("agent VM not running; start it with ./rootcell first.");
      return 1;
    }
    const keyPath = `/home/${this.config.guestUser}/.ssh/id_rsa.pub`;
    const keyExists = (await this.providers.vm.exec(this.config.agentVm, ["test", "-f", keyPath], {
      allowFailure: true,
      ignoredOutput: true,
    })).status === 0;
    if (!keyExists) {
      log("no SSH key in agent VM yet; run ./rootcell provision first.");
      return 1;
    }
    return (await this.providers.vm.exec(this.config.agentVm, ["cat", keyPath], { allowFailure: true })).status;
  }

  private async ensureExistingVmNetworksCompatible(): Promise<void> {
    await this.providers.vm.assertCompatible(this.config.firewallVm, this.networkPlan.vms.firewall);
    await this.providers.vm.assertCompatible(this.config.agentVm, this.networkPlan.vms.agent);
  }

  private async bootstrapAgentFirewallRoute(): Promise<void> {
    const network = this.networkPlan.guest;
    const script = `
set -euo pipefail
iface=${shellQuote(network.agentPrivateInterface)}
test -d "/sys/class/net/$iface"
systemctl stop dhcpcd.service 2>/dev/null || true
ip link set "$iface" up
ip addr flush dev "$iface"
ip addr add '${network.agentIp}/${String(network.networkPrefix)}' dev "$iface"
ip route replace default via '${network.agentDefaultGatewayIp ?? network.firewallIp}' dev "$iface"
if command -v resolvectl >/dev/null 2>&1; then
  resolvectl dns "$iface" '${network.firewallIp}' || true
  resolvectl domain "$iface" '~.' || true
fi
printf 'nameserver %s\\n' '${network.firewallIp}' > /etc/resolv.conf
`;
    await this.providers.vm.exec(this.config.agentVm, ["sudo", "bash", "-lc", script]);
  }

  private async bootstrapFirewallDns(): Promise<void> {
    const nameservers = this.networkPlan.guest.firewallUpstreamDns ?? [];
    if (nameservers.length === 0) {
      return;
    }
    const resolvConf = `${nameservers.map((nameserver) => `nameserver ${nameserver}`).join("\n")}\n`;
    await this.providers.vm.exec(this.config.firewallVm, [
      "bash",
      "-lc",
      `printf %s ${shellQuote(resolvConf)} | sudo tee /etc/resolv.conf >/dev/null`,
    ]);
  }

  private async bootstrapAgentFirewallTrust(): Promise<void> {
    const script = `
set -euo pipefail
cert='${this.config.guestRepoDir}/pki/agent-vm-ca-cert.pem'
bundle=/tmp/agent-vm-bootstrap-ca-bundle.crt
if [ -r /etc/ssl/certs/ca-certificates.crt ]; then
  cat /etc/ssl/certs/ca-certificates.crt "$cert" > "$bundle"
else
  cp "$cert" "$bundle"
fi
chmod 0644 "$bundle"
`;
    await this.providers.vm.exec(this.config.agentVm, ["bash", "-lc", script]);
  }

  private async copyRepoIntoVm(vm: string, files: readonly string[]): Promise<void> {
    await this.providers.vm.exec(vm, ["mkdir", "-p", this.config.guestRepoDir]);
    for (const file of files) {
      const parent = dirname(file);
      const guestParent = parent === "." ? this.config.guestRepoDir : join(this.config.guestRepoDir, parent);
      await this.providers.vm.exec(vm, ["mkdir", "-p", guestParent]);
      await this.providers.vm.copyToGuest(
        vm,
        join(this.config.repoDir, file),
        `${guestParent}/`,
        { recursive: true },
      );
    }
  }

  private async copyHostFileIntoVm(vm: string, hostPath: string, guestPath: string): Promise<void> {
    await this.providers.vm.exec(vm, ["mkdir", "-p", dirname(guestPath)]);
    await this.providers.vm.copyToGuest(vm, hostPath, guestPath);
  }

  private async copyGeneratedNetworkIntoVm(vm: string): Promise<void> {
    await this.copyHostFileIntoVm(
      vm,
      join(this.config.generatedDir, "network-local.nix"),
      join(this.config.guestRepoDir, "network-local.nix"),
    );
  }

  private async copyGeneratedGitIntoVm(vm: string): Promise<void> {
    await this.copyHostFileIntoVm(
      vm,
      join(this.config.generatedDir, "git-local.nix"),
      join(this.config.guestRepoDir, "git-local.nix"),
    );
  }

  private async copyGeneratedExtensionsIntoVm(vm: string): Promise<void> {
    for (const file of GENERATED_EXTENSION_HOOK_FILES) {
      await this.copyHostFileIntoVm(
        vm,
        join(this.config.generatedDir, file),
        join(this.config.guestRepoDir, "generated", file),
      );
    }
  }

  private async copyAgentCaIntoVm(vm: string): Promise<void> {
    await this.copyHostFileIntoVm(
      vm,
      join(this.config.pkiDir, "agent-vm-ca-cert.pem"),
      join(this.config.guestRepoDir, "pki/agent-vm-ca-cert.pem"),
    );
  }

  private writeGitLocalNix(): void {
    const name = runCapture("git", ["config", "--global", "user.name"], { allowFailure: true }).stdout.trim();
    const email = runCapture("git", ["config", "--global", "user.email"], { allowFailure: true }).stdout.trim();
    const lines = ["{"];
    if (name.length > 0) {
      lines.push(`  programs.git.settings.user.name  = ${nixString(name)};`);
    }
    if (email.length > 0) {
      lines.push(`  programs.git.settings.user.email = ${nixString(email)};`);
    }
    lines.push("}", "");
    writeFileSync(join(this.config.generatedDir, "git-local.nix"), lines.join("\n"), "utf8");
  }

  private async waitForFirewallListeners(): Promise<void> {
    const probe = `
for _ in $(seq 1 300); do
  if ss -tlnH | awk "{print \\$4}" | grep -qE ":8080$" \\
     && ss -tlnH | awk "{print \\$4}" | grep -qE ":8081$" \\
     && ss -ulnH | awk "{print \\$4}" | grep -qE ":53$"; then
    exit 0
  fi
  sleep 0.2
done
exit 1
`;
    const ready = (await this.providers.vm.exec(this.config.firewallVm, ["bash", "-c", probe], {
      allowFailure: true,
      ignoredOutput: true,
    })).status === 0;
    if (ready) {
      return;
    }
    log("timeout waiting for firewall services");
    await this.providers.vm.exec(this.config.firewallVm, [
      "journalctl",
      "--no-pager",
      "-n",
      "50",
      "-u",
      "mitmproxy-explicit",
      "-u",
      "mitmproxy-transparent",
      "-u",
      "dnsmasq",
    ], { allowFailure: true });
    process.exit(1);
  }

  private async syncAllowlists(): Promise<void> {
    await this.waitForFirewallSsh();
    for (const file of ["allowed-https.txt", "allowed-ssh.txt", "allowed-dns.txt"]) {
      await this.providers.vm.copyToGuest(
        this.config.firewallVm,
        join(this.config.proxyDir, file),
        `/etc/agent-vm/${file}`,
      );
    }
    await this.providers.vm.exec(this.config.firewallVm, ["sudo", "/etc/agent-vm/reload.sh"]);
  }

  private async waitForFirewallSsh(): Promise<void> {
    let lastError = "";
    for (let attempt = 0; attempt < 120; attempt += 1) {
      try {
        const result = await this.providers.vm.execCapture(this.config.firewallVm, ["true"], {
          allowFailure: true,
        });
        if (result.status === 0) {
          return;
        }
        const message = `${result.stderr}${result.stdout}`.trim();
        if (message.length > 0) {
          lastError = message;
        }
      } catch (error) {
        lastError = messageFromUnknown(error);
      }
      await sleep(500);
    }
    throw new Error(`timeout waiting for SSH transport to ${this.config.firewallVm}${lastError.length === 0 ? "" : `: ${lastError}`}`);
  }

  private ensureCa(): boolean {
    const dir = this.config.pkiDir;
    const key = join(dir, "agent-vm-ca.key");
    const crt = join(dir, "agent-vm-ca-cert.pem");
    const pem = join(dir, "agent-vm-ca.pem");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);

    let changed = false;
    if (!existsSync(key) || !existsSync(crt)) {
      log(`generating TLS-MITM CA for instance '${this.config.instanceName}' (one-time, persists across runs)`);
      this.generateCa(key, crt);
      changed = true;
    } else if (!agentCaHasStrictExtensions(crt)) {
      log("updating TLS-MITM CA certificate for strict Python/OpenSSL certificate verification");
      if (!this.reissueCaCert(key, crt)) {
        log("existing TLS-MITM CA key/cert could not be reused; generating a fresh CA");
        this.generateCa(key, crt);
      }
      changed = true;
    }

    const pemContent = readFileSync(key, "utf8") + readFileSync(crt, "utf8");
    if (!existsSync(pem) || readFileSync(pem, "utf8") !== pemContent) {
      writeFileSync(pem, pemContent, "utf8");
      changed = true;
    }
    chmodSync(key, 0o600);
    chmodSync(pem, 0o600);
    chmodSync(crt, 0o644);
    return changed;
  }

  private generateCa(key: string, crt: string): void {
    const tmpKey = `${key}.tmp`;
    const tmpCrt = `${crt}.tmp`;
    rmSync(tmpKey, { force: true });
    rmSync(tmpCrt, { force: true });
    runInherited("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      tmpKey,
      "-out",
      tmpCrt,
      "-days",
      AGENT_CA_DAYS,
      "-subj",
      AGENT_CA_SUBJECT,
      ...agentCaExtensionArgs(),
    ], { ignoredOutput: true });
    renameSync(tmpKey, key);
    renameSync(tmpCrt, crt);
  }

  private reissueCaCert(key: string, crt: string): boolean {
    const tmpCrt = `${crt}.tmp`;
    rmSync(tmpCrt, { force: true });
    const result = runInherited("openssl", [
      "req",
      "-x509",
      "-new",
      "-key",
      key,
      "-out",
      tmpCrt,
      "-days",
      AGENT_CA_DAYS,
      "-subj",
      AGENT_CA_SUBJECT,
      ...agentCaExtensionArgs(),
    ], {
      allowFailure: true,
      ignoredOutput: true,
    });
    if (result.status !== 0) {
      rmSync(tmpCrt, { force: true });
      return false;
    }
    renameSync(tmpCrt, crt);
    return true;
  }

  private async syncFirewallCa(): Promise<void> {
    const pem = join(this.config.pkiDir, "agent-vm-ca.pem");
    await this.providers.vm.copyToGuest(this.config.firewallVm, pem, "/tmp/.agent-vm-ca.pem.staged");
    await this.providers.vm.exec(this.config.firewallVm, [
      "sudo",
      "install",
      "-D",
      "-m",
      "0600",
      "-o",
      "root",
      "-g",
      "root",
      "/tmp/.agent-vm-ca.pem.staged",
      "/etc/agent-vm/agent-vm-ca.pem",
    ]);
    await this.providers.vm.exec(this.config.firewallVm, ["rm", "-f", "/tmp/.agent-vm-ca.pem.staged"]);
  }

  private nixosConfiguration(role: "agent" | "firewall"): string {
    return role === "agent" ? "agent-vm" : "firewall-vm";
  }

  private guestFlakeRef(attribute: string): string {
    return `path:${this.config.guestRepoDir}#${attribute}`;
  }

  private async runSpy(options: SpyOptions): Promise<number> {
    const readiness = await this.checkFirewallSpyReadiness();
    if (readiness !== "ready") {
      if (readiness === "disabled") {
        log("firewall spy config is disabled or stale.");
        log("run ./rootcell provision, then try ./rootcell spy again.");
        return 1;
      }
      this.printSpyReadinessFailure(readiness);
      return 1;
    }

    const remotePort = this.spyRemotePort();
    const launchTs = Math.floor(Date.now() / 1000);
    const tunnelOptions = this.options.tunnelPortAvailable === undefined
      ? {}
      : { portAvailable: this.options.tunnelPortAvailable };
    const tunnel = await openRoleTargetTunnel(
      (role, forwardOptions) => this.providers.vm.forwardLocalPort(vmNameForRole(this.config, role), forwardOptions),
      {
        role: "firewall",
        preferredLocalPort: SPY_DEFAULT_PORT,
        localHost: "127.0.0.1",
        remoteHost: SPY_REMOTE_HOST,
        remotePort,
      },
      tunnelOptions,
    );

    const localPort = tunnel.localPort;
    const url = `http://127.0.0.1:${String(localPort)}/?since=${String(launchTs)}`;
    process.stdout.write(`${url}\n`);
    log(`rootcell spy available at ${url} (Ctrl-C closes the tunnel)`);
    if (options.open) {
      this.openBrowser(url);
    }

    return await waitForForegroundTunnel(tunnel, { log });
  }

  private async checkFirewallSpyReadiness(): Promise<"ready" | "disabled" | "missing" | "inactive" | "unhealthy"> {
    const remotePort = this.spyRemotePort();
    const script = `
set -e
if ! sudo test -f /etc/agent-vm/spy.env; then
  echo missing-env
  exit 10
fi
if ! sudo grep -Eq '^ROOTCELL_SPY_ENABLED=(1|true|yes|on)$' /etc/agent-vm/spy.env; then
  echo disabled
  exit 11
fi
if ! systemctl cat rootcell-spy.service >/dev/null 2>&1; then
  echo missing-unit
  exit 12
fi
if [ ! -f /etc/agent-vm/spy-service.js ] || [ ! -f /etc/agent-vm/spy-ui/index.html ]; then
  echo missing-assets
  exit 13
fi
if ! systemctl is-active rootcell-spy.service >/dev/null 2>&1; then
  echo inactive
  exit 14
fi
if ! bun -e ${shellQuote(`const r = await fetch("http://${SPY_REMOTE_HOST}:${String(remotePort)}/api/health"); process.exit(r.ok ? 0 : 1);`)} >/dev/null 2>&1; then
  echo unhealthy
  exit 15
fi
`;
    const result = await this.providers.vm.execCapture(this.config.firewallVm, ["bash", "-lc", script], {
      allowFailure: true,
    });
    if (result.status === 0) {
      return "ready";
    }
    const marker = result.stdout.trim();
    if (marker === "disabled") {
      return "disabled";
    }
    if (marker === "inactive") {
      return "inactive";
    }
    if (marker === "unhealthy") {
      return "unhealthy";
    }
    return "missing";
  }

  private printSpyReadinessFailure(readiness: "disabled" | "missing" | "inactive" | "unhealthy"): void {
    if (readiness === "disabled") {
      log(`spy is disabled for instance '${this.config.instanceName}'.`);
      log(`set ROOTCELL_SPY_ENABLED=true in ${this.config.envPath}, then run ./rootcell provision.`);
      return;
    }
    if (readiness === "inactive") {
      log("rootcell-spy.service is not active on the firewall VM.");
      log("run ./rootcell provision, then try ./rootcell spy again.");
      return;
    }
    if (readiness === "unhealthy") {
      log("rootcell-spy.service is active but /api/health is not responding.");
      log("run ./rootcell provision or inspect journalctl -u rootcell-spy.service on the firewall VM.");
      return;
    }
    log("spy service files or assets are missing on the firewall VM.");
    log("run ./rootcell provision, then try ./rootcell spy again.");
  }

  private openBrowser(url: string): void {
    const command = process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    try {
      const result = runInherited(command, args, { allowFailure: true, ignoredOutput: true });
      if (result.status !== 0) {
        log(`could not open browser automatically; open ${url}`);
      }
    } catch {
      log(`could not open browser automatically; open ${url}`);
    }
  }

  private spyRemotePort(): number {
    return positiveIntegerFromEnv(process.env.ROOTCELL_SPY_PORT, SPY_DEFAULT_PORT);
  }

  private isSpyEnabled(): boolean {
    return envBoolean(process.env.ROOTCELL_SPY_ENABLED, false);
  }

  private isSpyProviderTokenCountingEnabled(): boolean {
    return true;
  }

  private buildSpyArtifacts(): void {
    log("building spy service and browser assets...");
    runInherited("bun", ["run", "build:spy"], {
      cwd: this.config.repoDir,
    });
  }

  private async configureFirewallSpyService(): Promise<void> {
    await this.writeSpyEnv();
    const hostPath = join(this.config.generatedDir, "spy.env");
    const stagedPath = "/tmp/.rootcell-spy.env.staged";
    await this.providers.vm.copyToGuest(this.config.firewallVm, hostPath, stagedPath);
    await this.providers.vm.exec(this.config.firewallVm, [
      "sudo",
      "install",
      "-m",
      "0640",
      "-o",
      "root",
      "-g",
      "rootcell-spy",
      stagedPath,
      "/etc/agent-vm/spy.env",
    ]);
    await this.providers.vm.exec(this.config.firewallVm, ["rm", "-f", stagedPath]);
    await this.providers.vm.exec(this.config.firewallVm, [
      "sudo",
      "systemctl",
      "daemon-reload",
    ]);

    if (this.isSpyEnabled()) {
      await this.providers.vm.exec(this.config.firewallVm, [
        "sudo",
        "systemctl",
        "restart",
        "rootcell-spy.service",
      ]);
      return;
    }

    await this.providers.vm.exec(this.config.firewallVm, [
      "sudo",
      "systemctl",
      "stop",
      "rootcell-spy.service",
    ], {
      allowFailure: true,
      ignoredOutput: true,
    });
    await this.providers.vm.exec(this.config.firewallVm, [
      "sudo",
      "systemctl",
      "disable",
      "rootcell-spy.service",
    ], {
      allowFailure: true,
      ignoredOutput: true,
    });
  }

  private async writeSpyEnv(): Promise<void> {
    const extraEnv = this.isSpyProviderTokenCountingEnabled()
      ? [
        ...await this.readSecretEnv(SPY_BEDROCK_SECRET_ENV_NAMES),
        `AWS_REGION=${this.config.awsEc2?.region ?? process.env.AWS_REGION ?? "us-east-1"}`,
        `AWS_DEFAULT_REGION=${this.config.awsEc2?.region ?? process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1"}`,
      ]
      : [];
    const spyEnvPath = join(this.config.generatedDir, "spy.env");
    writeFileSync(spyEnvPath, renderSpyEnv(process.env, extraEnv), "utf8");
    chmodSync(spyEnvPath, 0o600);
  }

  private async ensureFirewall(force: boolean, options: { readonly allowProvision: boolean } = { allowProvision: true }): Promise<boolean> {
    let needsProvision = force;
    if (!options.allowProvision && (await this.providers.vm.status(this.config.firewallVm)).state === "missing") {
      log("firewall VM is missing.");
      log("run ./rootcell provision, then try ./rootcell spy again.");
      return false;
    }
    if ((await this.providers.vm.ensureRunning({
      role: "firewall",
      name: this.config.firewallVm,
      network: this.networkPlan.vms.firewall,
    })).created) {
      needsProvision = true;
    }
    if (!needsProvision) {
      const spyActiveCheck = this.isSpyEnabled() ? " && systemctl is-active rootcell-spy.service >/dev/null 2>&1" : "";
      const check = `
systemctl is-active mitmproxy-explicit >/dev/null 2>&1 \\
 && systemctl is-active mitmproxy-transparent >/dev/null 2>&1 \\
 && systemctl is-active dnsmasq >/dev/null 2>&1 \\
 && test -f /etc/agent-vm/agent_spy.py \\
 && test -f /etc/agent-vm/spy-service.js \\
 && test -f /etc/agent-vm/spy-ui/index.html \\
 && test -f /etc/agent-vm/spy.env \\
 && systemctl cat rootcell-spy.service >/dev/null 2>&1${spyActiveCheck}
`;
      if ((await this.providers.vm.exec(this.config.firewallVm, ["bash", "-lc", check], {
        allowFailure: true,
        ignoredOutput: true,
      })).status !== 0) {
        needsProvision = true;
      }
    }
    if (!needsProvision) {
      return true;
    }
    if (!options.allowProvision) {
      log("firewall spy service is not provisioned for browser launch.");
      log("run ./rootcell provision, then try ./rootcell spy again.");
      return false;
    }

    log("provisioning firewall VM (first run takes ~5 min)...");
    this.buildSpyArtifacts();
    this.writeGitLocalNix();
    this.ensureCa();
    await this.copyRepoIntoVm(this.config.firewallVm, VM_FILES.firewall);
    await this.copyGeneratedNetworkIntoVm(this.config.firewallVm);
    await this.copyGeneratedExtensionsIntoVm(this.config.firewallVm);
    await this.bootstrapFirewallDns();
    await this.runNixosSwitch("firewall", `
set -e
sudo nixos-rebuild switch --flake ${shellQuote(this.guestFlakeRef(this.nixosConfiguration("firewall")))}
`);
    await this.syncFirewallCa();
    await this.providers.vm.exec(this.config.firewallVm, [
      "sudo",
      "systemctl",
      "restart",
      "mitmproxy-explicit",
      "mitmproxy-transparent",
    ]);
    await this.configureFirewallSpyService();
    log("firewall provisioning complete.");
    return true;
  }

  private async ensureAgent(force: boolean): Promise<void> {
    let needsProvision = force;
    if ((await this.providers.vm.ensureRunning({
      role: "agent",
      name: this.config.agentVm,
      network: this.networkPlan.vms.agent,
    })).created) {
      needsProvision = true;
    }
    if (!needsProvision) {
      const hasPi = (await this.providers.vm.exec(this.config.agentVm, ["bash", "-lc", "command -v pi >/dev/null 2>&1"], {
        allowFailure: true,
        ignoredOutput: true,
      })).status === 0;
      if (!hasPi) {
        needsProvision = true;
      }
    }
    if (!needsProvision) {
      await this.providers.vm.finalizeNetworking?.({
        role: "agent",
        name: this.config.agentVm,
        network: this.networkPlan.vms.agent,
      });
      return;
    }

    log("provisioning agent VM (first run takes ~10 min: nixpkgs fetch via firewall)...");
    this.writeGitLocalNix();
    await this.copyRepoIntoVm(this.config.agentVm, VM_FILES.agent);
    await this.copyGeneratedNetworkIntoVm(this.config.agentVm);
    await this.copyGeneratedGitIntoVm(this.config.agentVm);
    await this.copyGeneratedExtensionsIntoVm(this.config.agentVm);
    await this.copyAgentCaIntoVm(this.config.agentVm);
    await this.bootstrapAgentFirewallRoute();
    await this.bootstrapAgentFirewallTrust();
    await this.runNixosSwitch("agent", `
set -e
${exportAgentCaEnvScript("/tmp/agent-vm-bootstrap-ca-bundle.crt")}
sudo env \\
${sudoAgentCaEnvScript()}
  nixos-rebuild switch --flake ${shellQuote(this.guestFlakeRef(this.nixosConfiguration("agent")))}
`);
    await this.runAgentHomeManager();
    log("agent provisioning complete.");
    const pubkey = (await this.providers.vm.execCapture(this.config.agentVm, ["cat", `/home/${this.config.guestUser}/.ssh/id_rsa.pub`], {
      allowFailure: true,
    })).stdout.trim();
    if (pubkey.length > 0) {
      process.stderr.write(`
rootcell: this VM's SSH public key (register at https://github.com/settings/keys
to enable \`git push git@github.com:...\` from inside the VM):

${pubkey}

Run \`./rootcell pubkey\` to print it again.

`);
    }
  }

  private async restartAgentVm(message: string): Promise<void> {
    log(message);
    await this.providers.vm.stopIfRunning(this.config.agentVm);
    await this.providers.vm.ensureRunning({
      role: "agent",
      name: this.config.agentVm,
      network: this.networkPlan.vms.agent,
    });
  }

  private async runNixosSwitch(role: "agent" | "firewall", script: string): Promise<void> {
    const name = role === "agent" ? this.config.agentVm : this.config.firewallVm;
    const network = role === "agent" ? this.networkPlan.vms.agent : this.networkPlan.vms.firewall;
    const result = await this.providers.vm.exec(name, ["bash", "-lc", `${this.bootPartitionBootstrapScript()}\n${script}`], {
      allowFailure: true,
    });
    if (result.status !== 0 && result.status !== 255) {
      throw new Error(`${role} nixos-rebuild switch failed with exit ${String(result.status)}`);
    }
    if (result.status === 255) {
      log(`${role} nixos-rebuild switch interrupted SSH; waiting for transport to recover...`);
      await this.providers.vm.ensureRunning({ role, name, network });
    }
    await this.providers.vm.finalizeNetworking?.({ role, name, network });
  }

  private bootPartitionBootstrapScript(): string {
    return `
if [ -e /dev/disk/by-label/ESP ] && ! findmnt -rn /boot >/dev/null 2>&1; then
  sudo mkdir -p /boot
  sudo mount /dev/disk/by-label/ESP /boot
fi
`;
  }

  private async runAgentHomeManager(): Promise<void> {
    const script = `
set -e
${exportAgentCaEnvScript(AGENT_CA_BUNDLE)}
nix run ${shellQuote(this.guestFlakeRef("home-manager"))} -- switch --flake ${shellQuote(this.guestFlakeRef(this.config.guestUser))}
`;
    const attempts = 4;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = await this.providers.vm.exec(this.config.agentVm, ["bash", "-lc", script], {
        allowFailure: true,
      });
      if (result.status === 0) {
        return;
      }
      if (result.status !== 255) {
        throw new Error(`home-manager failed with exit ${String(result.status)}`);
      }
      if (attempt === attempts) {
        throw new Error(`home-manager failed after ${String(attempts)} attempts (last exit ${String(result.status)})`);
      }
      log(`home-manager exited ${String(result.status)}; restarting agent VM and retrying (${String(attempt + 1)}/${String(attempts)})...`);
      await this.restartAgentVm("restarting agent VM before home-manager retry...");
    }
  }

  private async readSecretEnv(allowedEnvNames?: ReadonlySet<string>): Promise<string[]> {
    const path = this.config.secretsPath;
    if (!existsSync(path)) {
      return [];
    }
    const mappings = parseSecretMappings(readFileSync(path, "utf8"));

    const injected: string[] = [];
    for (const mapping of mappings) {
      if (allowedEnvNames !== undefined && !allowedEnvNames.has(mapping.envName)) {
        continue;
      }
      let value;
      try {
        value = await this.providers.secrets.read(mapping.secret);
      } catch (error) {
        throw new Error(`secret lookup failed for ${mapping.envName} (${mapping.secret.providerId}): ${messageFromUnknown(error)}`, { cause: error });
      }
      injected.push(`${mapping.envName}=${value}`);
    }
    return injected;
  }
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  });
}

function hasInstanceFlag(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === "--") {
      return false;
    }
    if (arg === "--instance" || arg === "-i" || arg.startsWith("--instance=") || (arg.startsWith("-i") && arg.length > 2)) {
      return true;
    }
  }
  return false;
}

function appForInstance(repoDir: string, env: NodeJS.ProcessEnv, instance: RootcellInstance): RootcellApp<VmNetworkAttachment> {
  const config = buildConfig(repoDir, env, instance);
  return new RootcellApp(config, createProviderBundle(config, log));
}

function extensionHostCommandContext(
  repoDir: string,
  env: NodeJS.ProcessEnv,
  instanceName: string,
  extensionConfig: ExtensionHostCommandContext["extensionConfig"],
): ExtensionHostCommandContext {
  const instanceEnv = envForExistingInstance(repoDir, env, instanceName);
  const instance = loadExistingRootcellInstance(repoDir, instanceName, instanceEnv);
  if (instance === null) {
    throw new Error(`rootcell instance '${instanceName}' not found; run ./rootcell --instance ${instanceName} first.`);
  }
  const config = buildConfig(repoDir, instanceEnv, instance);
  const providers = createProviderBundle(config, log);
  return {
    repoDir,
    instanceName,
    extensionConfig,
    config,
    log,
    vmStatus: (role) => providers.vm.status(vmNameForRole(config, role)),
    forwardLocalPort: (role, options) => providers.vm.forwardLocalPort(vmNameForRole(config, role), options),
  };
}

function vmNameForRole(config: RootcellConfig, role: VmRole): string {
  return role === "agent" ? config.agentVm : config.firewallVm;
}

function envForExistingInstance(repoDir: string, baseEnv: NodeJS.ProcessEnv, instanceName: string): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  loadDotEnv(instancePaths(repoDir, instanceName, env).envPath, env);
  return env;
}

async function runListCommand(
  repoDir: string,
  env: NodeJS.ProcessEnv,
  instanceName: string,
  explicitInstance: boolean,
  selectedInstanceName: string | undefined,
): Promise<number> {
  if (explicitInstance) {
    const instanceEnv = envForExistingInstance(repoDir, env, instanceName);
    const instance = loadExistingRootcellInstance(repoDir, instanceName, instanceEnv);
    if (instance === null) {
      process.stdout.write(formatVmList(missingVmEntries(instanceName), { selectedInstance: selectedInstanceName }));
      return 0;
    }
    process.stdout.write(formatVmList(await appForInstance(repoDir, instanceEnv, instance).listVms(), { selectedInstance: selectedInstanceName }));
    return 0;
  }

  const entries: VmListEntry[] = [];
  for (const name of listRootcellVmInstanceNames(repoDir, env)) {
    const instanceEnv = envForExistingInstance(repoDir, env, name);
    const instance = loadExistingRootcellInstance(repoDir, name, instanceEnv);
    if (instance !== null) {
      entries.push(...await appForInstance(repoDir, instanceEnv, instance).listVms());
    }
  }
  if (selectedInstanceName !== undefined && !entries.some((entry) => entry.instance === selectedInstanceName)) {
    entries.push(...missingVmEntries(selectedInstanceName));
  }
  process.stdout.write(formatVmList(entries, { selectedInstance: selectedInstanceName }));
  return 0;
}

async function runLifecycleCommand(
  repoDir: string,
  env: NodeJS.ProcessEnv,
  command: "stop" | "remove",
  instanceName: string,
): Promise<number> {
  const instanceEnv = envForExistingInstance(repoDir, env, instanceName);
  const instance = loadExistingRootcellInstance(repoDir, instanceName, instanceEnv);
  if (instance === null) {
    log(`rootcell instance '${instanceName}' not found; run ./rootcell --instance ${instanceName} first.`);
    return 1;
  }
  const app = appForInstance(repoDir, instanceEnv, instance);
  if (command === "stop") {
    await app.stopVms();
    process.stdout.write(`stopped ${instanceName}\n`);
    return 0;
  }
  await app.removeVms();
  process.stdout.write(`stopped ${instanceName}, deleted state\n`);
  return 0;
}

function runEditCommand(
  repoDir: string,
  env: NodeJS.ProcessEnv,
  instanceName: string,
  editTarget: string | undefined,
): number {
  if (!isEditTarget(editTarget)) {
    log(`unknown edit target '${editTarget ?? ""}' (expected ${EDIT_TARGETS.join(", ")})`);
    return 2;
  }
  const editor = env.EDITOR;
  if (editor === undefined || editor.length === 0) {
    log("EDITOR is not set; set EDITOR to edit instance files.");
    return 1;
  }

  seedRootcellInstanceFiles(repoDir, instanceName, log, env);
  const path = editPath(instancePaths(repoDir, instanceName, env), editTarget);
  log(`opening ${path}`);
  return runInherited("sh", ["-c", "exec $EDITOR \"$1\"", "sh", path], {
    allowFailure: true,
    env,
  }).status;
}

function isEditTarget(value: string | undefined): value is (typeof EDIT_TARGETS)[number] {
  return EDIT_TARGETS.some((target) => target === value);
}

function editPath(paths: ReturnType<typeof instancePaths>, target: (typeof EDIT_TARGETS)[number]): string {
  if (target === "env") {
    return paths.envPath;
  }
  if (target === "extensions") {
    return paths.extensionsPath;
  }
  return join(paths.proxyDir, EDIT_PROXY_FILES[target]);
}

export function renderSpyEnv(env: NodeJS.ProcessEnv = process.env, extraEnv: readonly string[] = []): string {
  return [
    "# Generated by ./rootcell provision. DO NOT EDIT.",
    ...SPY_ENV_KEYS.map((key) => {
      const raw = env[key];
      const value = key === "ROOTCELL_SPY_ENABLED"
        ? (envBoolean(raw, false) ? "true" : "false")
        : raw === undefined || raw.trim().length === 0 ? SPY_ENV_DEFAULTS[key] : raw.trim();
      return `${key}=${envFileValue(value)}`;
    }),
    ...extraEnv.map((entry) => {
      const separator = entry.indexOf("=");
      if (separator <= 0) {
        throw new Error("spy environment extra entries must be NAME=value");
      }
      const key = entry.slice(0, separator);
      const value = entry.slice(separator + 1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error(`invalid spy environment variable name: ${key}`);
      }
      return `${key}=${envFileValue(value)}`;
    }),
    "",
  ].join("\n");
}

function envFileValue(value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error("spy environment values must not contain newlines");
  }
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function positiveIntegerFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function envBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim().length === 0) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function missingVmEntries(instanceName: string): readonly VmListEntry[] {
  const vmNames = deriveVmNames(instanceName);
  return [
    { instance: instanceName, vm: vmNames.agentVm, state: "missing" },
    { instance: instanceName, vm: vmNames.firewallVm, state: "missing" },
  ];
}

export async function rootcellMain(args: readonly string[], importMetaPath: string): Promise<number> {
  const repoDir = repoDirFromImportMeta(importMetaPath);
  const explicitInstance = hasInstanceFlag(args);
  let parsed;
  try {
    parsed = parseRootcellArgs(args);
  } catch (error) {
    log(messageFromUnknown(error));
    return 2;
  }

  if (parsed.kind === "handled") {
    return parsed.status;
  }

  try {
    if (parsed.kind === "select") {
      writeSelectedRootcellInstance(repoDir, parsed.selectedInstanceName, process.env);
      process.stdout.write(`selected rootcell instance '${parsed.selectedInstanceName}'\n`);
      return 0;
    }

    if (parsed.kind === "init-env") {
      const instanceName = resolveRootcellInstanceName(repoDir, process.env, parsed.instanceName, explicitInstance);
      initRootcellInstanceEnv(repoDir, instanceName, parsed.providerType, log, process.env);
      return 0;
    }
    const instanceName = resolveRootcellInstanceName(repoDir, process.env, parsed.instanceName, explicitInstance);
    if (parsed.subcommand === "list") {
      const selectedInstanceName = explicitInstance
        ? readSelectedRootcellInstanceForDisplay(repoDir, process.env)
        : instanceName;
      return await runListCommand(repoDir, process.env, instanceName, explicitInstance, selectedInstanceName);
    }
    if (parsed.subcommand === "stop" || parsed.subcommand === "remove") {
      return await runLifecycleCommand(repoDir, process.env, parsed.subcommand, instanceName);
    }
    if (parsed.subcommand === "edit") {
      return runEditCommand(repoDir, process.env, instanceName, parsed.rest[0]);
    }
    if (parsed.subcommand === "extension") {
      return await runExtensionCommand({
        repoDir,
        env: process.env,
        instanceName,
        rest: parsed.rest,
        log,
        createContext: ({ extensionConfig }) => extensionHostCommandContext(
          repoDir,
          process.env,
          instanceName,
          extensionConfig,
        ),
      });
    }

    seedRootcellInstanceFiles(repoDir, instanceName, log);
    loadDotEnv(instancePaths(repoDir, instanceName, process.env).envPath, process.env);
    const instance = loadRootcellInstance(repoDir, instanceName, process.env);
    const config = buildConfig(repoDir, process.env, instance);
    const app = new RootcellApp(config, createProviderBundle(config, log));
    return await app.runAfterEnvironment(parsed.subcommand, parsed.rest, parsed.spyOptions);
  } catch (error) {
    log(messageFromUnknown(error));
    return error instanceof SelectedInstanceStateError ? error.status : 1;
  }
}

function resolveRootcellInstanceName(
  repoDir: string,
  env: NodeJS.ProcessEnv,
  parsedInstanceName: string,
  explicitInstance: boolean,
): string {
  if (explicitInstance) {
    return parsedInstanceName;
  }
  return readSelectedRootcellInstance(repoDir, env);
}

function readSelectedRootcellInstanceForDisplay(repoDir: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    return readSelectedRootcellInstance(repoDir, env);
  } catch {
    return undefined;
  }
}
