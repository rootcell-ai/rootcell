{ config, pkgs, lib, ... }:

# Agent VM: where the coding agent runs. The agent has root inside this VM,
# so this VM is treated as untrusted from the host's perspective. Its only
# network interface points at the firewall VM at 192.168.106.1, which
# enforces the egress allowlists (mitmproxy + dnsmasq).

{
  imports = [ ./common.nix ];

  networking.hostName = "agent-vm";

  # No firewall inside this VM — the agent has root and could rewrite it
  # anyway. All meaningful filtering happens in the firewall VM.
  networking.firewall.enable = false;

  # Networking: ONLY the lima:host interface (lima0). No Virtio NAT, no
  # IPv6, no path to the internet that bypasses the firewall VM.
  # `limactl shell` keeps working because ssh.overVsock=true is the default
  # on vz+Linux, so the SSH control plane is independent of any IP NIC.
  networking.useDHCP = false;
  networking.useNetworkd = true;
  systemd.network.enable = true;
  systemd.network.networks."10-lima0" = {
    matchConfig.Name = "lima0";
    networkConfig = {
      DHCP = "no";
      IPv6AcceptRA = false;
      LinkLocalAddressing = "no";
    };
    address = [ "192.168.106.2/24" ];
    routes = [ { Gateway = "192.168.106.1"; } ];
    dns = [ "192.168.106.1" ];
  };

  # Belt-and-suspenders: even if a default route appeared on something else,
  # disable v6 system-wide so we have no v6 leak path.
  boot.kernel.sysctl = {
    "net.ipv6.conf.all.disable_ipv6" = 1;
    "net.ipv6.conf.default.disable_ipv6" = 1;
  };

  # Don't let any future module sneak entries in /etc/hosts that resolve
  # without going through dnsmasq. (Empty by default in NixOS but make it
  # explicit so it's an invariant, not an accident.)
  networking.hosts = lib.mkForce {};

  # nix-daemon and other system fetchers need to use the firewall as their
  # HTTP proxy — there's no other internet path. The `agent` script also
  # writes a matching systemd drop-in BEFORE the first nixos-rebuild so
  # the bootstrap fetch can use the proxy too; this declaration replaces
  # that drop-in once the new config activates.
  systemd.services.nix-daemon.environment = {
    HTTPS_PROXY = "http://192.168.106.1:8080";
    HTTP_PROXY  = "http://192.168.106.1:8080";
    https_proxy = "http://192.168.106.1:8080";
    http_proxy  = "http://192.168.106.1:8080";
  };
}
