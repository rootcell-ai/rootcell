import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { IntegrationProviderSpec } from "../../common/provider-spec.ts";
import {
  LIFECYCLE_INSTANCE,
  TEST_INSTANCE,
} from "../../common/fixtures.ts";
import { instancePaths } from "../../../instance.ts";
import { commandExists, runInherited } from "../../../process.ts";
import { resolveHostTool } from "../../../host-tools.ts";
import type { RootcellConfig } from "../../../types.ts";
import { AwsEc2VmProvider } from "../../../providers/aws-ec2.ts";
import {
  AwsEc2NetworkProvider,
  type AwsEc2NetworkAttachment,
} from "../../../providers/aws-ec2-network.ts";
import type { ProviderBundle } from "../../../providers/types.ts";
import { AwsSecretsManagerSecretProvider } from "../../../secrets/aws-secrets-manager.ts";
import { MacOsKeychainSecretProvider } from "../../../secrets/macos-keychain.ts";
import { StaticSecretProviderRegistry } from "../../../secrets/registry.ts";

export const awsEc2IntegrationProvider: IntegrationProviderSpec<AwsEc2NetworkAttachment> = {
  id: "aws-ec2",
  platform: "darwin",
  architecture: "arm64",
  guestArchitecture: "aarch64-linux",
  createBundle,
  preflight: preflightAwsEc2Integration,
  stopTestResources: stopAwsEc2TestResources,
  removeTestState: removeAwsEc2TestState,
};

export function createBundle(
  config: RootcellConfig,
  log: (message: string) => void,
): ProviderBundle<AwsEc2NetworkAttachment> {
  return {
    network: new AwsEc2NetworkProvider(config, log),
    vm: new AwsEc2VmProvider(config, log),
    secrets: new StaticSecretProviderRegistry([
      new MacOsKeychainSecretProvider(),
      ...config.awsSecretsManagerProviders.map((providerConfig) => new AwsSecretsManagerSecretProvider(providerConfig)),
    ]),
  };
}

export function preflightAwsEc2Integration(): Promise<void> {
  requireEnv("ROOTCELL_VM_PROVIDER", "aws-ec2");
  requireEnv("ROOTCELL_AWS_PROFILE");
  requireEnv("ROOTCELL_AWS_REGION");
  resolveHostTool({
    name: "tofu",
    envVar: "ROOTCELL_TERRAFORM",
    purpose: "for AWS EC2 integration tests",
  });
  for (const tool of ["ssh", "scp", "ssh-keygen", "curl"]) {
    if (!commandExists(tool)) {
      throw new Error(`aws-ec2 integration tests require '${tool}' on PATH`);
    }
  }
  return Promise.resolve();
}

export async function stopAwsEc2TestResources(repoDir: string): Promise<void> {
  await stopAwsEc2InstanceResources(repoDir, TEST_INSTANCE);
  await stopAwsEc2InstanceResources(repoDir, LIFECYCLE_INSTANCE);
}

export async function removeAwsEc2TestState(repoDir: string): Promise<void> {
  await removeAwsEc2InstanceState(repoDir, TEST_INSTANCE);
  await removeAwsEc2InstanceState(repoDir, LIFECYCLE_INSTANCE);
}

function stopAwsEc2InstanceResources(repoDir: string, instance: string): Promise<void> {
  if (!existsSync(instancePaths(repoDir, instance, process.env).statePath)) {
    return Promise.resolve();
  }
  runInherited(join(repoDir, "rootcell"), ["stop", "--instance", instance], {
    cwd: repoDir,
    allowFailure: true,
  });
  return Promise.resolve();
}

function removeAwsEc2InstanceState(repoDir: string, instance: string): Promise<void> {
  const paths = instancePaths(repoDir, instance, process.env);
  if (!existsSync(paths.statePath)) {
    return Promise.resolve();
  }
  const result = runInherited(join(repoDir, "rootcell"), ["remove", "--instance", instance], {
    cwd: repoDir,
    allowFailure: true,
  });
  if (result.status !== 0) {
    throw new Error(`rootcell remove failed for AWS EC2 integration instance '${instance}'`);
  }
  rmSync(paths.dir, { recursive: true, force: true });
  return Promise.resolve();
}

function requireEnv(name: string, expected?: string): void {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`aws-ec2 integration tests require ${name}`);
  }
  if (expected !== undefined && value !== expected) {
    throw new Error(`aws-ec2 integration tests require ${name}=${expected}`);
  }
}
