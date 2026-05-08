{
  description = "Disposable NixOS Lima VM for agentic coding with pi (pi.dev)";

  inputs = {
    # Must match what nixos-lima is built against. v0.0.5 = nixos-25.11.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";

    nixos-lima = {
      url = "github:nixos-lima/nixos-lima/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    home-manager = {
      url = "github:nix-community/home-manager/release-25.11";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, nixos-lima, home-manager, ... }:
    let
      # Apple Silicon hosts use aarch64-linux guests.
      # Switch to "x86_64-linux" if you're on an Intel Mac or x86 Linux host.
      system = "aarch64-linux";

      # Username inside the guest. MUST agree with:
      #   - GUEST_USER in ./agent
      #   - --set '.user.name = "<this>"' passed to limactl start
      username = "luser";

      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      # System-level NixOS configuration. Built/switched with `nixos-rebuild`.
      nixosConfigurations.agent-vm = nixpkgs.lib.nixosSystem {
        inherit system;
        # Pass nixos-lima through so configuration.nix can import its module.
        specialArgs = { inherit username nixos-lima; };
        modules = [ ./configuration.nix ];
      };

      # Home Manager configuration. Built/switched with `home-manager`.
      homeConfigurations.${username} = home-manager.lib.homeManagerConfiguration {
        inherit pkgs;
        extraSpecialArgs = { inherit username; };
        modules = [ ./home.nix ];
      };
    };
}
