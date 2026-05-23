import { commandExists, runCapture } from "../../../process.ts";
import { assertLimactlSupportsSshOverVsockYaml } from "../../../providers/lima-version.ts";

export function preflightMacOsLimaUserV2Integration(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("macos-lima-user-v2 integration tests require macOS");
  }
  if (process.arch !== "arm64") {
    throw new Error("macos-lima-user-v2 integration tests currently require Apple Silicon arm64 hosts");
  }
  if (!hypervisorFrameworkAvailable()) {
    throw new Error("macos-lima-user-v2 integration tests require Hypervisor.framework support (sysctl kern.hv_support=1); this runner likely does not support nested virtualization");
  }
  for (const tool of [
    { command: "limactl", envVars: ["ROOTCELL_LIMACTL", "LIMACTL"] },
    { command: "ssh" },
    { command: "curl" },
  ] as const) {
    if (!toolAvailable(tool.command, tool.envVars ?? [])) {
      throw new Error(`macos-lima-user-v2 integration tests require '${tool.command}' on PATH or ${tool.envVars?.join(" or ") ?? "a configured override"}`);
    }
  }
  assertLimactlSupportsSshOverVsockYaml(resolveTool("limactl", ["ROOTCELL_LIMACTL", "LIMACTL"]));
  return Promise.resolve();
}

function hypervisorFrameworkAvailable(): boolean {
  const result = runCapture("sysctl", ["-n", "kern.hv_support"], { allowFailure: true });
  return result.status === 0 && result.stdout.trim() === "1";
}

function toolAvailable(command: string, envVars: readonly string[] = []): boolean {
  return envVars.some((envVar) => process.env[envVar] !== undefined && process.env[envVar].length > 0)
    || commandExists(command);
}

function resolveTool(command: string, envVars: readonly string[]): string {
  for (const envVar of envVars) {
    const configured = process.env[envVar];
    if (configured !== undefined && configured.length > 0) {
      return configured;
    }
  }
  return command;
}
