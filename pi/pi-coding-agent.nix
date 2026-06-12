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
  version = "0.79.1";

  src = pkgs.fetchurl {
    url = "https://github.com/earendil-works/pi/releases/download/v${version}/pi-linux-arm64.tar.gz";
    sha256 = "015wqibca5pbb1wpm933516zfw50qa0kkxb0qlj19gvssp4a14d1";
  };

  # Patch the bundled ELF interpreter to point at glibc inside the Nix
  # store; otherwise the binary fails immediately on NixOS, which has no
  # /lib64/ld-linux-aarch64.so.1.
  nativeBuildInputs = [ pkgs.autoPatchelfHook ];
  buildInputs = [ pkgs.stdenv.cc.cc.lib ];

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
