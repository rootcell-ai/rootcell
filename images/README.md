# rootcell image assets

rootcell currently uses the upstream `nixos-lima` AARCH64 qcow2 image for the
Lima provider. The generated Lima YAML pins that image URL and digest directly
while keeping rootcell's own runtime settings, including `mounts: []`.

The scripts in this directory are retained as historical scaffolding for a
future rootcell-owned image release path, but the active Lima runtime does not
consume rootcell-built image assets.
