{ config, pkgs, lib, username, ... }:

let
  net = import ./network.nix;
  firewallEgressInterface = net.firewallEgressInterface;
  firewallPrivateInterface = net.firewallPrivateInterface;
  egressMatch = { Name = firewallEgressInterface; };
  privateMatch = { Name = firewallPrivateInterface; };
  reloadSh = pkgs.runCommand "agent-vm-reload-sh" {} ''
    ln -s /etc/agent-vm/reload.ts "$out"
  '';
  spyGenerator = pkgs.writeShellScript "rootcell-spy-generator" ''
    set -eu
    normal_dir="''${1:?missing generator output dir}"
    env_file=/etc/agent-vm/spy.env
    if [ -r "$env_file" ] && ${pkgs.gnugrep}/bin/grep -Eq '^ROOTCELL_SPY_ENABLED=(1|true|yes|on)$' "$env_file"; then
      ${pkgs.coreutils}/bin/mkdir -p "$normal_dir/multi-user.target.wants"
      ${pkgs.coreutils}/bin/ln -s /etc/systemd/system/rootcell-spy.service "$normal_dir/multi-user.target.wants/rootcell-spy.service"
    fi
  '';
  spyGeneratorPackage = pkgs.runCommand "rootcell-spy-generator-package" {} ''
    install -D -m 0755 ${spyGenerator} "$out/lib/systemd/system-generators/rootcell-spy-generator"
  '';
  spyServiceArtifact = ./dist/spy-service.js;
  spyUiArtifact = ./dist/spy-ui;
  # In a Git-backed flake, ignored generated files are invisible to Nix even
  # when they exist in the worktree. Rootcell builds and copies these artifacts
  # before guest provisioning; clean CI flake evals should still validate the
  # base firewall closure without requiring committed dist/ outputs.
  haveSpyArtifacts =
    builtins.pathExists spyServiceArtifact
    && builtins.pathExists spyUiArtifact;
in

# Firewall VM: a tiny appliance VM that brokers all egress for the agent VM.
#
# Two NICs under stock Lima/VZ:
#   enp0s1  Lima user-v2 — per-instance link to the agent VM
#                         (IPs come from network.nix/network-local.nix)
#   enp0s2  Lima VZ NAT  — internet egress plus host control SSH
#
# Hybrid filtering — HTTPS is intercepted, SSH is explicit, HTTP is denied:
#
#   HTTPS traffic from the agent VM is intercepted by nftables NAT
#   PREROUTING REDIRECT (TCP 443 → local :8081), so the agent VM's
#   `curl https://github.com` works without any proxy env vars. mitmproxy
#   in transparent mode reads the original destination via SO_ORIGINAL_DST
#   and the SNI from the TLS ClientHello. If the SNI is in the allowlist
#   mitmproxy terminates TLS (using our per-deployment CA, trusted by the
#   agent VM via security.pki.certificateFiles) and opens a NEW TLS
#   connection upstream, validating the upstream cert against the SNI/Host.
#   That validation is the whole point of the MITM: with passthrough, a
#   client cooperating with the exfil endpoint could send SNI=github.com
#   while routing the TCP to attacker IP, and `curl -k` would accept the
#   attacker's cert. With MITM, mitmproxy is the TLS *client* upstream and
#   the attacker IP can't produce a valid github.com cert.
#
#   SSH is explicit. The agent VM's `programs.ssh.matchBlocks` (in home.nix)
#   sets a ProxyCommand that opens an HTTP CONNECT tunnel to mitmproxy
#   running in regular mode on :8080. mitmproxy's addon allowlists by
#   CONNECT host:22. SSH is not MITM'd — that would break key-based auth
#   from inside the VM.
#
#   Cleartext HTTP (TCP/80) is NOT proxied and NOT forwarded. The HTTP
#   `Host` header is unauthenticated — a client can claim any allowlisted
#   name while connecting to any IP, so a Host-header allowlist gives no
#   real guarantee. Without a NAT REDIRECT for port 80, packets hit
#   FORWARD with no rule and are dropped (ip_forward=0 backstops this).
#   All egress must be HTTPS or SSH.
#
#   DNS is explicit too — the agent VM's networkConfig.DNS points at the
#   firewall directly. dnsmasq forwards allowlisted suffixes to the firewall's
#   system resolver; everything else returns 0.0.0.0.
#
# Why two mitmproxy instances? mitmproxy listens in one mode at a time —
# transparent expects raw redirected TCP, regular expects HTTP CONNECT.
# Both use the same addon (Python file), but separate sockets and modes.
#
# Why no IP forwarding? With ip_forward=0 the kernel refuses to forward
# packets at all. The NAT REDIRECT path doesn't need forwarding because
# DNAT rewrites the destination to local before the routing decision —
# packets land in INPUT, not FORWARD. Any TCP traffic that doesn't match
# the REDIRECT rule (e.g., agent's direct attempt to github.com:22) gets
# dropped because there's no route. Belt-and-suspenders against any
# escape via unredirected ports.
#
# Allowlists are mutable runtime files (NOT Nix-store) so `./rootcell allow`
# can hot-reload them without a guest rebuild.

