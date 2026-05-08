"""SNI / CONNECT-host / Host-header allowlist addon for mitmproxy.

Used by two mitmproxy instances on the firewall VM:

  * regular mode (port 8080) — receives explicit HTTP CONNECT from the
    agent VM's SSH ProxyCommand. http_connect inspects the CONNECT host
    against allowed-ssh.txt for port 22.

  * transparent mode (port 8081) — receives nftables-redirected raw TCP
    for ports 80 and 443. For 443, tls_clienthello inspects the SNI from
    the TLS ClientHello against allowed-https.txt. For 80, request
    inspects the Host header against the same list.

In all cases the addon NEVER decrypts (no MITM, no CA in the guest). It
either kills the flow or sets ignore_connection, which makes mitmproxy
relay raw bytes between client and upstream.

Allowlists live in /etc/agent-vm/ on the firewall VM. The addon stats
them on every event and reloads on mtime change, so `./agent allow`
takes effect with no service restart.
"""

import fnmatch
import logging
import os
from mitmproxy import http, tls

# mitmproxy ≥ 11 routes addon logging through stdlib `logging` instead of
# `ctx.log`. Use a module-level logger so journalctl shows our prefix.
logger = logging.getLogger("agent_vm_filter")

ALLOW_HTTPS = "/etc/agent-vm/allowed-https.txt"
ALLOW_SSH = "/etc/agent-vm/allowed-ssh.txt"


class _Cache:
    """Mtime-stamped file reader. Reloads when the file changes on disk."""

    def __init__(self) -> None:
        self.entries: set[str] = set()
        self.mtime: float = -1.0

    def get(self, path: str) -> set[str]:
        try:
            mt = os.path.getmtime(path)
        except FileNotFoundError:
            return set()
        if mt != self.mtime:
            with open(path) as f:
                self.entries = {
                    line.strip()
                    for line in f
                    if line.strip() and not line.lstrip().startswith("#")
                }
            self.mtime = mt
        return self.entries


_https_cache = _Cache()
_ssh_cache = _Cache()


def _matches(host: str, patterns: set[str]) -> bool:
    return any(fnmatch.fnmatchcase(host, p) for p in patterns)


def http_connect(flow: http.HTTPFlow) -> None:
    host = flow.request.host
    port = flow.request.port

    if port == 443:
        # Decision deferred to tls_clienthello, where the real SNI is visible.
        return

    if port == 22:
        if _matches(host, _ssh_cache.get(ALLOW_SSH)):
            logger.info(f"ALLOW ssh {host}:{port}")
            return
        logger.warning(f"DENY ssh {host}:{port}")
        flow.kill()
        return

    logger.warning(f"DENY connect {host}:{port}")
    flow.kill()


def tls_clienthello(data: tls.ClientHelloData) -> None:
    sni = data.client_hello.sni
    if not sni or not _matches(sni, _https_cache.get(ALLOW_HTTPS)):
        logger.warning(f"DENY https sni={sni!r}")
        # Marking ignore_connection on a denied flow before the upstream
        # connection is established results in the client seeing a closed
        # tunnel. That's the desired "fail-closed" behavior.
        data.ignore_connection = True
        return

    logger.info(f"ALLOW https sni={sni}")
    # Passthrough: relay raw bytes, no TLS termination. No CA needed in the
    # guest. The proxy never sees plaintext.
    data.ignore_connection = True


def request(flow: http.HTTPFlow) -> None:
    """Plain HTTP requests on port 80 in transparent mode. Match by Host."""
    # HTTPS flows are short-circuited in tls_clienthello (passthrough), so
    # this hook only fires for cleartext HTTP that was NAT-redirected to
    # the transparent listener. Decision is by the Host header / authority.
    if flow.request.scheme != "http":
        return
    host = flow.request.pretty_host
    if not _matches(host, _https_cache.get(ALLOW_HTTPS)):
        logger.warning(f"DENY http host={host}")
        flow.kill()
        return
    logger.info(f"ALLOW http host={host}")
