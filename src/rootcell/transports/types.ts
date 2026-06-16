import type { CommandResult, InheritedCommandResult } from "../types.ts";
import type { CopyOptions, CopyToGuestOptions, ExecOptions, LocalPortForwardHandle, LocalPortForwardOptions } from "../providers/types.ts";

export interface GuestTransport {
  readonly id: string;
  exec(name: string, command: readonly string[], options?: ExecOptions): Promise<InheritedCommandResult>;
  execCapture(name: string, command: readonly string[], options?: ExecOptions): Promise<CommandResult>;
  execInteractive(name: string, command: readonly string[], options?: ExecOptions): Promise<number>;
  copy(name: string, sources: readonly string[], target: string, options?: CopyOptions): Promise<void>;
  copyToGuest(name: string, hostPath: string, guestPath: string, options?: CopyToGuestOptions): Promise<void>;
  forwardLocalPort(name: string, options: LocalPortForwardOptions): Promise<LocalPortForwardHandle>;
}
