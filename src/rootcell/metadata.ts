export interface SubcommandMetadata {
  readonly name: "provision" | "allow" | "pubkey" | "spy" | "list" | "stop" | "remove" | "edit" | "extension";
  readonly description: string;
}

export const ROOTCELL_SUBCOMMANDS: readonly SubcommandMetadata[] = [
  { name: "list", description: "list rootcell VMs and their current state" },
  { name: "stop", description: "stop the selected rootcell instance VMs" },
  { name: "remove", description: "stop the selected instance and delete VM state" },
  { name: "edit", description: "open an instance config file in $EDITOR" },
  { name: "extension", description: "manage opt-in rootcell extensions" },
  { name: "provision", description: "re-copy files and rebuild both VMs" },
  { name: "allow", description: "hot-reload allowlists into the firewall VM" },
  { name: "pubkey", description: "print the agent VM SSH public key" },
  { name: "spy", description: "open the browser spy through a local SSH tunnel" },
] as const;

export type RootcellSubcommand = (typeof ROOTCELL_SUBCOMMANDS)[number]["name"];

export function isRootcellSubcommand(value: string | undefined): value is RootcellSubcommand {
  return ROOTCELL_SUBCOMMANDS.some((subcommand) => subcommand.name === value);
}
