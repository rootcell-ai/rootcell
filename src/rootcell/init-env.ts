import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { instancePaths, seedRootcellInstanceFiles } from "./instance.ts";
import {
  ROOTCELL_AWS_CONTROL_CIDR_ENV,
  ROOTCELL_AWS_PROFILE_ENV,
  ROOTCELL_AWS_REGION_ENV,
  ROOTCELL_VM_PROVIDER_ENV,
} from "./providers/aws-ec2-config.ts";
import type { RootcellInitEnvProviderType } from "./types.ts";

interface EnvAssignment {
  readonly key: string;
  readonly value: string;
  readonly overwrite?: boolean;
}

export interface InitEnvResult {
  readonly envPath: string;
  readonly providerType: RootcellInitEnvProviderType;
}

export function initRootcellInstanceEnv(
  repoDir: string,
  instanceName: string,
  providerType: RootcellInitEnvProviderType,
  log: (message: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): InitEnvResult {
  seedRootcellInstanceFiles(repoDir, instanceName, log, env);
  const paths = instancePaths(repoDir, instanceName, env);
  const existing = existsSync(paths.envPath) ? readFileSync(paths.envPath, "utf8") : "";
  const content = upsertEnvAssignments(
    existing,
    providerEnvAssignments(providerType, env),
    `# Provider initialized by rootcell --init-env ${providerType}.`,
  );
  if (content !== existing) {
    writeFileSync(paths.envPath, content, { encoding: "utf8", mode: 0o600 });
  }
  log(`initialized ${instanceName} environment for ${providerType} at ${paths.envPath}`);
  return { envPath: paths.envPath, providerType };
}

function providerEnvAssignments(providerType: RootcellInitEnvProviderType, env: NodeJS.ProcessEnv): readonly EnvAssignment[] {
  if (providerType === "aws-ec2") {
    return [
      { key: ROOTCELL_VM_PROVIDER_ENV, value: "aws-ec2", overwrite: true },
      { key: ROOTCELL_AWS_PROFILE_ENV, value: env[ROOTCELL_AWS_PROFILE_ENV] ?? env.AWS_PROFILE ?? "default" },
      { key: ROOTCELL_AWS_REGION_ENV, value: env[ROOTCELL_AWS_REGION_ENV] ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1" },
      { key: ROOTCELL_AWS_CONTROL_CIDR_ENV, value: env[ROOTCELL_AWS_CONTROL_CIDR_ENV] ?? "auto" },
    ];
  }
  return [
    { key: ROOTCELL_VM_PROVIDER_ENV, value: "lima", overwrite: true },
  ];
}

function upsertEnvAssignments(
  text: string,
  assignments: readonly EnvAssignment[],
  comment: string,
): string {
  const pending = new Map(assignments.map((assignment) => [assignment.key, assignment]));
  const lines = text.length === 0 ? [] : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const nextLines = lines.map((line) => {
    if (line.startsWith("#")) {
      return line;
    }
    const equalsAt = line.indexOf("=");
    const key = equalsAt === -1 ? line : line.slice(0, equalsAt);
    const assignment = pending.get(key);
    if (assignment === undefined) {
      return line;
    }
    pending.delete(key);
    return assignment.overwrite === true ? `${key}=${assignment.value}` : line;
  });

  if (pending.size > 0) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== "") {
      nextLines.push("");
    }
    nextLines.push(comment);
    for (const assignment of assignments) {
      if (pending.has(assignment.key)) {
        nextLines.push(`${assignment.key}=${assignment.value}`);
      }
    }
  }

  return `${nextLines.join("\n")}\n`;
}
