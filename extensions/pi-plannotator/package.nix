{ pkgs }:

let
  runtimeDeps = pkgs.importNpmLock.buildNodeModules {
    npmRoot = ./runtime-deps;
    nodejs = pkgs.nodejs;
    derivationArgs = {
      npmFlags = [ "--legacy-peer-deps" ];
    };
  };
in
pkgs.stdenvNoCC.mkDerivation rec {
  pname = "plannotator-pi-extension";
  version = "0.28.56";

  src = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@plannotator/pi-extension/-/pi-extension-${version}.tgz";
    hash = "sha256-yzQ2weMa95ogENhwMvUMZuI+nv4UkKtS3ctqaBo4SwU=";
  };

  nativeBuildInputs = [
    pkgs.gnutar
    pkgs.gzip
  ];

  unpackPhase = ''
    runHook preUnpack
    mkdir source
    tar -xzf "$src" -C source --strip-components=1
    cd source
    runHook postUnpack
  '';

  installPhase = ''
    runHook preInstall
    packageRoot="$out/share/pi-packages/@plannotator/pi-extension"
    mkdir -p "$packageRoot"
    cp -R . "$packageRoot"/
    chmod -R u+w "$packageRoot"
    cp -R ${runtimeDeps}/node_modules "$packageRoot/node_modules"
    runHook postInstall
  '';
}
