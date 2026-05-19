import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { IntegrationProviderSpec } from "../../common/provider-spec.ts";
import {
  CLI_SMOKE_INSTANCE_PREFIX,
  LIFECYCLE_INSTANCE,
  TEST_INSTANCE,
} from "../../common/fixtures.ts";
import { runCapture, runInherited } from "../../../process.ts";
import type { RootcellConfig } from "../../../types.ts";
import { deriveVmNames, instancePaths, listRootcellInstanceNames } from "../../../instance.ts";
import { LimaVmProvider } from "../../../providers/lima.ts";
import {
  limaUserV2NetworkName,
  MacOsLimaUserV2NetworkProvider,
  type LimaUserV2NetworkAttachment,
} from "../../../providers/macos-lima-user-v2-network.ts";
import type { ProviderBundle } from "../../../providers/types.ts";
import { preflightMacOsLimaUserV2Integration } from "./preflight.ts";

const JsonObjectSchema = z.record(z.string(), z.unknown());

export const macOsLimaUserV2IntegrationProvider: IntegrationProviderSpec<LimaUserV2NetworkAttachment> = {
  id: "macos-lima-user-v2",
  platform: "darwin",
  architecture: "arm64",
  guestArchitecture: "aarch64-linux",
  createBundle,
  preflight: preflightMacOsLimaUserV2Integration,
  stopTestResources: stopLimaTestResources,
  removeTestState: removeLimaTestState,
};

export function createBundle(
  config: RootcellConfig,
  log: (message: string) => void,
): ProviderBundle<LimaUserV2NetworkAttachment> {
  return {
    network: new MacOsLimaUserV2NetworkProvider(config, log),
    vm: new LimaVmProvider(config, log),
  };
}

export function limaStatePath(
  repoDir: string,
  name: string,
  instance = TEST_INSTANCE,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(instancePaths(repoDir, instance, env).dir, "v", limaRoleDir(name), "state.json");
}

export function limaYamlPath(
  repoDir: string,
  name: string,
  instance = TEST_INSTANCE,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(instancePaths(repoDir, instance, env).dir, "v", limaRoleDir(name), "lima.yaml");
}

export function readJson(path: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  return JsonObjectSchema.parse(raw);
}

export async function stopLimaTestResources(repoDir: string): Promise<void> {
  await stopLimaInstanceResources(repoDir, TEST_INSTANCE);
  await stopLimaInstanceResources(repoDir, LIFECYCLE_INSTANCE);
  for (const instance of limaSmokeInstances(repoDir)) {
    await stopLimaInstanceResources(repoDir, instance);
  }
}

export async function removeLimaTestState(repoDir: string): Promise<void> {
  await removeLimaInstanceState(repoDir, TEST_INSTANCE);
  await removeLimaInstanceState(repoDir, LIFECYCLE_INSTANCE);
  for (const instance of limaSmokeInstances(repoDir)) {
    await removeLimaInstanceState(repoDir, instance);
  }
}

export function stopLimaInstanceResources(
  repoDir: string,
  instance: string,
): Promise<void> {
  const names = deriveVmNames(instance);
  for (const name of [names.agentVm, names.firewallVm]) {
    runInherited(resolveLimactl(), ["--tty=false", "stop", "--force", name], {
      allowFailure: true,
      ignoredOutput: true,
    });
  }
  return Promise.resolve();
}

export function removeLimaInstanceState(
  repoDir: string,
  instance: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const names = deriveVmNames(instance);
  for (const name of [names.agentVm, names.firewallVm]) {
    runInherited(resolveLimactl(), ["--tty=false", "delete", "--force", name], {
      allowFailure: true,
      ignoredOutput: true,
    });
  }
  runInherited(resolveLimactl(), ["--tty=false", "network", "delete", "--force", limaUserV2NetworkName(limaCleanupConfig(repoDir, instance, env))], {
    allowFailure: true,
    ignoredOutput: true,
  });
  rmSync(instancePaths(repoDir, instance, env).dir, {
    recursive: true,
    force: true,
  });
  return Promise.resolve();
}

function limaCleanupConfig(repoDir: string, instance: string, env: NodeJS.ProcessEnv): RootcellConfig {
  const paths = instancePaths(repoDir, instance, env);
  return {
    repoDir,
    instanceName: instance,
    instanceDir: paths.dir,
    envPath: paths.envPath,
    secretsPath: paths.secretsPath,
    proxyDir: paths.proxyDir,
    pkiDir: join(paths.dir, "pki"),
    generatedDir: join(paths.dir, "generated"),
    agentVm: deriveVmNames(instance).agentVm,
    firewallVm: deriveVmNames(instance).firewallVm,
    guestUser: "luser",
    guestRepoDir: "/home/luser/rootcell",
    firewallIp: "192.168.109.10",
    agentIp: "192.168.109.11",
    networkPrefix: "24",
    imageManifestUrl: "https://example.invalid/manifest.json",
  };
}

function limaSmokeInstances(repoDir: string): readonly string[] {
  return listRootcellInstanceNames(repoDir, process.env)
    .filter((name) => name.startsWith(CLI_SMOKE_INSTANCE_PREFIX));
}

function limaRoleDir(name: string): "a" | "f" {
  if (name.startsWith("agent")) {
    return "a";
  }
  if (name.startsWith("firewall")) {
    return "f";
  }
  throw new Error(`unknown Lima test VM name: ${name}`);
}

function resolveLimactl(): string {
  for (const envVar of ["ROOTCELL_LIMACTL", "LIMACTL"]) {
    const value = process.env[envVar];
    if (value !== undefined && value.length > 0) {
      return value;
    }
  }
  return "limactl";
}

export function limaInstanceDirExists(repoDir: string, instance: string, name: string): boolean {
  const result = runCapture(resolveLimactl(), ["list", "--format", "json", name], {
    allowFailure: true,
  });
  return result.status === 0 && result.stdout.includes(name);
}
