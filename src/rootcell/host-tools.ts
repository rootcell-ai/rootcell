import { commandExists } from "./process.ts";

interface HostToolSpec {
  readonly name: string;
  readonly envVar?: string;
  readonly envVars?: readonly string[];
  readonly purpose: string;
}

interface ResolveHostToolOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly commandExists?: (command: string) => boolean;
}

export function resolveHostTool(spec: HostToolSpec, options: ResolveHostToolOptions = {}): string {
  const env = options.env ?? process.env;
  const exists = options.commandExists ?? commandExists;
  for (const envVar of hostToolEnvVars(spec)) {
    const configured = env[envVar];
    if (configured !== undefined && configured.length > 0) {
      return configured;
    }
  }
  if (exists(spec.name)) {
    return spec.name;
  }
  throw new Error(hostToolMissingMessage(spec));
}

function hostToolMissingMessage(spec: HostToolSpec): string {
  const envVars = hostToolEnvVars(spec);
  return [
    `${spec.name} is required ${spec.purpose}.`,
    ...(envVars.length === 0 ? [] : [`Set ${envVars.join(" or ")}=/path/to/${spec.name} to use a non-PATH binary.`]),
    "Install host tools with Homebrew:",
    "  brew tap oven-sh/bun",
    "  brew install bun lima",
    "Or run with Nix-provided host tools:",
    "  nix shell .#hostTools --command ./rootcell",
  ].join("\n");
}

function hostToolEnvVars(spec: HostToolSpec): readonly string[] {
  return spec.envVars ?? (spec.envVar === undefined ? [] : [spec.envVar]);
}
