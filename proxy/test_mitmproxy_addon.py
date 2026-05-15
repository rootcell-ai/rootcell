import os
import sys
import tempfile
import types
import unittest


class OptionsError(Exception):
    pass


mitmproxy = types.ModuleType("mitmproxy")
mitmproxy.ctx = types.SimpleNamespace(
    options=types.SimpleNamespace(connection_strategy="lazy")
)
mitmproxy.exceptions = types.SimpleNamespace(OptionsError=OptionsError)
mitmproxy.http = types.SimpleNamespace(HTTPFlow=object)
mitmproxy.tls = types.SimpleNamespace(ClientHelloData=object)
sys.modules["mitmproxy"] = mitmproxy

sys.path.insert(0, os.path.dirname(__file__))
import mitmproxy_addon


class MitmproxyAddonTests(unittest.TestCase):
    def setUp(self):
        mitmproxy_addon.logger.disabled = True

    def tearDown(self):
        mitmproxy_addon.ctx.options.connection_strategy = "lazy"
        mitmproxy_addon.logger.disabled = False

    def test_cache_normalizes_allowlist_entries_to_lowercase(self):
        with tempfile.NamedTemporaryFile("w", delete=False) as f:
            path = f.name
            f.write("Example.COM\n")
            f.write("  *.GitHubUserContent.COM  \n")
            f.write("  # Comment\n")

        try:
            cache = mitmproxy_addon._Cache()
            self.assertEqual(
                cache.get(path),
                {"example.com", "*.githubusercontent.com"},
            )
        finally:
            os.unlink(path)

    def test_matches_is_case_insensitive_for_hosts_and_patterns(self):
        self.assertTrue(mitmproxy_addon._matches("example.com", {"Example.COM"}))
        self.assertTrue(mitmproxy_addon._matches("API.GITHUB.COM", {"*.github.com"}))

    def test_load_accepts_lazy_connection_strategy(self):
        mitmproxy_addon.ctx.options.connection_strategy = "lazy"
        mitmproxy_addon.load(None)

    def test_load_rejects_non_lazy_connection_strategy(self):
        mitmproxy_addon.ctx.options.connection_strategy = "eager"
        with self.assertRaises(OptionsError) as raised:
            mitmproxy_addon.load(None)

        self.assertIn("connection_strategy=lazy", str(raised.exception))

    def test_configure_rejects_connection_strategy_update_to_non_lazy(self):
        mitmproxy_addon.ctx.options.connection_strategy = "eager"
        with self.assertRaises(OptionsError):
            mitmproxy_addon.configure({"connection_strategy"})


if __name__ == "__main__":
    unittest.main()