{
  imports =
    [ ./common.nix ]
    ++ lib.optional (builtins.pathExists ./generated/extensions-firewall-vm.nix)
      ./generated/extensions-firewall-vm.nix;

  networking.hostName = "firewall-vm";
  environment.systemPackages = [
    pkgs.bun
  ];
  users.groups.rootcell-spy = {};
  users.users.rootcell-spy = {
    isSystemUser = true;
    group = "rootcell-spy";
  };
  systemd.packages = [ spyGeneratorPackage ];

  # ── Networking ────────────────────────────────────────────────────────
  networking.useDHCP = false;
  networking.useNetworkd = true;
  systemd.network.enable = true;
  # Lima VSock is the provisioning/control path, so switching the firewall
  # config must not depend on networkd's global online heuristic. The private
  # user-v2 peer may not exist until the agent starts, and the egress NIC can
  # briefly churn while Lima's guest services are restarted.
  systemd.network.wait-online.enable = false;

  # Lima vzNAT, our internet-egress NIC. Default route lives here.
  systemd.network.networks."10-egress" = {
    matchConfig = egressMatch;
    networkConfig.DHCP = "ipv4";
    dns = net.firewallUpstreamDns;
  };

  # Private Lima user-v2 link to the agent VM. Lima's VZ hostagent waits for a
  # DHCP lease on user-v2 before it opens the VSOCK SSH control path after
  # restarts, but Rootcell keeps DHCP routes and DNS disabled here.
  systemd.network.networks."20-private" = {
    matchConfig = privateMatch;
    # The firewall boots before the agent, so the private user-v2 peer may not
    # be present yet. Do not let wait-online fail the rebuild while waiting for
    # this link; the static address is still configured by networkd.
    linkConfig.RequiredForOnline = false;
    networkConfig = {
      DHCP = "ipv4";
      IPv6AcceptRA = false;
      LinkLocalAddressing = "no";
    };
    dhcpV4Config = {
      UseDNS = false;
      UseDomains = false;
      UseHostname = false;
      UseMTU = false;
      UseNTP = false;
      UseRoutes = false;
      UseTimezone = false;
    };
    address = [ "${net.firewallIp}/${toString net.networkPrefix}" ];
  };

  boot.kernel.sysctl = {
    # See the header comment for why forwarding stays off.
    "net.ipv4.ip_forward" = 0;
    "net.ipv6.conf.all.forwarding" = 0;
    "net.ipv6.conf.all.disable_ipv6" = 1;
    "net.ipv6.conf.default.disable_ipv6" = 1;
  };

  # ── Firewall ──────────────────────────────────────────────────────────
  # NixOS firewall manages the filter table. We add a separate nat table
  # below for the REDIRECT rules. Inbound on the private link to the
  # agent VM) is allowed only on the explicit-mitmproxy port
  # (8080), the transparent-mitmproxy port (8081, which is the
  # post-REDIRECT destination), and dnsmasq (53).
  networking.nftables.enable = true;
  networking.firewall = {
    enable = true;
    # Lima's hostagent reaches sshd through the instance's localhost-forwarded
    # control port. Keep that available regardless of the guest-side interface
    # name Lima assigns after the first nixos-rebuild.
    allowedTCPPorts = [ 22 ];
    interfaces.${firewallPrivateInterface} = {
      allowedTCPPorts = [ 8080 8081 ];
      allowedUDPPorts = [ 53 ];
    };
  };

  # NAT REDIRECT for transparent HTTPS. Lives in its own table so it
  # doesn't tangle with the NixOS-generated firewall table. The dstnat hook
  # rewrites the destination IP/port BEFORE the routing decision, so the
  # packet lands in INPUT chain (not FORWARD) and is delivered to mitmproxy.
  #
  # Only TCP/443 is redirected. TCP/80 is intentionally NOT redirected:
  # cleartext HTTP can't be allowlisted safely (Host header is unauthenticated),
  # so port-80 packets fall through to FORWARD with no rule and are dropped.
  networking.nftables.tables.agent-vm-nat = {
    family = "ip";
    content = ''
      chain prerouting {
        type nat hook prerouting priority dstnat;
        # iifname (not iif) so NixOS's build-time `nft -c` validation
        # doesn't fail — iif resolves to a kernel ifindex at parse time
        # and the device doesn't exist on the build host. iifname is a
        # string match resolved at rule-load time inside the running
        # guest.
        iifname "${firewallPrivateInterface}" tcp dport 443 redirect to :8081
      }
    '';
  };

  # ── Mutable allowlist directory ───────────────────────────────────────
  # `./rootcell allow` writes here over SSH as ${username}, so the dir is owned
  # by ${username}, not root. The dnsmasq-allowlist.conf seed is empty:
  # dnsmasq's
  # pre-start check refuses to launch without the conf-file existing,
  # but with `no-resolv` and no `server=` directives, an empty
  # conf-file means every query returns REFUSED — fail-closed by
  # default until reload.sh runs and writes the real allowlist. The
  # `f` rule only creates if missing, so the file we write later via
  # reload.sh isn't clobbered; reload.sh runs as root (via sudo) and
  # can overwrite root-owned files in a user-owned directory.
  #
  # The CA pem (key + cert) for TLS MITM is staged here too, but
  # written by `./rootcell` via SCP to /tmp plus `sudo install -m 0600 -o root
  # -g root` — never touchable by the normal guest user. That user has
  # passwordless sudo, but the explicit ownership chmod makes the blast radius
  # "must already be root" rather than "any read of /etc/agent-vm leaks the
  # key". Loaded into the mitmproxy services via systemd LoadCredential, which
  # surfaces it as a tmpfs file readable only by the service uid.
  systemd.tmpfiles.rules = [
    "d /etc/agent-vm 0755 ${username} users -"
    "f /etc/agent-vm/dnsmasq-allowlist.conf 0644 root root -"
    "d /var/lib/rootcell-spy 0750 rootcell-spy rootcell-spy -"
    "d /var/spool/rootcell-spy 2770 root rootcell-spy -"
  ];

  # ── mitmproxy ─────────────────────────────────────────────────────────
  # The addon is in /etc via environment.etc so it has a stable path that
  # systemd's strict sandboxing can read. It stats the allowlist files on
  # every event and reloads on mtime change, so `./rootcell allow` takes
  # effect with no service restart.
  #
  # Both services bind 0.0.0.0 (not net.firewallIp) — even with
  # `After=network-online.target`, mitmproxy can race ahead of
  # systemd-networkd assigning the private static address and bind() fails
  # with "could not bind on any address". 0.0.0.0 sidesteps the race
  # without weakening the security boundary: networking.firewall (above)
  # only allows TCP/8080 and TCP/8081 inbound on the private interface, so
  # the agent VM is still the only thing that can reach these ports.
  environment.etc."agent-vm/mitmproxy_addon.py".source = ./proxy/mitmproxy_addon.py;
  environment.etc."agent-vm/agent_spy.py" = {
    source = ./proxy/agent_spy.py;
    mode = "0644";
  };
  environment.etc."agent-vm/spy-service.js" = lib.mkIf haveSpyArtifacts {
    source = spyServiceArtifact;
    mode = "0644";
  };
  environment.etc."agent-vm/spy-ui" = lib.mkIf haveSpyArtifacts {
    source = spyUiArtifact;
  };

  # mitmproxy unconditionally materializes a `confdir` on startup. It
  # also LOOKS in confdir for `mitmproxy-ca.pem`; if present it uses
  # that as the signing CA, otherwise it auto-generates one. We want
  # mitmproxy to use OUR CA (the one whose public cert the agent VM
  # trusts), so we:
  #
  #   1. Stage the key+cert pem at /etc/agent-vm/agent-vm-ca.pem
  #      (root-owned, mode 0600, written by `./rootcell`).
  #   2. systemd LoadCredential reads it as root and surfaces it under
  #      $CREDENTIALS_DIRECTORY (a per-service tmpfs that only the
  #      service uid can read).
  #   3. ExecStartPre copies the credential into the per-service
  #      RuntimeDirectory (which IS writable, unlike the credentials
  #      tmpfs mitmproxy can't write its own runtime artifacts into).
  #   4. mitmproxy is launched with --set confdir pointing at the
  #      RuntimeDirectory and finds mitmproxy-ca.pem already there.
  #
  # ConditionPathExists guards the bootstrap window: on the very first
  # nixos-rebuild the CA is not yet copied in (./rootcell does that AFTER
  # rebuild — we can't copy into /etc/agent-vm/ before tmpfiles creates the
  # dir), so the services skip cleanly. ./rootcell then pushes the CA and
  # `systemctl restart`s, which re-evaluates the condition.
  systemd.services.mitmproxy-explicit = {
    description = "mitmproxy (explicit CONNECT — for SSH ProxyCommand)";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    wantedBy = [ "multi-user.target" ];
    unitConfig.ConditionPathExists = "/etc/agent-vm/agent-vm-ca.pem";
    # Restart when the addon source changes. mitmproxy reloads scripts on
    # mtime, but it only re-reads function bodies — module-level state
    # (logger handler attachment, caches) is set once at process start.
    # Force a clean restart so addon edits actually take effect on
    # `./rootcell provision`.
    restartTriggers = [ ./proxy/mitmproxy_addon.py ./proxy/agent_spy.py ];
    serviceConfig = {
      LoadCredential = "mitmproxy-ca.pem:/etc/agent-vm/agent-vm-ca.pem";
      RuntimeDirectory = "mitmproxy-explicit";
      ExecStartPre = "${pkgs.coreutils}/bin/install -m 0400 %d/mitmproxy-ca.pem %t/mitmproxy-explicit/mitmproxy-ca.pem";
      ExecStart = lib.concatStringsSep " " [
        "${pkgs.mitmproxy}/bin/mitmdump"
        "--mode regular"
        "--listen-host 0.0.0.0"
        "--listen-port 8080"
        "--set termlog_verbosity=warn"
        "--set flow_detail=0"
        "--set store_streamed_bodies=true"
        # Defer opening the upstream TCP connection until after our addon
        # runs. Originally needed for the SNI deny path's address rewrite
        # to take effect (the default "eager" strategy opens the upstream
        # before tls_clienthello fires, and Server.address can't be mutated
        # on an already-open connection). Still required: with MITM, the
        # addon may decide to deny based on SNI before any upstream open.
        "--set connection_strategy=lazy"
        "--set confdir=%t/mitmproxy-explicit"
        "-s /etc/agent-vm/mitmproxy_addon.py"
      ];
      DynamicUser = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      NoNewPrivileges = true;
      ReadOnlyPaths = "/etc/agent-vm";
      ReadWritePaths = [ "/var/spool/rootcell-spy" ];
      SupplementaryGroups = [ "rootcell-spy" ];
      Restart = "on-failure";
      RestartSec = "2s";
    };
  };

  systemd.services.mitmproxy-transparent = {
    description = "mitmproxy (transparent — for NAT-redirected HTTPS)";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    wantedBy = [ "multi-user.target" ];
    unitConfig.ConditionPathExists = "/etc/agent-vm/agent-vm-ca.pem";
    restartTriggers = [ ./proxy/mitmproxy_addon.py ./proxy/agent_spy.py ];
    serviceConfig = {
      LoadCredential = "mitmproxy-ca.pem:/etc/agent-vm/agent-vm-ca.pem";
      RuntimeDirectory = "mitmproxy-transparent";
      ExecStartPre = "${pkgs.coreutils}/bin/install -m 0400 %d/mitmproxy-ca.pem %t/mitmproxy-transparent/mitmproxy-ca.pem";
      ExecStart = lib.concatStringsSep " " [
        "${pkgs.mitmproxy}/bin/mitmdump"
        "--mode transparent"
        "--listen-host 0.0.0.0"
        "--listen-port 8081"
        "--set termlog_verbosity=warn"
        "--set flow_detail=0"
        "--set store_streamed_bodies=true"
        "--set connection_strategy=lazy"
        "--set confdir=%t/mitmproxy-transparent"
        "-s /etc/agent-vm/mitmproxy_addon.py"
      ];
      DynamicUser = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      ReadOnlyPaths = "/etc/agent-vm";
      ReadWritePaths = [ "/var/spool/rootcell-spy" ];
      SupplementaryGroups = [ "rootcell-spy" ];
      Restart = "on-failure";
      RestartSec = "2s";
      # Transparent mode binds the listening socket with IP_TRANSPARENT
      # (needed even though our packets arrive via NAT REDIRECT to a local
      # IP — mitmproxy sets the sockopt unconditionally in transparent
      # mode). IP_TRANSPARENT requires CAP_NET_ADMIN, which DynamicUser
      # services don't have by default. Grant it as an ambient capability
      # so the binary inherits it without needing setcap on disk. We do
      # NOT set NoNewPrivileges=true here because that interacts badly
      # with AmbientCapabilities under DynamicUser; the rest of the
      # sandbox (DynamicUser + ProtectSystem + ReadOnlyPaths) stays.
      AmbientCapabilities = [ "CAP_NET_ADMIN" ];
      CapabilityBoundingSet = [ "CAP_NET_ADMIN" ];
    };
  };

  systemd.services.rootcell-spy = {
    description = "rootcell browser spy service";
    after = [ "network.target" ];
    unitConfig.ConditionPathExists = "/etc/agent-vm/spy.env";
    serviceConfig = {
      User = "rootcell-spy";
      Group = "rootcell-spy";
      EnvironmentFile = "/etc/agent-vm/spy.env";
      Environment = "ROOTCELL_SPY_STATIC_DIR=/etc/agent-vm/spy-ui";
      ExecStart = "${pkgs.bun}/bin/bun /etc/agent-vm/spy-service.js";
      WorkingDirectory = "/var/lib/rootcell-spy";
      StateDirectory = "rootcell-spy";
      UMask = "0077";
      ProtectSystem = "strict";
      ProtectHome = true;
      NoNewPrivileges = true;
      PrivateTmp = true;
      ReadOnlyPaths = "/etc/agent-vm";
      ReadWritePaths = [ "/var/lib/rootcell-spy" "/var/spool/rootcell-spy" ];
      Restart = "on-failure";
      RestartSec = "2s";
    };
  };

  # ── dnsmasq ───────────────────────────────────────────────────────────
  # The conf-file is generated by /etc/agent-vm/reload.sh from
  # allowed-dns.txt and reloaded with SIGHUP. systemd.tmpfiles seeds it
  # with a catch-all (above) so the pre-start check passes on first boot.
  services.dnsmasq = {
    enable = true;
    resolveLocalQueries = false;
    settings = {
      listen-address = net.firewallIp;
      # bind-dynamic, not bind-interfaces: the latter requires the listen
      # address to already be configured on an interface at start time,
      # which races with systemd-networkd assigning the private static IP.
      # bind-dynamic uses IP_FREEBIND and tracks interface changes.
      bind-dynamic = true;
      no-resolv = true;
      domain-needed = true;
      bogus-priv = true;
      conf-file = "/etc/agent-vm/dnsmasq-allowlist.conf";
    };
  };

  # Belt-and-suspenders: even with bind-dynamic, wait for the network to
  # be online so the first listen-address bind reliably finds the private IP.
  systemd.services.dnsmasq = {
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
  };

  # ── Reload helper ─────────────────────────────────────────────────────
  # `./rootcell allow` runs this after copying new allowlist files in.
  environment.etc."agent-vm/reload.ts" = {
    source = ./src/bin/reload.ts;
    mode = "0755";
  };
  environment.etc."agent-vm/reload.sh" = {
    source = reloadSh;
  };
}
