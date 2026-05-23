import { runCapture } from "../process.ts";

export interface LimaVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly raw: string;
}

export const MIN_LIMA_SSH_OVER_VSOCK_YAML_VERSION: LimaVersion = {
  major: 2,
  minor: 0,
  patch: 2,
  raw: "2.0.2",
};

export function assertLimactlSupportsSshOverVsockYaml(limactl: string): void {
  const result = runCapture(limactl, ["--version"], { allowFailure: true });
  const output = `${result.stdout}${result.stderr}`.trim();
  if (result.status !== 0) {
    throw new Error(output.length > 0 ? output : `failed to run ${limactl} --version`);
  }

  const version = parseLimactlVersionOutput(output);
  if (version === null) {
    throw new Error(`could not parse ${limactl} version output: ${output}`);
  }
  if (limaVersionSupportsSshOverVsockYaml(version)) {
    return;
  }

  throw new Error([
    `${limactl} ${formatLimaVersion(version)} does not support .ssh.overVsock; rootcell requires Lima >= ${formatLimaVersion(MIN_LIMA_SSH_OVER_VSOCK_YAML_VERSION)} for the macos-lima provider.`,
    "Without SSH over VSOCK, Lima falls back to localhost TCP forwarding and firewall provisioning can interrupt the bootstrap transport.",
    "Update Lima or run with the repo-pinned host tools:",
    "  nix shell .#hostTools --command ./rootcell",
  ].join("\n"));
}

export function parseLimactlVersionOutput(output: string): LimaVersion | null {
  const match = /\bv?([0-9]+)\.([0-9]+)\.([0-9]+)(?:[-+][0-9A-Za-z.-]+)?\b/.exec(output);
  if (match === null) {
    return null;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || !Number.isSafeInteger(patch)) {
    return null;
  }
  return {
    major,
    minor,
    patch,
    raw: `${String(major)}.${String(minor)}.${String(patch)}`,
  };
}

export function limaVersionSupportsSshOverVsockYaml(version: LimaVersion): boolean {
  return compareLimaVersions(version, MIN_LIMA_SSH_OVER_VSOCK_YAML_VERSION) >= 0;
}

export function compareLimaVersions(left: LimaVersion, right: LimaVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    const diff = left[key] - right[key];
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

export function formatLimaVersion(version: LimaVersion): string {
  return version.raw;
}
