{ config, pkgs, lib, username, ... }:

{
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

  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 14d";
  };

  networking.firewall.enable = false;

  system.stateVersion = "25.11";
}
