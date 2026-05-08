{ config, modulesPath, pkgs, lib, username, nixos-lima, ... }:

# System-level NixOS config. Most user-facing tooling lives in home.nix
# instead, so home-manager can iterate fast without triggering nixos-rebuild.
# This file only contains things that are genuinely system-level: the lima
# integration, boot loader, filesystems, user account, sudo, nix daemon.

{
  imports = [
    # Required for the guest to boot under qemu/vz.
    (modulesPath + "/profiles/qemu-guest.nix")
    # Provides `services.lima.*` options. Sets up lima-init at boot and
    # runs the lima-guestagent daemon as a systemd service.
    nixos-lima.nixosModules.lima
  ];

  networking.hostName = "agent-vm";

  # Activate the nixos-lima module. Without this, lima-guestagent won't
  # run and `limactl shell` will fail after rebuild.
  services.lima.enable = true;

  # Lima communicates with the guest over SSH.
  services.openssh.enable = true;

  # The Lima user. Lima sets up the user at first boot via cloud-init style
  # userdata; we just need the account to exist with sane defaults.
  users.users.${username} = {
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    shell = pkgs.bash;
  };

  # Lima expects passwordless sudo for its guest user.
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

  # Boot/filesystem layout matching the nixos-lima base image.
  # These values come from the nixos-lima image generator and must NOT be
  # changed unless you rebuild the image yourself.
  boot.loader.grub = {
    device = "nodev";
    efiSupport = true;
    efiInstallAsRemovable = true;
  };

  fileSystems."/boot" = {
    device = lib.mkForce "/dev/vda1";
    fsType = "vfat";
  };

  fileSystems."/" = {
    device = "/dev/disk/by-label/nixos";
    autoResize = true;
    fsType = "ext4";
    options = [ "noatime" "nodiratime" "discard" ];
  };
 
  environment.enableAllTerminfo = true;

  boot.kernelPackages = pkgs.linuxPackages_latest;

  # Don't bother with a firewall inside a Lima VM.
  networking.firewall.enable = false;

  # Pin to the NixOS release nixos-lima is built against. Don't bump casually.
  system.stateVersion = "25.11";
}
