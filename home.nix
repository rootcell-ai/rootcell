{ config, pkgs, lib, username, ... }:

# All user-level tooling lives here. Iterate with `home-manager switch`,
# which is fast and doesn't touch the system closure.

{
  home.username = username;
  home.homeDirectory = "/home/${username}";
  home.stateVersion = "25.11";

  # Everything the agent needs to do useful work, plus core CLIs.
  # Project-specific toolchains belong in per-project flakes/devshells,
  # not here.
  home.packages = with pkgs; [
    # pi runtime deps
    nodejs_22       # pi is a Node.js CLI
    ripgrep         # pi shells out to `rg`
    fd              # pi shells out to `fd`

    # Core dev CLIs
    gh
    curl
    wget
    jq
    yq-go
    unzip

    # Editor (swap for your preference)
    vim
  ];

  # Put npm-installed CLIs (i.e. pi) on PATH and tell npm to install there.
  # We use a user-writable prefix because the Nix store is read-only —
  # `npm install -g` against the default prefix would fail.
  home.sessionVariables = {
    NPM_CONFIG_PREFIX = "${config.home.homeDirectory}/.npm-global";
  };

  home.sessionPath = [
    "${config.home.homeDirectory}/.npm-global/bin"
  ];

  programs.bash = {
    enable = true;
    initExtra = ''
      # Make the shell aware of the npm-global bin dir even in non-login shells.
      export PATH="$HOME/.npm-global/bin:$PATH"
    '';
  };

  # `programs.git.enable` adds git itself, so we don't list it above.
  programs.git = {
    enable = true;
    userName = "Jim Pudar";
    userEmail = "jim@pudar.com";
    extraConfig = {
      init.defaultBranch = "main";
      pull.rebase = true;
    };
  };

  # ---- Pi installation ----------------------------------------------------
  # Pi (pi.dev) is not in nixpkgs at time of writing, so we install it via
  # npm into a user-writable prefix on every `home-manager switch`.
  #
  # `npm install -g` is idempotent: it upgrades pi if a newer version is
  # available, no-ops otherwise. If you want a pinned version, append
  # `@<version>` to the package name.
  home.activation.installPi =
    lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      export PATH="${pkgs.nodejs_22}/bin:$PATH"
      export NPM_CONFIG_PREFIX="${config.home.homeDirectory}/.npm-global"
      mkdir -p "$NPM_CONFIG_PREFIX"
      $DRY_RUN_CMD ${pkgs.nodejs_22}/bin/npm install -g \
        @earendil-works/pi-coding-agent
    '';
}
