#!/usr/bin/env python3
"""LLM provider traffic capture shim for the firewall VM.

This module is intentionally stdlib-only. mitmproxy imports the capture helpers
from its own Python environment, provider-gates LLM runtime traffic, and
writes bounded sanitized spool events for the TypeScript spy service.
"""

from __future__ import annotations

import base64
import fnmatch
import hashlib
import itertools
import json
import os
import re
import time
import urllib.parse
from typing import Any


SPY_ENV = os.environ.get("ROOTCELL_SPY_ENV", "/etc/agent-vm/spy.env")
DEFAULT_SPY_SPOOL_DIR = "/var/spool/rootcell-spy"
DEFAULT_SPOOL_MAX_BYTES = 1_073_741_824
DROPPED_MARKER_INTERVAL_SECONDS = 30.0

_SPOOL_COUNTER = itertools.count()
_DROPPED_SINCE_MARKER = 0
_LAST_DROPPED_MARKER_AT = 0.0

EVENTSTREAM_CONTENT_TYPE = "application/vnd.amazon.eventstream"

BEDROCK_OPERATIONS = {
    "invoke",
    "invoke-with-response-stream",
    "converse",
    "converse-stream",
}

CURSOR_API_HOSTS = {
    "api.cursor.com",
    "api.cursor.sh",
    "api2.cursor.sh",
    "agentn.global.api5.cursor.sh",
}

CURSOR_STREAM_OPERATION_RE = re.compile(
    r"^(?:Run|RunSSE|StreamUnifiedChat)$",
    re.IGNORECASE,
)

SECRET_HEADER_NAMES = {
    "authorization",
    "proxy-authorization",
    "x-amz-security-token",
    "x-amz-credential",
    "x-amz-signature",
    "x-api-key",
    "api-key",
    "cursor-api-key",
}

PRESIGNED_QUERY_KEYS = {
    "authorization",
    "x-amz-credential",
    "x-amz-signature",
    "x-amz-security-token",
    "awsaccesskeyid",
    "signature",
    "security-token",
}


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _content_type_base(value: str | None) -> str:
    if not value:
        return ""
    return value.split(";", 1)[0].strip().lower()


def _is_eventstream_content_type(value: str | None) -> bool:
    return _content_type_base(value) == EVENTSTREAM_CONTENT_TYPE


def _headers_to_pairs(headers: Any) -> list[tuple[str, str]]:
    """Return header pairs from mitmproxy, tests, or captured JSON."""

    if not headers:
        return []

    if isinstance(headers, dict):
        return [(str(k), str(v)) for k, v in headers.items()]

    if isinstance(headers, list):
        pairs: list[tuple[str, str]] = []
        for item in headers:
            if isinstance(item, (list, tuple)) and len(item) == 2:
                pairs.append((str(item[0]), str(item[1])))
        return pairs

    pairs = []
    try:
        keys = list(headers.keys())
    except Exception:
        try:
            return [(str(k), str(v)) for k, v in headers.items()]
        except Exception:
            return []

    for key in keys:
        try:
            values = headers.get_all(key)
        except Exception:
            try:
                values = [headers[key]]
            except Exception:
                values = []
        for value in values:
            pairs.append((str(key), str(value)))
    return pairs


def _header_value(headers: Any, name: str) -> str | None:
    lower_name = name.lower()
    for key, value in _headers_to_pairs(headers):
        if key.lower() == lower_name:
            return value
    return None


def _redact_header_value(name: str, value: str) -> str:
    lower_name = name.lower()
    if lower_name in SECRET_HEADER_NAMES:
        return "[redacted]"
    if lower_name == "cookie" or lower_name == "set-cookie":
        return "[redacted]"
    if "bearer " in value.lower():
        return re.sub(r"(?i)bearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [redacted]", value)
    if "signature=" in value.lower() or "credential=" in value.lower():
        return "[redacted]"
    return value


def redact_headers(headers: Any) -> list[list[str]]:
    return [[name, _redact_header_value(name, value)] for name, value in _headers_to_pairs(headers)]


