"""SNI / CONNECT-host allowlist addon for mitmproxy in regular (forward) mode.

Two decisions per flow:

1. http_connect: when the guest issues `CONNECT host:port`, decide based on
   the destination port. For 22 (SSH) we allowlist by CONNECT host directly
   from allowed-ssh.txt. For 443 we defer to tls_clienthello where the
   real SNI is visible. Other ports: always deny.

2. tls_clienthello: peek at the TLS ClientHello SNI and check it against
   allowed-https.txt. On allow we mark the connection for TCP passthrough
   (no MITM, no decryption — mitmproxy just relays raw bytes). On deny we
   ignore_connection, which causes mitmproxy to close it.

Allowlists are read from /etc/agent-vm/. The addon stats them on every
event and reloads on mtime change, so `./agent allow` takes effect with
no service restart.
"""

import fnmatch
import os
from mitmproxy import ctx, http, tls

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
            ctx.log.info(f"ALLOW ssh {host}:{port}")
            return
        ctx.log.warn(f"DENY ssh {host}:{port}")
        flow.kill()
        return

    ctx.log.warn(f"DENY connect {host}:{port}")
    flow.kill()


def tls_clienthello(data: tls.ClientHelloData) -> None:
    sni = data.client_hello.sni
    if not sni or not _matches(sni, _https_cache.get(ALLOW_HTTPS)):
        ctx.log.warn(f"DENY https sni={sni!r}")
        # Marking ignore_connection on a denied flow before the upstream
        # connection is established results in the client seeing a closed
        # tunnel. That's the desired "fail-closed" behavior.
        data.ignore_connection = True
        return

    ctx.log.info(f"ALLOW https sni={sni}")
    # Passthrough: relay raw bytes, no TLS termination. No CA needed in the
    # guest. The proxy never sees plaintext.
    data.ignore_connection = True
