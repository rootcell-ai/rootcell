{ pkgs }:

# Pi (pi.dev) ships a Bun-compiled standalone binary on each release, so
# we don't need Node.js in the VM at all. Pinned by version + sha256 —
# bump both fields together. Latest at:
#   https://github.com/earendil-works/pi/releases
#
# The release tarball contains the binary plus runtime resources it
# reads at startup (themes, export-html template, a wasm blob, and
# package.json for the version string). Copy the whole unpacked tree
# under $out/share so we don't have to track which files are needed,
# and symlink the binary into $out/bin so `pi` is on PATH.
pkgs.stdenv.mkDerivation rec {
  pname = "pi-coding-agent";
  version = "0.99.1";

  src = pkgs.fetchurl {
    url = "https://github.com/earendil-works/pi/releases/download/v${version}/pi-linux-arm64.tar.gz";
    sha256 = "0m39f69dq7hxff7qbz4w9gv86233blc0j7gps3zjarf8bgjsjcp6";
  };

  # Patch the bundled ELF interpreter to point at glibc inside the Nix
  # store; otherwise the binary fails immediately on NixOS, which has no
  # /lib64/ld-linux-aarch64.so.1.
  nativeBuildInputs = [ pkgs.autoPatchelfHook ];
  buildInputs = [
    pkgs.stdenv.cc.cc.lib
    # The bundled Linux clipboard addon links against libxcb.
    pkgs.libxcb
  ];

  installPhase = ''
    runHook preInstall
    mkdir -p $out/share/pi-coding-agent $out/bin
    cp -r . $out/share/pi-coding-agent/
    ln -s $out/share/pi-coding-agent/pi $out/bin/pi
    runHook postInstall
  '';

  # Bun-compiled binaries embed a custom section that strip(1) corrupts.
  dontStrip = true;
}
