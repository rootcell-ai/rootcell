{ pkgs, lib, ... }:

let
  pi-coding-agent = import ../../pi/pi-coding-agent.nix { inherit pkgs; };
  plannotator = import ./package.nix { inherit pkgs; };
  plannotatorPi = pkgs.writeShellScriptBin "pi" ''
    export PLANNOTATOR_REMOTE=true
    export PLANNOTATOR_PORT=19432
    exec ${pi-coding-agent}/bin/pi "$@"
  '';
in
{
  home.packages = [
    (lib.hiPrio plannotatorPi)
  ];

  home.sessionVariables = {
    PLANNOTATOR_REMOTE = "true";
    PLANNOTATOR_PORT = "19432";
  };

  # Pi discovers package-style extension directories under ~/.pi/agent/extensions.
  # The package root keeps its npm identity in package.json while Home Manager
  # manages only this Rootcell-owned leaf.
  home.file.".pi/agent/extensions/@plannotator-pi-extension" = {
    source = "${plannotator}/share/pi-packages/@plannotator/pi-extension";
    recursive = true;
  };
}
