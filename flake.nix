{
  description = "Disposable NixOS Lima VM for agentic coding";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";

    nixos-lima = {
      url = "github:nixos-lima/nixos-lima";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    home-manager = {
      url = "github:nix-community/home-manager/release-25.11";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, nixos-lima, home-manager, ... }:
    let
      system = "aarch64-linux";
      username = "luser";
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      # System-level NixOS configuration. Built/switched with `nixos-rebuild`.
      nixosConfigurations.agent-vm = nixpkgs.lib.nixosSystem {
        inherit system;
        specialArgs = { inherit username; };
        modules = [
          nixos-lima.nixosModules.nixos-lima
          ./configuration.nix
        ];
      };

      # Home Manager configuration. Built/switched with `home-manager`.
      # Kept as a standalone home config (not a NixOS module) so you can
      # iterate on it without touching the system closure.
      homeConfigurations.${username} = home-manager.lib.homeManagerConfiguration {
        inherit pkgs;
        extraSpecialArgs = { inherit username; };
        modules = [ ./home.nix ];
      };
    };
}
