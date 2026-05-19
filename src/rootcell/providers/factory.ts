import type { RootcellConfig } from "../types.ts";
import type { ProviderBundle } from "./types.ts";
import { LimaVmProvider } from "./lima.ts";
import { MacOsLimaUserV2NetworkProvider, type LimaUserV2NetworkAttachment } from "./macos-lima-user-v2-network.ts";

export function createProviderBundle(
  config: RootcellConfig,
  log: (message: string) => void,
): ProviderBundle<LimaUserV2NetworkAttachment> {
  return {
    network: new MacOsLimaUserV2NetworkProvider(config, log),
    vm: new LimaVmProvider(config, log),
  };
}
