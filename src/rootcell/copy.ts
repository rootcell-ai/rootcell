export interface RootcellCopySpec {
  readonly sources: readonly string[];
  readonly target: string;
  readonly direction: "host-to-guest" | "guest-to-host";
}

export function parseRootcellCopySpec(operands: readonly string[]): RootcellCopySpec {
  if (operands.length < 2) {
    throw new Error("copy requires at least one source and a target");
  }
  for (const operand of operands) {
    if (operand === ":") {
      throw new Error("copy guest paths must include a path after ':'");
    }
  }

  const sources = operands.slice(0, -1);
  const target = operands[operands.length - 1];
  if (target === undefined) {
    throw new Error("copy requires at least one source and a target");
  }

  const firstSourceIsGuest = isRootcellGuestCopyPath(sources[0] ?? "");
  if (!sources.every((source) => isRootcellGuestCopyPath(source) === firstSourceIsGuest)) {
    throw new Error("copy sources must be all host paths or all guest paths");
  }

  const targetIsGuest = isRootcellGuestCopyPath(target);
  if (firstSourceIsGuest === targetIsGuest) {
    throw new Error("copy requires exactly one side to use guest path shorthand");
  }

  return {
    sources,
    target,
    direction: firstSourceIsGuest ? "guest-to-host" : "host-to-guest",
  };
}

export function isRootcellGuestCopyPath(value: string): boolean {
  return value.startsWith(":");
}

export function rootcellGuestCopyPath(value: string): string {
  if (!isRootcellGuestCopyPath(value)) {
    return value;
  }
  if (value === ":") {
    throw new Error("copy guest paths must include a path after ':'");
  }
  return value.slice(1);
}
