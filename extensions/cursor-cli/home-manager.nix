{ lib, pkgs, ... }:

{
  home.packages = [
    pkgs.cursor-cli
  ];

  home.file.".cursor/skills-cursor/add-flake-dep" = {
    source = ../../pi/agent/skills/add-flake-dep;
    recursive = true;
  };
  home.file.".cursor/skills-cursor/network-allowlist" = {
    source = ../../pi/agent/skills/network-allowlist;
    recursive = true;
  };

  home.activation.cursorCliHttp1ForAgent = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    config="$HOME/.cursor/cli-config.json"
    tmp="$config.tmp"
    mkdir -p "$HOME/.cursor"
    if [ -s "$config" ] && ${pkgs.jq}/bin/jq '.network = (.network // {}) | .network.useHttp1ForAgent = true' "$config" > "$tmp"; then
      mv "$tmp" "$config"
    else
      rm -f "$tmp"
      printf '%s\n' '{"network":{"useHttp1ForAgent":true}}' > "$config"
    fi
  '';
}