def _redact_path(path: str) -> str:
    split = urllib.parse.urlsplit(path)
    if not split.query:
        return path
    pairs = urllib.parse.parse_qsl(split.query, keep_blank_values=True)
    redacted = []
    for key, value in pairs:
        if key.lower() in PRESIGNED_QUERY_KEYS:
            redacted.append((key, "[redacted]"))
        else:
            redacted.append((key, value))
    return urllib.parse.urlunsplit(
        ("", "", split.path, urllib.parse.urlencode(redacted), split.fragment)
    )


def is_bedrock_runtime_host(host: str | None) -> bool:
    if not host:
        return False
    host = host.split(":", 1)[0].strip(".").lower()
    patterns = (
        "bedrock-runtime.*.amazonaws.com",
        "bedrock-runtime-fips.*.amazonaws.com",
        "*.bedrock-runtime.*.amazonaws.com",
        "*.bedrock-runtime-fips.*.amazonaws.com",
        "bedrock-runtime.*.amazonaws.com.cn",
        "bedrock-runtime-fips.*.amazonaws.com.cn",
        "*.bedrock-runtime.*.amazonaws.com.cn",
        "*.bedrock-runtime-fips.*.amazonaws.com.cn",
    )
    return any(fnmatch.fnmatchcase(host, pattern) for pattern in patterns)


def detect_bedrock_request(host: str | None, path: str, headers: Any = None) -> dict[str, str] | None:
    """Detect Bedrock Runtime model operations from host + REST path."""

    if not is_bedrock_runtime_host(host):
        return None

    url_path = urllib.parse.urlsplit(path).path
    match = re.match(
        r"^/model/(?P<model_id>.+)/(?P<operation>invoke|invoke-with-response-stream|converse|converse-stream)$",
        url_path,
    )
    if not match:
        return None

    operation = match.group("operation")
    if operation not in BEDROCK_OPERATIONS:
        return None

    return {
        "provider": "bedrock",
        "model_id": urllib.parse.unquote(match.group("model_id")),
        "operation": operation,
        "streaming": "true" if operation.endswith("stream") else "false",
    }


def is_cursor_api_host(host: str | None) -> bool:
    if not host:
        return False
    normalized = host.split(":", 1)[0].strip(".").lower()
    return normalized in CURSOR_API_HOSTS or fnmatch.fnmatchcase(normalized, "*.cursor.sh")


def detect_cursor_request(
    host: str | None,
    path: str,
    method: str | None = None,
    body: bytes | None = None,
) -> dict[str, str] | None:
    """Detect all Cursor API calls so startup/tool capability traffic is visible."""

    if not is_cursor_api_host(host):
        return None

    url_path = urllib.parse.urlsplit(path).path
    operation = _cursor_operation_from_path(url_path)
    return {
        "provider": "cursor",
        "model_id": _cursor_model_id_from_body(body) or "cursor",
        "operation": operation,
        "streaming": "unknown",
    }


def detect_provider_request(
    host: str | None,
    path: str,
    headers: Any = None,
    method: str | None = None,
    body: bytes | None = None,
) -> dict[str, str] | None:
    return detect_bedrock_request(host, path, headers) or detect_cursor_request(host, path, method, body)


def _cursor_operation_from_path(path: str) -> str:
    parts = [urllib.parse.unquote(part) for part in path.split("/") if part]
    if not parts:
        return "agent"
    for part in reversed(parts):
        cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "-", part).strip("-")
        if cleaned:
            return cleaned[:80]
    return "agent"


def _cursor_model_id_from_body(body: bytes | None) -> str | None:
    if not body:
        return None
    text = _decode_utf8(body)
    if text is None:
        return _cursor_model_id_from_binary(body)
    try:
        value = json.loads(text)
    except Exception:
        return _cursor_model_id_from_text(text)
    return _first_deep_string(value, {
        "model",
        "model_id",
        "modelname",
        "modeldisplayname",
        "selectedmodel",
    }) or _cursor_model_id_from_text(text)


def _cursor_model_id_from_binary(body: bytes) -> str | None:
    try:
        text = body.decode("latin1", errors="ignore")
    except Exception:
        return None
    return _cursor_model_id_from_text(text)


