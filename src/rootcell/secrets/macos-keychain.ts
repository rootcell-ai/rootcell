import { runCapture, type RunOptions } from "../process.ts";
import type { CommandResult } from "../types.ts";
import type { SecretProvider } from "./types.ts";

export type SecretCommandRunner = (
  command: string,
  args: readonly string[],
  options?: RunOptions,
) => CommandResult;

export class MacOsKeychainSecretProvider implements SecretProvider {
  constructor(
    readonly id = "macos-keychain",
    private readonly capture: SecretCommandRunner = runCapture,
  ) {}

  read(reference: string): Promise<string> {
    const value = this.capture("security", ["find-generic-password", "-s", reference, "-w"], {
      allowFailure: true,
    });
    if (value.status !== 0) {
      const serviceArg = shellQuote(reference);
      return Promise.reject(new Error(`macOS Keychain secret not found.

Add it with:
  security add-generic-password -a "$USER" -s ${serviceArg} -w "<secret>"

Then re-run.`));
    }
    return Promise.resolve(value.stdout.replace(/\r?\n$/, ""));
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
