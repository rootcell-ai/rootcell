import { createServer } from "node:net";
import type { LocalPortForwardHandle, LocalPortForwardOptions, VmRole } from "./providers/types.ts";

export const DEFAULT_TUNNEL_LOCAL_HOST = "127.0.0.1";
export const DEFAULT_TUNNEL_PORT_SCAN_LIMIT = 100;

export type PortAvailabilityCheck = (port: number, host: string) => Promise<boolean>;

export interface RoleTargetTunnelSpec {
  readonly role: VmRole;
  readonly remoteHost: string;
  readonly remotePort: number;
  readonly preferredLocalPort: number;
  readonly localHost?: string;
}

export interface OpenRoleTargetTunnelOptions {
  readonly scanLimit?: number;
  readonly portAvailable?: PortAvailabilityCheck;
}

export type RoleTargetForwardLocalPort = (
  role: VmRole,
  options: LocalPortForwardOptions,
) => Promise<LocalPortForwardHandle>;

export type RoleTargetTunnelHandle = LocalPortForwardHandle & {
  readonly role: VmRole;
};

type SignalName = "SIGINT" | "SIGTERM";

interface SignalEvents {
  once(signal: SignalName, listener: () => void): unknown;
  removeListener(signal: SignalName, listener: () => void): unknown;
}

export interface WaitForForegroundTunnelOptions {
  readonly log?: (message: string) => void;
  readonly signalEvents?: SignalEvents;
}

export async function chooseLocalPort(
  preferredPort: number,
  localHost = DEFAULT_TUNNEL_LOCAL_HOST,
  scanLimit = DEFAULT_TUNNEL_PORT_SCAN_LIMIT,
  portAvailable: PortAvailabilityCheck = isLocalPortAvailable,
): Promise<number> {
  if (!Number.isInteger(preferredPort) || preferredPort <= 0 || preferredPort > 65_535) {
    throw new Error(`invalid preferred local port: ${String(preferredPort)}`);
  }
  if (!Number.isInteger(scanLimit) || scanLimit <= 0) {
    throw new Error(`invalid local port scan limit: ${String(scanLimit)}`);
  }

  for (let offset = 0; offset < scanLimit; offset += 1) {
    const candidate = preferredPort + offset;
    if (candidate > 65_535) {
      break;
    }
    if (await portAvailable(candidate, localHost)) {
      return candidate;
    }
  }
  throw new Error(`no available local port found starting at ${String(preferredPort)}`);
}

export async function openRoleTargetTunnel(
  forwardLocalPort: RoleTargetForwardLocalPort,
  spec: RoleTargetTunnelSpec,
  options: OpenRoleTargetTunnelOptions = {},
): Promise<RoleTargetTunnelHandle> {
  const localHost = spec.localHost ?? DEFAULT_TUNNEL_LOCAL_HOST;
  const localPort = await chooseLocalPort(
    spec.preferredLocalPort,
    localHost,
    options.scanLimit ?? DEFAULT_TUNNEL_PORT_SCAN_LIMIT,
    options.portAvailable ?? isLocalPortAvailable,
  );
  const handle = await forwardLocalPort(spec.role, {
    localHost,
    localPort,
    remoteHost: spec.remoteHost,
    remotePort: spec.remotePort,
  });
  return { role: spec.role, ...handle };
}

export async function waitForForegroundTunnel(
  tunnel: Pick<LocalPortForwardHandle, "closed" | "close">,
  options: WaitForForegroundTunnelOptions = {},
): Promise<number> {
  let signalStatus: number | undefined;
  const signalEvents = options.signalEvents ?? process;
  const signalPromise = new Promise<number>((resolve) => {
    const onSigint = (): void => {
      signalStatus = 130;
      resolve(signalStatus);
    };
    const onSigterm = (): void => {
      signalStatus = 143;
      resolve(signalStatus);
    };
    signalEvents.once("SIGINT", onSigint);
    signalEvents.once("SIGTERM", onSigterm);
    void tunnel.closed.finally(() => {
      signalEvents.removeListener("SIGINT", onSigint);
      signalEvents.removeListener("SIGTERM", onSigterm);
    });
  });
  const tunnelPromise = tunnel.closed.then((status) => {
    if (signalStatus === undefined) {
      options.log?.("SSH tunnel closed.");
    }
    return status === 0 ? 0 : 1;
  });

  try {
    return await Promise.race([signalPromise, tunnelPromise]);
  } finally {
    await tunnel.close();
  }
}

async function isLocalPortAvailable(port: number, host: string): Promise<boolean> {
  return await new Promise<boolean>((resolveAvailable) => {
    const server = createServer();
    server.unref();
    server.once("error", () => {
      resolveAvailable(false);
    });
    server.listen({ host, port }, () => {
      server.close(() => {
        resolveAvailable(true);
      });
    });
  });
}
