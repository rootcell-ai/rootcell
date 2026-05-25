import {
  DEFAULT_TUNNEL_LOCAL_HOST,
  openRoleTargetTunnel,
  waitForForegroundTunnel,
  type PortAvailabilityCheck,
} from "../tunnels.ts";
import type { VmStatus } from "../providers/types.ts";
import type { ExtensionHostCommandContext, RootcellExtensionHostCommand } from "./registry.ts";

const PLANNOTATOR_HOST = "127.0.0.1";
const PLANNOTATOR_PORT = 19_432;

export interface PlannotatorTunnelCommandOptions {
  readonly portAvailable?: PortAvailabilityCheck;
}

export function createPlannotatorTunnelCommand(
  options: PlannotatorTunnelCommandOptions = {},
): RootcellExtensionHostCommand {
  return {
    name: "tunnel",
    description: "open a local SSH tunnel to the Plannotator server in the agent VM",
    complete: () => [],
    run: async (context, args) => {
      if (args.length > 0) {
        context.log("usage: rootcell extension pi-plannotator tunnel");
        return 2;
      }

      const status = await context.vmStatus("agent");
      if (status.state !== "running") {
        logAgentVmNotRunning(context, status);
        return 1;
      }

      const tunnel = await openRoleTargetTunnel(
        (role, forwardOptions) => context.forwardLocalPort(role, forwardOptions),
        {
          role: "agent",
          localHost: DEFAULT_TUNNEL_LOCAL_HOST,
          remoteHost: PLANNOTATOR_HOST,
          remotePort: PLANNOTATOR_PORT,
          preferredLocalPort: PLANNOTATOR_PORT,
        },
        options.portAvailable === undefined ? {} : { portAvailable: options.portAvailable },
      );
      const url = `http://${tunnel.localHost}:${String(tunnel.localPort)}`;
      process.stdout.write(`${url}\n`);
      context.log(`forwarding ${url} to Plannotator in the agent VM (Ctrl-C stops the tunnel).`);
      return await waitForForegroundTunnel(tunnel, { log: context.log });
    },
  };
}

export const PLANNOTATOR_TUNNEL_COMMAND = createPlannotatorTunnelCommand();

function logAgentVmNotRunning(context: ExtensionHostCommandContext, status: Exclude<VmStatus, { readonly state: "running" }>): void {
  if (status.state === "missing") {
    context.log(`agent VM for instance '${context.instanceName}' is missing.`);
    context.log(`run ./rootcell --instance ${context.instanceName} provision, then ./rootcell --instance ${context.instanceName} to start it.`);
    return;
  }
  if (status.state === "stopped") {
    context.log(`agent VM for instance '${context.instanceName}' is stopped.`);
    context.log(`run ./rootcell --instance ${context.instanceName} to start it, then try again.`);
    return;
  }
  context.log(`agent VM for instance '${context.instanceName}' is not ready: ${status.detail}`);
  context.log(`resolve the VM state, then try ./rootcell --instance ${context.instanceName} extension pi-plannotator tunnel again.`);
}
