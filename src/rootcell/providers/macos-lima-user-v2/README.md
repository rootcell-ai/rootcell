# macOS + Lima Provider

The `lima` VM provider runs rootcell's agent and firewall VMs as local Lima
instances on macOS. The paired `macos-lima-user-v2` network provider creates a
private Lima user-v2 network per rootcell instance.

The firewall VM has public egress through Lima VZ NAT plus a private user-v2
interface. The agent VM has only the private user-v2 interface and reaches DNS,
HTTPS, and SSH egress through the firewall. Lima's own `limactl shell` control
path stays on VSOCK.

## Required Instance Environment

The Lima provider is the default. To make an instance `.env` explicit, run:

```sh
./rootcell -i local --init-env macos-lima
```

That command writes:

```sh
ROOTCELL_VM_PROVIDER=lima
```

No other provider-specific environment variables are required. Common rootcell
instance settings such as `ROOTCELL_SUBNET_POOL_START`, `ROOTCELL_SUBNET_POOL_END`,
`FIREWALL_IP`, `AGENT_IP`, and `NETWORK_PREFIX` are described in the main
[README](../../../../README.md).

If you use the default `secrets.env.defaults`, store the Bedrock provider key in
macOS Keychain before entering the VM:

```sh
security add-generic-password -a "$USER" -s aws-bedrock-api-key -w "<your-key>"
```

## Host Requirements

The supported and tested path is Apple Silicon macOS with Lima using Apple's
Virtualization Framework.

Install the host tools with Homebrew:

```bash
brew tap oven-sh/bun
brew install bun lima
bun install --frozen-lockfile
```

Or install the Nix-provided host tools from the repository root:

```bash
nix profile install .#hostTools
bun install --frozen-lockfile
```

For a one-off shell instead of a profile install:

```bash
nix shell .#hostTools --command bun install --frozen-lockfile
nix shell .#hostTools --command ./rootcell
```

If your host Nix install has not enabled flakes and the new CLI yet, add
`--extra-experimental-features 'nix-command flakes'` to the host-side `nix`
commands above.

## Host Tool Resolution

rootcell expects Lima's `limactl` to be on the host `PATH`. For non-standard
paths, set:

```bash
ROOTCELL_LIMACTL=/path/to/limactl
# LIMACTL=/path/to/limactl also works
```

The Lima provider requires Lima 2.0.2 or newer because its generated YAML uses
`ssh.overVsock: true` for the VZ bootstrap SSH path. The repo's `.#hostTools`
package pins a compatible Lima release.

rootcell does not override `LIMA_HOME`; Lima instances, the Lima user key, and
user-v2 networks are managed through the normal Lima home. Set `LIMA_HOME`
yourself if you want Lima state somewhere else.

## Lima Layout

Rootcell writes generated Lima metadata under the instance directory:

```text
<instance-dir>/v/
  a/
    lima.yaml
    state.json
  f/
    lima.yaml
    state.json
```

`a` is the agent VM and `f` is the firewall VM. Plain `./rootcell` creates Lima
instances named `agent` and `firewall`. `./rootcell --instance dev` creates
`agent-dev` and `firewall-dev`.

The generated `state.json` files record the Lima instance name, role, private
IP, network name, generated YAML path, and the firewall's Lima SSH localhost
port. The actual Lima VM state remains under normal `LIMA_HOME`.

## Network Model

For each rootcell instance, the provider creates one Lima user-v2 network named
`rootcell-<hash>`.

Default rootcell instance allocation uses:

- `.10` for the firewall VM.
- `.11` for the agent VM.
- `.2` for the Lima user-v2 gateway and DNS service.

The firewall VM receives two network interfaces:

- A Lima VZ NAT interface for public egress and host control.
- A Lima user-v2 interface for private traffic from the agent.

The agent VM receives only the user-v2 interface. It keeps a DHCP lease on that
link because Lima's VZ hostagent waits for the user-v2 lease before it opens the
VSOCK SSH control endpoint after restarts. DHCP routes and DNS are ignored; the
Rootcell static address, firewall DNS, and default route remain authoritative.
The firewall VM keeps the same route-free, DNS-free DHCP lease on its private
user-v2 interface for the same Lima VSOCK startup path.
During startup, rootcell runs a proof gate inside the agent that checks there is
no extra provider-facing interface beyond the private Rootcell link. Docker's
local bridge/veth interfaces are allowed, but the proof still verifies that the
Rootcell static address is present and that there is no default-route bypass.

The host connects to the firewall through Lima's generated localhost SSH
endpoint. The agent is reached through SSH ProxyJump via the firewall over the
private user-v2 address.

## Upstream NixOS Lima Image

The Lima provider generates its own Lima YAML from the upstream `nixos-lima`
v0.0.5 template. It keeps the upstream NixOS guest contract while replacing the
pieces rootcell needs to control:

- `mounts: []`, so the host home directory is not mounted into either VM.
- `ssh.overVsock: true`, so Lima's local SSH endpoints use VSOCK.
- The guest user, network interfaces, CPU, memory, and disk settings.

The generated YAML pins the upstream `nixos-lima` image URLs and digests instead
of using Lima's template directly. The current supported path provisions
`aarch64-linux` guests.

Default VM sizing is:

| VM | CPUs | Memory | Disk |
| --- | --- | --- | --- |
| agent | 8 | 16 GiB | 60 GiB |
| firewall | 2 | 4 GiB | 64 GiB |

## Lifecycle

Normal entry ensures the user-v2 network exists, creates missing Lima VMs,
provisions them if needed, syncs allowlists, and enters the agent.

Terraform is not involved for this provider. `./rootcell stop` stops the Lima
VMs. `./rootcell remove` stops and deletes the Lima VMs and the rootcell
user-v2 network, then removes the provider state under `v/a` and `v/f`.
Instance-local files such as allowlists, CA material, secret mappings, and
`state.json` remain in the rootcell instance directory.

## Changing Architecture

The default configuration is for Apple Silicon hosts with `aarch64-linux`
guests. For Intel Macs or x86 Linux guests, update these together:

- `system` in `flake.nix`
- The pi release tarball URL and hash in `home.nix`
- The pinned upstream `nixos-lima` image URL, architecture, and digest in
  `src/rootcell/providers/lima.ts`

## Security Notes

The Lima provider writes generated YAML and keeps host filesystem mounts
disabled. The agent VM has no VZ NAT attachment and no direct host-to-agent
network SSH path. Rootcell host entry goes through the firewall, Lima's own
control endpoint uses VSOCK, and agent egress goes through the firewall
allowlist path.

The provider uses Lima's normal host-side SSH identity from `LIMA_HOME/_config/user`
for the initial firewall connection. Agent Git pushes use the separate SSH key
generated inside the agent VM, printed by `./rootcell pubkey`.