def _cursor_model_id_from_text(text: str) -> str | None:
    match = re.search(r"\bcomposer-2\.5(?:-fast)?\b", text, re.IGNORECASE)
    if match:
        return match.group(0)
    match = re.search(r"Composer\s+2\.5(?:\s+Fast)?", text, re.IGNORECASE)
    if match:
        return match.group(0)
    match = re.search(r"(?:model|modelName|selectedModel)[\"'\s:=]+([A-Za-z0-9_. -]{2,80})", text)
    if match:
        return match.group(1).strip()
    return None


def _first_deep_string(value: Any, keys: set[str]) -> str | None:
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).lower() in keys and isinstance(child, str) and child:
                return child
        for child in value.values():
            found = _first_deep_string(child, keys)
            if found is not None:
                return found
    elif isinstance(value, list):
        for child in value:
            found = _first_deep_string(child, keys)
            if found is not None:
                return found
    return None


def _decode_utf8(data: bytes) -> str | None:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return None


def _event_base(flow: Any, direction: str, info: dict[str, str]) -> dict[str, Any]:
    request = flow.request
    return {
        "version": 1,
        "ts": time.time(),
        "direction": direction,
        "flow_id": str(getattr(flow, "id", "")),
        "provider": info["provider"],
        "operation": info["operation"],
        "model_id": info["model_id"],
        "host": str(getattr(request, "pretty_host", None) or getattr(request, "host", "")),
        "method": str(getattr(request, "method", "")),
        "path": _redact_path(str(getattr(request, "path", ""))),
    }


def _request_body_bytes(flow: Any) -> bytes:
    body = getattr(flow.request, "raw_content", None)
    if body is None:
        body = getattr(flow.request, "content", b"") or b""
    return body


def _response_body_bytes(flow: Any) -> bytes:
    response = getattr(flow, "response", None)
    if response is None:
        return b""
    body = getattr(response, "raw_content", None)
    if body is None:
        body = getattr(response, "content", b"") or b""
    return body


def _next_stream_chunk_index(flow: Any) -> int:
    metadata = getattr(flow, "metadata", None)
    if not isinstance(metadata, dict):
        return 0
    current = metadata.get("agent_spy_stream_chunk_index")
    try:
        index = int(current)
    except (TypeError, ValueError):
        index = 0
    metadata["agent_spy_stream_chunk_index"] = index + 1
    return index


def load_spy_config(path: str | None = None) -> dict[str, str]:
    config_path = path or SPY_ENV
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return {}

    config: dict[str, str] = {}
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        if key:
            config[key] = value
    return config


def _positive_int(value: str | None, default: int) -> int:
    if value is None:
        return default
    try:
        parsed = int(value, 10)
    except ValueError:
        return default
    return parsed if parsed > 0 else default


def _capture_config() -> dict[str, Any] | None:
    config = load_spy_config()
    if config.get("ROOTCELL_SPY_ENABLED", "").strip().lower() != "true":
        return None
    return {
        "spool_dir": DEFAULT_SPY_SPOOL_DIR,
        "spool_max_bytes": _positive_int(config.get("ROOTCELL_SPY_SPOOL_MAX_BYTES"), DEFAULT_SPOOL_MAX_BYTES),
    }


def _spool_size_bytes(path: str) -> int:
    total = 0
    try:
        with os.scandir(path) as entries:
            for entry in entries:
                try:
                    if entry.is_file(follow_symlinks=False):
                        total += entry.stat(follow_symlinks=False).st_size
                except OSError:
                    continue
    except OSError:
        return 0
    return total


def _filename_part(value: Any) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(value))[:80].strip("._-")
    return cleaned or "none"


def _spool_file_name(event: dict[str, Any]) -> str:
    return "-".join(
        [
            str(time.time_ns()),
            str(os.getpid()),
            _filename_part(event.get("flow_id", "no-flow")),
            _filename_part(event.get("direction", "event")),
            str(next(_SPOOL_COUNTER)),
        ],
    ) + ".json"


def _write_all(fd: int, payload: bytes) -> None:
    view = memoryview(payload)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError("short spool write")
        view = view[written:]


