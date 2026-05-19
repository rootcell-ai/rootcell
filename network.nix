# Network parameters for the agent + firewall VMs. Imported by agent-vm.nix,
# firewall-vm.nix, and home.nix so a single source of truth drives all the
# IPs and the subnet prefix.
#
# Per-instance overrides are copied into the guest as network-local.nix, which
# `rootcell` generates from the instance state directory's state.json. If
# that file doesn't exist (e.g. you're running `nix flake check` outside the
# script), the defaults below apply.
#
# To change these for one instance, edit that instance's state/config and run
# `./rootcell --instance <name> provision`. To change project-wide fallback
# defaults, edit this file.

let
  defaults = {
    # IP of the firewall VM on the private inter-VM network. The agent VM uses
    # this as its default route, DNS server, and SSH proxy.
    #
    # Lima user-v2 reserves low addresses for gateway/DNS. Keep rootcell guests
    # away from that range.
    firewallIp = "192.168.100.10";

    # IP of the agent VM on the same private network.
    agentIp = "192.168.100.11";

    # Subnet prefix length for the inter-VM network.
    networkPrefix = 24;

    # Stock Lima/VZ presents the user-v2 NIC first, before the NAT NIC.
    agentPrivateInterface = "enp0s1";
    firewallPrivateInterface = "enp0s1";
    firewallEgressInterface = "enp0s2";
    firewallControlInterface = "enp0s2";
  };

  override =
    if builtins.pathExists ./network-local.nix
    then import ./network-local.nix
    else { };
in
defaults // override
