{
  description = "rootcell: root-capable coding-agent workspaces with allowlisted egress";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";

    home-manager = {
      url = "github:nix-community/home-manager/release-25.11";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    nixos-lima = {
      url = "github:nixos-lima/nixos-lima/v0.0.5";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, home-manager, nixos-lima, ... }:
    let
      # Rootcell currently provisions aarch64-linux guests.
      system = "aarch64-linux";

      # Username inside the guest. MUST agree with:
      #   - GUEST_USER in ./rootcell
      username = "luser";

      pkgs = nixpkgs.legacyPackages.${system};

      mkVM = module: nixpkgs.lib.nixosSystem {
        inherit system;
        specialArgs = { inherit username; };
        modules = [
          nixos-lima.nixosModules.lima
          module
        ];
      };

      rootcellSourceRevision = self.rev or self.dirtyRev or "unknown";
      nixpkgsRevision = nixpkgs.rev or "unknown";

      # Optional host-side packages for running rootcell on macOS through Nix.
      forEachDarwin = nixpkgs.lib.genAttrs [ "aarch64-darwin" "x86_64-darwin" ];
      darwinPkgs = forEachDarwin (sys:
        let
          p = import nixpkgs {
            system = sys;
            config.permittedInsecurePackages = [
              "lima-1.2.2"
            ];
          };
        in {
          lima = p.lima;
          hostTools = p.buildEnv {
            name = "rootcell-host-tools";
            paths = [
              p.bun
              p.lima
            ];
          };
        });
    in
    {
      # Two VMs share common.nix; each pulls in its own role module.
      # Built/switched with `nixos-rebuild switch --flake .#<name>`.
      nixosConfigurations = {
        agent-vm    = mkVM ./agent-vm.nix;
        firewall-vm = mkVM ./firewall-vm.nix;
      };

      # Home Manager only attaches to the agent VM. The firewall VM is an
      # appliance with no interactive user. Built/switched with `home-manager`.
      homeConfigurations.${username} = home-manager.lib.homeManagerConfiguration {
        inherit pkgs;
        extraSpecialArgs = { inherit username; };
        modules = [ ./home.nix ];
      };

      inherit rootcellSourceRevision nixpkgsRevision;

      packages = forEachDarwin (sys: {
        lima    = darwinPkgs.${sys}.lima;
        hostTools = darwinPkgs.${sys}.hostTools;
        default = darwinPkgs.${sys}.hostTools;
      }) // {
        aarch64-linux = {
          "home-manager" = home-manager.packages.${system}.home-manager;
          default = home-manager.packages.${system}.home-manager;
        };
      };
    };
}
