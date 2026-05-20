import type { RootcellConfig } from "../../types.ts";
import type { ProviderBundle, VmNetworkAttachment } from "../../providers/types.ts";
import { awsEc2IntegrationProvider } from "../providers/aws-ec2/provider.ts";
import { macOsLimaUserV2IntegrationProvider } from "../providers/macos-lima-user-v2/provider.ts";

export interface IntegrationProviderSpec<TAttachment extends VmNetworkAttachment = VmNetworkAttachment> {
  readonly id: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: NodeJS.Architecture;
  readonly guestArchitecture: string;
  createBundle(config: RootcellConfig, log: (message: string) => void): ProviderBundle<TAttachment>;
  preflight(): Promise<void>;
  stopTestResources(repoDir: string): Promise<void>;
  removeTestState(repoDir: string): Promise<void>;
}

const providers = [
  awsEc2IntegrationProvider,
  macOsLimaUserV2IntegrationProvider,
] as const satisfies readonly IntegrationProviderSpec[];

export function selectedIntegrationProvider(): IntegrationProviderSpec {
  const id = process.env.ROOTCELL_INTEGRATION_PROVIDER ?? "macos-lima-user-v2";
  const provider = providers.find((candidate) => candidate.id === id);
  if (provider === undefined) {
    throw new Error(`unknown integration provider '${id}'`);
  }
  return provider;
}
