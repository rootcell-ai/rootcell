# proxy/

The egress firewall for the agent VM. All outbound traffic from the agent
VM passes through services running in the firewall VM:

- **mitmproxy** at `192.168.106.1:8080` — HTTP CONNECT proxy with SNI
  inspection. Allows HTTPS to hosts matching [allowed-https.txt](allowed-https.txt)
  and SSH-via-CONNECT to hosts matching [allowed-ssh.txt](allowed-ssh.txt).
  Passes traffic through without MITM (no CA in the guest).
- **dnsmasq** at `192.168.106.1:53` — DNS resolver that forwards names
  matching [allowed-dns.txt](allowed-dns.txt) to 1.1.1.1 and returns
  `0.0.0.0` for everything else.

## Adding a host

Edit the relevant file and run `./agent allow` from the repo root. The
files are copied into the firewall VM and dnsmasq is reloaded; mitmproxy
picks up changes on its next event (no restart). End-to-end takes ~1s.

If a host needs both DNS resolution and HTTPS access (the common case),
add it to **both** `allowed-dns.txt` and `allowed-https.txt`. dnsmasq
matches by suffix, mitmproxy matches by `fnmatch` glob.

## File formats

### `allowed-https.txt`

`fnmatch` glob, one per line. Comments start with `#`.

```
api.github.com         # exact host
*.githubusercontent.com   # one-segment wildcard
bedrock-runtime.*.amazonaws.com   # middle wildcard
```

### `allowed-ssh.txt`

Same format as `allowed-https.txt`, but matched against the CONNECT host
on port 22 (SSH has no SNI, so we can only check the CONNECT line).

### `allowed-dns.txt`

Plain hostnames (no globs). dnsmasq matches as a suffix, so listing
`github.com` lets `api.github.com` and `codeload.github.com` resolve.

## Debugging

```bash
# What's the firewall VM logging?
limactl shell firewall -- journalctl -u mitmproxy -u dnsmasq -f

# Is mitmproxy listening?
limactl shell firewall -- ss -tln

# What's the agent VM seeing?
./agent -- curl -v https://example.com 2>&1 | head -20

# Allowlist content currently inside the VM:
limactl shell firewall -- cat /etc/agent-vm/allowed-https.txt
limactl shell firewall -- cat /etc/agent-vm/dnsmasq-allowlist.conf
```

## Files in this directory

- `allowed-https.txt` `allowed-ssh.txt` `allowed-dns.txt` — user-editable
  allowlists. The single source of truth.
- `mitmproxy_addon.py` — Python addon loaded by mitmdump. Reads the
  allowlist files from `/etc/agent-vm/` inside the firewall VM, with
  mtime-based hot reload.
- `reload.sh` — runs inside the firewall VM after `./agent allow` copies
  fresh allowlist files in. Regenerates dnsmasq's config and signals it.
- This README.
