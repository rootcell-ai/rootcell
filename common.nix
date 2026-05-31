{ modulesPath, pkgs, lib, username, ... }:

# Shared NixOS bits used by both the agent VM and the firewall VM. Things
# that are genuinely VM-specific (hostname, networking, firewall policy,
# services) live in agent-vm.nix and firewall-vm.nix respectively.

let
  net = import ./network.nix;
  isAwsEc2 = (net.provider or "lima") == "aws-ec2";
in
{
  imports = [
    # Required for the guest to boot under virtio VM runtimes.
    (modulesPath + "/profiles/qemu-guest.nix")
  ] ++ lib.optionals isAwsEc2 [
    (modulesPath + "/virtualisation/amazon-image.nix")
  ];

  config = {
    # Rootcell manages guests over SSH through the firewall.
    services.openssh.enable = true;

    users.users.${username} = {
      isSystemUser = true;
      uid = lib.mkDefault 501;
      home = lib.mkDefault "/home/${username}";
      createHome = true;
      homeMode = "0755";
      group = "users";
      extraGroups = [ "wheel" ];
      shell = pkgs.bash;
      linger = true;
    };

    security.sudo.wheelNeedsPassword = false;

    # Enable flakes + the new CLI. Required for nixos-rebuild --flake.
    nix.settings = {
      experimental-features = [ "nix-command" "flakes" ];
      trusted-users = [ "root" username ];
      auto-optimise-store = true;
    };

    # Garbage-collect the Nix store weekly so the VM doesn't grow without bound.
    nix.gc = {
      automatic = true;
      dates = "weekly";
      options = "--delete-older-than 14d";
    };

    boot.loader.grub = lib.mkIf (!isAwsEc2) {
      device = lib.mkDefault "nodev";
      efiSupport = lib.mkDefault true;
      efiInstallAsRemovable = lib.mkDefault true;
    };

    fileSystems."/boot" = lib.mkIf (!isAwsEc2) {
      device = lib.mkDefault "/dev/vda1";
      fsType = lib.mkDefault "vfat";
    };

    fileSystems."/" = {
      device = lib.mkDefault "/dev/disk/by-label/nixos";
      autoResize = lib.mkDefault true;
      fsType = lib.mkDefault "ext4";
      options = [ "noatime" "nodiratime" "discard" ];
    };

    environment.enableAllTerminfo = true;
    services.lima.enable = !isAwsEc2;
    # nixos-lima v0.0.5 boots with dbus-daemon; keep first switch from
    # attempting an in-place migration to dbus-broker.
    services.dbus.implementation = "dbus";
    networking.nat.enable = lib.mkForce false;

    # Lima's hostagent probes `/bin/bash` even when the configured user shell is
    # `/run/current-system/sw/bin/bash`.
    system.activationScripts.rootcellLimaBinBash.text = ''
      mkdir -p /bin
      ln -sfn /run/current-system/sw/bin/bash /bin/bash
    '';

    system.stateVersion = "26.05";
  };
}
