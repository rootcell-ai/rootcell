import type { RootcellConfig } from "../types.ts";
import type { ProviderBundle } from "./types.ts";
import { AwsEc2VmProvider } from "./aws-ec2.ts";
import { AwsEc2NetworkProvider } from "./aws-ec2-network.ts";
import { LimaVmProvider } from "./lima.ts";
import { MacOsLimaUserV2NetworkProvider } from "./macos-lima-user-v2-network.ts";
import { AwsSecretsManagerSecretProvider } from "../secrets/aws-secrets-manager.ts";
import { MacOsKeychainSecretProvider } from "../secrets/macos-keychain.ts";
import { StaticSecretProviderRegistry } from "../secrets/registry.ts";

export function createProviderBundle(
  config: RootcellConfig,
  log: (message: string) => void,
): ProviderBundle {
  if (config.vmProvider === "aws-ec2") {
    return {
      network: new AwsEc2NetworkProvider(config, log),
      vm: new AwsEc2VmProvider(config, log),
      secrets: new StaticSecretProviderRegistry([
        new MacOsKeychainSecretProvider(),
        ...config.awsSecretsManagerProviders.map((providerConfig) => new AwsSecretsManagerSecretProvider(providerConfig)),
      ]),
    };
  }
  return {
    network: new MacOsLimaUserV2NetworkProvider(config, log),
    vm: new LimaVmProvider(config, log),
    secrets: new StaticSecretProviderRegistry([
      new MacOsKeychainSecretProvider(),
      ...config.awsSecretsManagerProviders.map((providerConfig) => new AwsSecretsManagerSecretProvider(providerConfig)),
    ]),
  };
}
