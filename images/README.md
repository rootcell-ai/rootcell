# rootcell image assets

rootcell no longer builds or publishes release VM images.

The Lima provider currently uses the upstream `nixos-lima` AARCH64 qcow2 image.
The generated Lima YAML pins that image URL and digest directly while keeping
rootcell's own runtime settings, including `mounts: []`.

The scripts in this directory are retained as historical scaffolding only. They
are not part of the active runtime or release process, and the active Lima
runtime does not consume rootcell-built image assets.
