import base64
import binascii
import json
import os
import struct
import sys
import tempfile
import types
import unittest

sys.path.insert(0, os.path.dirname(__file__))

import agent_spy


def eventstream_message(headers, payload):
    header_bytes = b""
    for name, value in headers.items():
        name_bytes = name.encode("utf-8")
        value_bytes = value.encode("utf-8")
        header_bytes += bytes([len(name_bytes)]) + name_bytes
        header_bytes += bytes([7]) + struct.pack(">H", len(value_bytes)) + value_bytes

    total_len = 16 + len(header_bytes) + len(payload)
    prelude = struct.pack(">II", total_len, len(header_bytes))
    prelude_crc = struct.pack(">I", binascii.crc32(prelude) & 0xFFFFFFFF)
    without_message_crc = prelude + prelude_crc + header_bytes + payload
    message_crc = struct.pack(">I", binascii.crc32(without_message_crc) & 0xFFFFFFFF)
    return without_message_crc + message_crc


def make_flow(
    flow_id="flow-1",
    host="bedrock-runtime.us-east-1.amazonaws.com",
    method="POST",
    path="/model/anthropic.claude/converse-stream",
    request_headers=None,
    request_body=b'{"messages":[]}',
    response_headers=None,
    response_body=b'{"output":{}}',
    status_code=200,
):
    request = types.SimpleNamespace(
        pretty_host=host,
        host=host,
        method=method,
        path=path,
        headers=request_headers
        or [
            ("Content-Type", "application/json"),
            ("Authorization", "AWS4-HMAC-SHA256 Credential=AKIA/..., Signature=abc"),
        ],
        raw_content=request_body,
    )
    response = types.SimpleNamespace(
        status_code=status_code,
        reason="OK",
        headers=response_headers or [("Content-Type", "application/json")],
        raw_content=response_body,
    )
    return types.SimpleNamespace(
        id=flow_id,
        request=request,
        response=response,
        metadata={},
    )


class AgentSpyDetectionTests(unittest.TestCase):
    def test_detects_bedrock_runtime_paths(self):
        info = agent_spy.detect_bedrock_request(
            "bedrock-runtime.us-west-2.amazonaws.com",
            "/model/anthropic.claude-3-5-sonnet-20241022-v2%3A0/converse-stream",
        )
        self.assertIsNotNone(info)
        self.assertEqual(info["operation"], "converse-stream")
        self.assertEqual(info["model_id"], "anthropic.claude-3-5-sonnet-20241022-v2:0")

        fips = agent_spy.detect_bedrock_request(
            "bedrock-runtime-fips.us-gov-west-1.amazonaws.com",
            "/model/anthropic.claude/invoke",
        )
        self.assertIsNotNone(fips)
        self.assertEqual(fips["operation"], "invoke")

        invoke_stream = agent_spy.detect_bedrock_request(
            "bedrock-runtime.us-east-1.amazonaws.com",
            "/model/us.anthropic.claude-sonnet-4-6/invoke-with-response-stream",
        )
        self.assertIsNotNone(invoke_stream)
        self.assertEqual(invoke_stream["operation"], "invoke-with-response-stream")
        self.assertEqual(invoke_stream["model_id"], "us.anthropic.claude-sonnet-4-6")

        self.assertIsNone(
            agent_spy.detect_bedrock_request(
                "api.anthropic.com",
                "/model/anthropic.claude/invoke",
            )
        )

    def test_detects_cursor_agent_api_paths(self):
        info = agent_spy.detect_cursor_request(
            "api2.cursor.sh",
            "/aiserver.v1.AiService/StreamUnifiedChat",
            "POST",
            b'{"model":"Composer 2.5","prompt":"hello"}',
        )
        self.assertIsNotNone(info)
        self.assertEqual(info["provider"], "cursor")
        self.assertEqual(info["operation"], "StreamUnifiedChat")
        self.assertEqual(info["model_id"], "Composer 2.5")

        run_info = agent_spy.detect_cursor_request(
            "api2.cursor.sh",
            "/agent.v1.AgentService/RunSSE",
            "POST",
            b'{"model":"composer-2.5-fast","prompt":"hello"}',
        )
        self.assertIsNotNone(run_info)
        self.assertEqual(run_info["provider"], "cursor")
        self.assertEqual(run_info["operation"], "RunSSE")
        self.assertEqual(run_info["model_id"], "composer-2.5-fast")

        self.assertIsNone(
            agent_spy.detect_cursor_request(
                "downloads.cursor.com",
                "/lab/2026.05.07-42ddaca/linux/arm64/agent-cli-package.tar.gz",
                "GET",
            )
        )
        login_info = agent_spy.detect_cursor_request("api.cursor.com", "/auth/login", "POST")
        self.assertIsNotNone(login_info)
        self.assertEqual(login_info["operation"], "login")

        analytics_info = agent_spy.detect_cursor_request(
            "agentn.global.api5.cursor.sh",
            "/aiserver.v1.AnalyticsService/BootstrapStatsig",
            "POST",
        )
        self.assertIsNotNone(analytics_info)
        self.assertEqual(analytics_info["operation"], "BootstrapStatsig")

        bidi_info = agent_spy.detect_cursor_request(
            "api2.cursor.sh",
            "/aiserver.v1.BidiService/BidiAppend",
            "POST",
        )
        self.assertIsNotNone(bidi_info)
        self.assertEqual(bidi_info["operation"], "BidiAppend")

        repo_info = agent_spy.detect_cursor_request(
            "api2.cursor.sh",
            "/repository.v1.RepositoryService/FastRepoInitHandshakeV2",
            "POST",
        )
        self.assertIsNotNone(repo_info)
        self.assertEqual(repo_info["operation"], "FastRepoInitHandshakeV2")

        get_info = agent_spy.detect_cursor_request(
            "api2.cursor.sh",
            "/aiserver.v1.ServerConfigService/GetUsableModels",
            "GET",
        )
        self.assertIsNotNone(get_info)
        self.assertEqual(get_info["operation"], "GetUsableModels")

    def test_detects_wildcard_cursor_agent_hosts(self):
        info = agent_spy.detect_cursor_request(
            "agentn.global.api5.cursor.sh",
            "/aiserver.v1.AiService/StreamUnifiedChat",
            "POST",
            b'{"model":"composer-2.5-fast","prompt":"hello"}',
        )
        self.assertIsNotNone(info)
        self.assertEqual(info["provider"], "cursor")
        self.assertEqual(info["operation"], "StreamUnifiedChat")
        self.assertEqual(info["model_id"], "composer-2.5-fast")

    def test_redacts_auth_headers(self):
        headers = agent_spy.redact_headers(
            [
                ("Authorization", "AWS4-HMAC-SHA256 Credential=AKIA/..., Signature=abc"),
                ("X-Amz-Security-Token", "secret"),
                ("Content-Type", "application/json"),
            ]
        )
        self.assertEqual(headers[0][1], "[redacted]")
        self.assertEqual(headers[1][1], "[redacted]")
        self.assertEqual(headers[2][1], "application/json")


class AgentSpySpoolShimTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_spy_env = agent_spy.SPY_ENV
        self.old_spool_dir = agent_spy.DEFAULT_SPY_SPOOL_DIR
        self.old_max = agent_spy.DEFAULT_SPOOL_MAX_BYTES
        self.old_drop_interval = agent_spy.DROPPED_MARKER_INTERVAL_SECONDS
        self.spy_env = os.path.join(self.tmp.name, "spy.env")
        self.spool_dir = os.path.join(self.tmp.name, "spool")
        agent_spy.SPY_ENV = self.spy_env
        agent_spy.DEFAULT_SPY_SPOOL_DIR = self.spool_dir
        agent_spy.DEFAULT_SPOOL_MAX_BYTES = 1_073_741_824
        agent_spy.DROPPED_MARKER_INTERVAL_SECONDS = 0
        agent_spy._DROPPED_SINCE_MARKER = 0
        agent_spy._LAST_DROPPED_MARKER_AT = 0.0

    def tearDown(self):
        agent_spy.SPY_ENV = self.old_spy_env
        agent_spy.DEFAULT_SPY_SPOOL_DIR = self.old_spool_dir
        agent_spy.DEFAULT_SPOOL_MAX_BYTES = self.old_max
        agent_spy.DROPPED_MARKER_INTERVAL_SECONDS = self.old_drop_interval
        agent_spy._DROPPED_SINCE_MARKER = 0
        agent_spy._LAST_DROPPED_MARKER_AT = 0.0
        self.tmp.cleanup()

    def write_config(self, enabled=True, max_bytes=None):
        lines = [f"ROOTCELL_SPY_ENABLED={'true' if enabled else 'false'}"]
        if max_bytes is not None:
            lines.append(f"ROOTCELL_SPY_SPOOL_MAX_BYTES={max_bytes}")
        with open(self.spy_env, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")

    def read_events(self):
        if not os.path.exists(self.spool_dir):
            return []
        events = []
        for name in sorted(os.listdir(self.spool_dir)):
            if not name.endswith(".json"):
                continue
            with open(os.path.join(self.spool_dir, name), "r", encoding="utf-8") as f:
                events.append(json.load(f))
        return events

    def test_disabled_by_default_writes_nothing(self):
        agent_spy.capture_request(make_flow())
        self.assertFalse(os.path.exists(self.spool_dir))

    def test_enabled_config_is_parsed(self):
        self.write_config(enabled=True, max_bytes=12345)
        config = agent_spy._capture_config()
        self.assertIsNotNone(config)
        self.assertEqual(config["spool_dir"], self.spool_dir)
        self.assertEqual(config["spool_max_bytes"], 12345)

    def test_request_spool_event_shape_and_redaction(self):
        self.write_config(enabled=True)
        flow = make_flow(
            path="/model/anthropic.claude/converse?X-Amz-Signature=secret&ok=1",
            request_headers=[
                ("Content-Type", "application/json"),
                ("Authorization", "Bearer secret-token"),
                ("X-Amz-Security-Token", "session-secret"),
            ],
            request_body=b'{"messages":[{"role":"user","content":[{"text":"hello"}]}]}',
        )

        agent_spy.capture_request(flow)

        events = self.read_events()
        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertEqual(event["version"], 1)
        self.assertEqual(event["direction"], "request")
        self.assertEqual(event["flow_id"], "flow-1")
        self.assertEqual(event["provider"], "bedrock")
        self.assertEqual(event["operation"], "converse")
        self.assertEqual(event["model_id"], "anthropic.claude")
        self.assertIn("ok=1", event["path"])
        self.assertNotIn("secret", event["path"])
        self.assertEqual(
            [pair for pair in event["headers"] if pair[0].lower() == "authorization"],
            [["Authorization", "[redacted]"]],
        )
        self.assertEqual(json.loads(event["body_text"])["messages"][0]["role"], "user")
        self.assertEqual(flow.metadata["agent_spy"]["operation"], "converse")

    def test_non_bedrock_request_writes_nothing(self):
        self.write_config(enabled=True)
        agent_spy.capture_request(make_flow(host="api.anthropic.com"))
        self.assertEqual(self.read_events(), [])

    def test_cursor_request_spool_event_shape_and_redaction(self):
        self.write_config(enabled=True)
        flow = make_flow(
            host="api2.cursor.sh",
            path="/aiserver.v1.AiService/StreamUnifiedChat?signature=secret&ok=1",
            request_headers=[
                ("Content-Type", "application/json"),
                ("Authorization", "Bearer cursor-secret"),
                ("X-Cursor-Client-Version", "fixture"),
            ],
            request_body=b'{"model":"Composer 2.5","prompt":"RCSPY-CURSOR-ALPHA"}',
        )

        agent_spy.capture_request(flow)

        events = self.read_events()
        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertEqual(event["provider"], "cursor")
        self.assertEqual(event["operation"], "StreamUnifiedChat")
        self.assertEqual(event["model_id"], "Composer 2.5")
        self.assertIn("ok=1", event["path"])
        self.assertNotIn("secret", event["path"])
        self.assertEqual(
            [pair for pair in event["headers"] if pair[0].lower() == "authorization"],
            [["Authorization", "[redacted]"]],
        )
        self.assertNotIn("body_text", event)
        self.assertEqual(
            json.loads(base64.b64decode(event["body_b64"]).decode("utf-8"))["prompt"],
            "RCSPY-CURSOR-ALPHA",
        )
        self.assertEqual(event["body_sha256"], agent_spy._sha256_bytes(flow.request.raw_content))
        self.assertEqual(flow.metadata["agent_spy"]["provider"], "cursor")

    def test_cursor_get_request_spools_empty_raw_body(self):
        self.write_config(enabled=True)
        flow = make_flow(
            host="api2.cursor.sh",
            method="GET",
            path="/aiserver.v1.ServerConfigService/GetUsableModels",
            request_body=b"",
        )

        agent_spy.capture_request(flow)

        events = self.read_events()
        self.assertEqual(len(events), 1)
        event = events[0]
        self.assertEqual(event["provider"], "cursor")
        self.assertEqual(event["operation"], "GetUsableModels")
        self.assertEqual(event["body_b64"], "")
        self.assertEqual(event["body_sha256"], agent_spy._sha256_bytes(b""))

    def test_cursor_response_streaming_is_enabled_for_matched_flows(self):
        flow = make_flow(
            host="agentn.global.api5.cursor.sh",
            path="/agent.v1.AgentService/Run",
            request_headers=[("Content-Type", "application/connect+proto")],
            request_body=b"\x00composer-2.5-fast\x00RCSPY-CURSOR-ALPHA",
            response_headers=[("Content-Type", "application/connect+proto")],
        )

        agent_spy.prepare_response_stream(flow)

        self.assertTrue(callable(flow.response.stream))

    def test_cursor_non_stream_operation_does_not_force_response_streaming(self):
        flow = make_flow(
            host="api2.cursor.sh",
            path="/aiserver.v1.ServerConfigService/GetUsableModels",
            request_headers=[("Content-Type", "application/connect+proto")],
            request_body=b"",
            response_headers=[("Content-Type", "application/json")],
        )

        agent_spy.prepare_response_stream(flow)

        self.assertFalse(hasattr(flow.response, "stream"))

    def test_cursor_response_stream_callback_spools_chunks_unchanged(self):
        self.write_config(enabled=True)
        flow = make_flow(
            host="agentn.global.api5.cursor.sh",
            path="/agent.v1.AgentService/RunSSE",
            request_headers=[("Content-Type", "application/connect+proto")],
            request_body=b"\x00composer-2.5-fast\x00RCSPY-CURSOR-ALPHA",
            response_headers=[("Content-Type", "application/connect+proto")],
        )

        agent_spy.capture_request(flow)
        agent_spy.prepare_response_stream(flow)
        returned = flow.response.stream(b"\x00\x00\x00\x00\x05hello")

        self.assertEqual(returned, b"\x00\x00\x00\x00\x05hello")
        events = self.read_events()
        chunk = [event for event in events if event["direction"] == "stream-chunk"][0]
        self.assertEqual(chunk["provider"], "cursor")
        self.assertEqual(chunk["operation"], "RunSSE")
        self.assertEqual(chunk["chunk_index"], 0)
        self.assertEqual(base64.b64decode(chunk["body_b64"]), b"\x00\x00\x00\x00\x05hello")
        self.assertEqual(chunk["body_sha256"], agent_spy._sha256_bytes(b"\x00\x00\x00\x00\x05hello"))

    def test_response_eventstream_is_spooled_as_b64(self):
        self.write_config(enabled=True)
        stream = eventstream_message(
            {":message-type": "event", ":event-type": "chunk", ":content-type": "application/json"},
            b'{"metadata":{"usage":{"inputTokens":4}}}',
        )
        flow = make_flow(
            response_headers=[("Content-Type", "application/vnd.amazon.eventstream")],
            response_body=stream,
        )

        agent_spy.capture_response(flow)

        event = self.read_events()[0]
        self.assertEqual(event["direction"], "response")
        self.assertEqual(event["status_code"], 200)
        self.assertEqual(event["request_headers"][0][0], "Content-Type")
        self.assertEqual(event["body_encoding"], "aws-eventstream")
        self.assertEqual(base64.b64decode(event["body_b64"]), stream)
        self.assertEqual(event["body_sha256"], agent_spy._sha256_bytes(stream))

    def test_mitmproxy_error_event_is_provider_gated(self):
        self.write_config(enabled=True)
        flow = make_flow()
        flow.error = types.SimpleNamespace(msg="upstream failed")

        agent_spy.capture_error(flow)

        events = self.read_events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["direction"], "error")
        self.assertEqual(events[0]["provider"], "bedrock")
        self.assertEqual(events[0]["error"], "upstream failed")

    def test_non_bedrock_error_writes_nothing(self):
        self.write_config(enabled=True)
        flow = make_flow(host="api.anthropic.com")
        flow.error = types.SimpleNamespace(msg="not a captured provider")

        agent_spy.capture_error(flow)

        self.assertEqual(self.read_events(), [])

    def test_spool_cap_can_suppress_all_writes(self):
        self.write_config(enabled=True, max_bytes=10)
        agent_spy.capture_request(make_flow(request_body=b'{"messages":[{"content":[{"text":"large"}]}]}'))
        self.assertEqual(self.read_events(), [])

    def test_spool_full_writes_rate_limited_dropped_marker_when_it_fits(self):
        self.write_config(enabled=True, max_bytes=1200)
        os.makedirs(self.spool_dir, exist_ok=True)
        with open(os.path.join(self.spool_dir, "existing.dat"), "wb") as f:
            f.write(b"x" * 1000)

        agent_spy.capture_request(make_flow(request_body=b'{"messages":[{"content":[{"text":"' + b"x" * 3000 + b'"}]}]}'))

        events = self.read_events()
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["direction"], "dropped")
        self.assertEqual(events[0]["provider"], "bedrock")
        self.assertEqual(events[0]["reason"], "spool_full")
        self.assertEqual(events[0]["dropped_count"], 1)

    def test_capture_errors_are_swallowed(self):
        self.write_config(enabled=True)

        class BadFlow:
            id = "bad-flow"

            @property
            def request(self):
                raise RuntimeError("broken request")

        agent_spy.capture_request(BadFlow())


if __name__ == "__main__":
    unittest.main()
