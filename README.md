# lima-pi-vm

Disposable NixOS Lima VM, declaratively configured, with [pi](https://pi.dev)
as the only coding agent installed.

## Layout

```
flake.nix          # inputs (nixpkgs, nixos-lima, home-manager) + outputs
configuration.nix  # NixOS system config: dev tooling + pi runtime deps
home.nix           # Home Manager config: installs pi via npm
nixos.yaml         # Lima config: inherits upstream image, hardcodes hardware
```

The `nixos.yaml` inherits the base image and lima-guestagent setup from
upstream nixos-lima (via Lima's `base:` field) and overrides only the
hardware allocation locally — so memory/CPU are pinned in-repo while
image updates still flow through.

## One-time setup on the host

You need Lima installed on your Mac (`brew install lima` or via Nix).
You do NOT need Nix on the host — all Nix work happens inside the guest.

## Bring the VM up

```bash
# 1. Boot the VM using our pinned config.
limactl start --name=agent --set '.user.name = "luser"' ./nixos.yaml

# 2. Drop into the VM. From here on, everything runs inside the guest.
limactl shell agent

# 3. Inside the VM: clone this repo (or copy it via the Lima home mount).
git clone <your-fork-of-this-repo> ~/lima-pi-vm
cd ~/lima-pi-vm

# 4. Switch the system to our config.
sudo nixos-rebuild switch --flake .#agent-vm

# 5. Switch the user environment (this is what installs pi).
nix run nixpkgs#home-manager -- switch --flake .#lima

# 6. Set your provider key, then run the agent.
export ANTHROPIC_API_KEY=sk-...
pi
```

After step 5, `pi` is on your PATH via `~/.npm-global/bin`.

## The "spin up / tear down" loop

For a fully ephemeral run (clean slate every time):

```bash
limactl delete agent --force        # blow it away
limactl start --name=agent ./nixos.yaml
# ...repeat steps 2–5 above
```

For a faster cycle (keeps Nix store cache, just stops the VM):

```bash
limactl stop agent
limactl start agent
```

The first delete-and-recreate takes a few minutes (download base image,
fetch nixpkgs, build closure, npm install pi). Subsequent rebuilds in the
same VM are fast because the Nix store is cached.

## Customizing

- **Adjust hardware**: edit `memory`, `cpus`, `disk` in `nixos.yaml`, then
  `limactl stop agent && limactl start agent` (some changes require
  `limactl delete` + recreate).
- **Add or change tools**: edit `home.packages` in `home.nix`, then
  `home-manager switch --flake .#lima`. Fast.
- **Change OS-level config** (sudo, nix daemon, users, services): edit
  `configuration.nix`, then `sudo nixos-rebuild switch --flake .#agent-vm`.
  Slower; usually unnecessary.
- **Change architecture**: flip `system` in `flake.nix` to `"x86_64-linux"`
  if you're not on Apple Silicon.
- **Change username**: edit `username` in `flake.nix` AND pass
  `--set '.user.name = "<name>"'` to `limactl start` so the Lima-created
  user matches.
- **Pin pi version**: in `home.nix`, change the npm install line to
  `@earendil-works/pi-coding-agent@X.Y.Z`.

## Why pi gets installed via npm activation, not as a Nix package

Pi isn't packaged in nixpkgs (yet). The cleanest declarative alternative
would be `buildNpmPackage`, but that requires checking in a lockfile and
re-vendoring on every upstream release. For a tool that updates frequently
and lives in a disposable VM, an idempotent `npm install -g` from a Home
Manager activation is the pragmatic choice — still declarative from your
perspective (one line in `home.nix` controls it), without the maintenance
overhead.

## Secrets

Don't put `ANTHROPIC_API_KEY` (or any other provider key) in `home.nix` —
the Nix store is world-readable. Either:

1. Export it in your shell each session (simplest).
2. Put it in `~/.config/pi/...` inside the VM and let pi read it.
3. Forward it from the host via Lima's `env` config in a custom YAML.