def _atomic_write_spool_file(spool_dir: str, name: str, payload: bytes) -> bool:
    tmp_name = f".{name}.tmp"
    tmp_path = os.path.join(spool_dir, tmp_name)
    final_path = os.path.join(spool_dir, name)
    fd: int | None = None
    try:
        fd = os.open(tmp_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o640)
        try:
            _write_all(fd, payload)
        finally:
            os.close(fd)
            fd = None
        os.replace(tmp_path, final_path)
        try:
            os.chmod(final_path, 0o640)
        except OSError:
            pass
        return True
    except OSError:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        return False


def _write_dropped_marker(config: dict[str, Any], provider: str | None, reason: str) -> None:
    global _DROPPED_SINCE_MARKER, _LAST_DROPPED_MARKER_AT
    _DROPPED_SINCE_MARKER += 1
    now = time.time()
    if _LAST_DROPPED_MARKER_AT != 0 and now - _LAST_DROPPED_MARKER_AT < DROPPED_MARKER_INTERVAL_SECONDS:
        return

    event: dict[str, Any] = {
        "version": 1,
        "ts": now,
        "direction": "dropped",
        "reason": reason,
        "dropped_count": _DROPPED_SINCE_MARKER,
    }
    if provider is not None:
        event["provider"] = provider
    if _write_spool_event(event, config, write_drop_marker=False):
        _DROPPED_SINCE_MARKER = 0
        _LAST_DROPPED_MARKER_AT = now


def _write_spool_event(event: dict[str, Any], config: dict[str, Any], write_drop_marker: bool = True) -> bool:
    payload = json.dumps(event, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    spool_dir = str(config["spool_dir"])
    max_bytes = int(config["spool_max_bytes"])
    try:
        os.makedirs(spool_dir, mode=0o770, exist_ok=True)
    except OSError:
        return False

    if _spool_size_bytes(spool_dir) + len(payload) > max_bytes:
        if write_drop_marker:
            provider = event.get("provider")
            _write_dropped_marker(config, str(provider) if provider is not None else None, "spool_full")
        return False

    return _atomic_write_spool_file(spool_dir, _spool_file_name(event), payload)


def _provider_info_for_flow(flow: Any) -> dict[str, str] | None:
    metadata = getattr(flow, "metadata", None)
    info = metadata.get("agent_spy") if isinstance(metadata, dict) else None
    if isinstance(info, dict) and info.get("provider") in {"bedrock", "cursor"}:
        return {str(key): str(value) for key, value in info.items()}

    request = getattr(flow, "request", None)
    if request is None:
        return None
    return detect_provider_request(
        getattr(request, "pretty_host", None) or getattr(request, "host", None),
        str(getattr(request, "path", "")),
        getattr(request, "headers", None),
        getattr(request, "method", None),
        _request_body_bytes(flow),
    )


def _flow_id(flow: Any) -> str | None:
    value = getattr(flow, "id", None)
    return str(value) if value is not None else None


def _attach_body(
    event: dict[str, Any],
    body: bytes,
    *,
    force_encoding: str | None = None,
    force_base64: bool = False,
) -> None:
    if force_encoding == "aws-eventstream":
        event["body_b64"] = base64.b64encode(body).decode("ascii")
        event["body_sha256"] = _sha256_bytes(body)
        event["body_encoding"] = "aws-eventstream"
        return

    if force_base64:
        event["body_b64"] = base64.b64encode(body).decode("ascii")
        event["body_sha256"] = _sha256_bytes(body)
        return

    text = _decode_utf8(body)
    if text is None:
        event["body_b64"] = base64.b64encode(body).decode("ascii")
        event["body_sha256"] = _sha256_bytes(body)
    else:
        event["body_text"] = text


def _write_shim_error(flow: Any, message: str) -> None:
    try:
        config = _capture_config()
        if config is None:
            return
        event: dict[str, Any] = {
            "version": 1,
            "ts": time.time(),
            "direction": "error",
            "error": message,
        }
        flow_id = _flow_id(flow)
        if flow_id is not None:
            event["flow_id"] = flow_id
        info = _provider_info_for_flow(flow)
        if info is None:
            return
        event["provider"] = info["provider"]
        _write_spool_event(event, config)
    except Exception:
        # The spy tap must never interfere with user traffic.
        return


def capture_request(flow: Any) -> None:
    """mitmproxy hook helper. Capture a validated provider request if enabled."""

    try:
        config = _capture_config()
        if config is None:
            return
        request = flow.request
        body = _request_body_bytes(flow)
        info = detect_provider_request(
            getattr(request, "pretty_host", None) or getattr(request, "host", None),
            str(getattr(request, "path", "")),
            getattr(request, "headers", None),
            getattr(request, "method", None),
            body,
        )
        if not info:
            return

        metadata = getattr(flow, "metadata", None)
        if isinstance(metadata, dict):
            metadata["agent_spy"] = info

        event = _event_base(flow, "request", info)
        event["headers"] = redact_headers(getattr(request, "headers", None))
        _attach_body(event, body, force_base64=info["provider"] == "cursor")
        _write_spool_event(event, config)
    except Exception as exc:  # pragma: no cover - defensive for live traffic.
        _write_shim_error(flow, str(exc))


def capture_response(flow: Any) -> None:
    """mitmproxy hook helper. Capture a provider response if its request matched."""

    try:
        config = _capture_config()
        if config is None:
            return
        info = _provider_info_for_flow(flow)
        if not info or getattr(flow, "response", None) is None:
            return

        response = flow.response
        event = _event_base(flow, "response", info)
        event["status_code"] = int(getattr(response, "status_code", 0) or 0)
        event["reason"] = str(getattr(response, "reason", "") or "")
        event["headers"] = redact_headers(getattr(response, "headers", None))
        event["request_headers"] = redact_headers(getattr(flow.request, "headers", None))

        body = _response_body_bytes(flow)
        content_type = _header_value(getattr(response, "headers", None), "content-type")
        if info["provider"] == "bedrock" and _is_eventstream_content_type(content_type):
            _attach_body(event, body, force_encoding="aws-eventstream")
        else:
            _attach_body(event, body, force_base64=info["provider"] == "cursor")
        _write_spool_event(event, config)
    except Exception as exc:  # pragma: no cover - defensive for live traffic.
        _write_shim_error(flow, str(exc))


def capture_stream_chunk(flow: Any, chunk: bytes) -> None:
    """Capture one provider response body chunk while returning traffic unchanged."""

    if not chunk:
        return
    try:
        config = _capture_config()
        if config is None:
            return
        info = _provider_info_for_flow(flow)
        if info is None:
            return
        response = getattr(flow, "response", None)
        if response is None:
            return
        event = _event_base(flow, "stream-chunk", info)
        event["headers"] = redact_headers(getattr(response, "headers", None))
        event["chunk_index"] = _next_stream_chunk_index(flow)
        event["body_b64"] = base64.b64encode(chunk).decode("ascii")
        event["body_sha256"] = _sha256_bytes(chunk)
        _write_spool_event(event, config)
    except Exception as exc:  # pragma: no cover - defensive for live traffic.
        _write_shim_error(flow, str(exc))


def prepare_response_stream(flow: Any) -> None:
    """Enable pass-through streaming for provider responses that are long-lived."""

    try:
        info = _provider_info_for_flow(flow)
        response = getattr(flow, "response", None)
        if info is None or response is None:
            return
        if info.get("provider") != "cursor":
            return
        content_type = _header_value(getattr(response, "headers", None), "content-type")
        if (
            CURSOR_STREAM_OPERATION_RE.match(info.get("operation", "")) is None
            and _content_type_base(content_type) != "text/event-stream"
        ):
            return
        def tee_cursor_chunk(chunk: bytes) -> bytes:
            capture_stream_chunk(flow, chunk)
            return chunk

        setattr(response, "stream", tee_cursor_chunk)
    except Exception:
        return


def capture_error(flow: Any) -> None:
    """mitmproxy hook helper. Capture provider flow errors if spy is enabled."""

    try:
        config = _capture_config()
        if config is None:
            return
        info = _provider_info_for_flow(flow)
        if info is None:
            return
        flow_error = getattr(flow, "error", None)
        message = getattr(flow_error, "msg", None) or str(flow_error or "mitmproxy flow error")
        event: dict[str, Any] = {
            "version": 1,
            "ts": time.time(),
            "direction": "error",
            "provider": info["provider"],
            "error": str(message),
        }
        flow_id = _flow_id(flow)
        if flow_id is not None:
            event["flow_id"] = flow_id
        _write_spool_event(event, config)
    except Exception:
        return
