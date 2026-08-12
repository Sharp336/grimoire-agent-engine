"""Async Prime-side client for the local OMP bridge.

The client intentionally uses only Python's standard library. Network and file
operations run in worker threads so calls are safe from the persistent Prime
kernel event loop.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as _datetime
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping, Sequence

DEFAULT_CONFIG_PATH = Path("~/.prime/agent/omp-bridge.json")
DEFAULT_WAIT_TIMEOUT_MS = 30_000
ACTIVE_SESSION_ENV = "PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID"

JsonObject = dict[str, object]
Urlopen = Callable[..., object]

class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirectHandler())




class BridgeError(RuntimeError):
    """Base error raised by the OMP bridge client."""

    def __init__(self, message: str, *, status: int | None = None, body: bytes = b"") -> None:
        super().__init__(message)
        self.status = status
        self.body = body


class BridgeConfigError(BridgeError):
    """The bridge pointer or token configuration is missing or invalid."""


class BridgeProtocolError(BridgeError):
    """The bridge returned a response that is not valid JSON or has a wrong shape."""


class BridgeHTTPError(BridgeError):
    """The bridge returned an unsuccessful HTTP response."""


class BridgeUnauthorizedError(BridgeHTTPError):
    """The bridge rejected the bearer token with HTTP 401."""


class BridgeForbiddenError(BridgeHTTPError):
    """The bridge rejected the request with HTTP 403."""


# Short names are convenient for callers that do not need the Bridge prefix.
UnauthorizedError = BridgeUnauthorizedError
ForbiddenError = BridgeForbiddenError


@dataclass(frozen=True)
class BridgeConfig:
    """Resolved bridge URL and token-file paths."""

    url: str
    token_file: Path


def _utc_now() -> str:
    return _datetime.datetime.now(_datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _read_json_file(path: Path) -> object:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except OSError as error:
        raise BridgeConfigError(f"unable to read bridge config: {path}") from error
    except json.JSONDecodeError as error:
        raise BridgeConfigError(f"bridge config is not valid JSON: {path}") from error


def _string_field(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise BridgeConfigError(f"bridge config field {field!r} must be a non-empty string")
    return value.strip()


def _validate_bridge_url(value: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(value)
        hostname = parsed.hostname
        parsed.port
    except ValueError as error:
        raise BridgeConfigError("bridge URL is invalid") from error
    if (
        parsed.scheme != "http"
        or hostname is None
        or hostname.lower() not in {"127.0.0.1", "localhost"}
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise BridgeConfigError("bridge URL must be plain loopback HTTP")
    return value.rstrip("/")



def discover_config(
    *,
    config_path: str | os.PathLike[str] | None = None,
    environ: Mapping[str, str] | None = None,
) -> BridgeConfig:
    """Resolve the pointer file and environment overrides.

    ``OMP_PRIME_BRIDGE_URL`` and ``OMP_PRIME_BRIDGE_TOKEN_FILE`` override the
    corresponding pointer-file fields independently. The pointer file is the
    bridge-owned ``~/.prime/agent/omp-bridge.json`` by default and contains
    paths only. The bridge provisions it with mode 0600.
    """

    env = os.environ if environ is None else environ
    url_override = env.get("OMP_PRIME_BRIDGE_URL", "").strip()
    token_override = env.get("OMP_PRIME_BRIDGE_TOKEN_FILE", "").strip()
    pointer: object = {}
    if not url_override or not token_override:
        pointer = _read_json_file(Path(config_path or DEFAULT_CONFIG_PATH).expanduser())
    if not isinstance(pointer, dict):
        raise BridgeConfigError("bridge config must be a JSON object")
    url = url_override or _string_field(pointer.get("url"), "url")
    token_file_value = token_override or _string_field(pointer.get("tokenFile"), "tokenFile")
    return BridgeConfig(url=url, token_file=Path(token_file_value).expanduser())


class BridgeClient:
    """Typed asynchronous client for the authenticated OMP bridge HTTP API."""

    def __init__(
        self,
        active_session_id: str | None = None,
        *,
        config: BridgeConfig | None = None,
        config_path: str | os.PathLike[str] | None = None,
        url: str | None = None,
        token_file: str | os.PathLike[str] | None = None,
        project_root: str | os.PathLike[str] | None = None,
        timeout: float = 30.0,
        urlopen: Urlopen | None = None,
    ) -> None:
        self.active_session_id = active_session_id or ""
        if config is None:
            if url is not None and token_file is not None:
                config = BridgeConfig(url=url, token_file=Path(token_file).expanduser())
            else:
                discovered = discover_config(config_path=config_path, environ=os.environ)
                resolved_url = url or discovered.url
                resolved_token = Path(token_file).expanduser() if token_file is not None else discovered.token_file
                config = BridgeConfig(url=resolved_url, token_file=resolved_token)
        self.config = BridgeConfig(url=_validate_bridge_url(config.url), token_file=config.token_file)
        if not self.config.token_file:
            raise BridgeConfigError("bridge token file is empty")
        self.project_root = str(project_root) if project_root is not None else os.getcwd()
        self.timeout = timeout
        self._urlopen = urlopen

    def _token(self) -> str:
        try:
            with self.config.token_file.open("r", encoding="utf-8") as handle:
                token = handle.read().strip()
        except OSError as error:
            raise BridgeConfigError("unable to read bridge token file") from error
        if not token:
            raise BridgeConfigError("bridge token file is empty")
        return token

    def _request_sync(
        self,
        method: str,
        route: str,
        body: JsonObject | None = None,
        network_timeout: float | None = None,
    ) -> object:
        token = self._token()
        data = None if body is None else json.dumps(body).encode("utf-8")
        headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            f"{self.config.url}{route}",
            data=data,
            headers=headers,
            method=method,
        )
        opener = self._urlopen or _NO_REDIRECT_OPENER.open
        response: object
        try:
            response = opener(request, timeout=self.timeout if network_timeout is None else network_timeout)
            status = getattr(response, "status", None)
            if not isinstance(status, int):
                status = getattr(response, "getcode", lambda: 200)()
            raw = getattr(response, "read")()
        except urllib.error.HTTPError as error:
            status = error.code
            try:
                raw = error.read()
            finally:
                error.close()
            self._raise_http_error(status, raw)
            raise AssertionError("unreachable")
        except urllib.error.URLError as error:
            raise BridgeError(f"bridge request failed: {error.reason}") from error
        finally:
            close = locals().get("response")
            if close is not None:
                close_method = getattr(close, "close", None)
                if callable(close_method):
                    close_method()
        if not isinstance(status, int):
            status = 200
        if status < 200 or status >= 300:
            self._raise_http_error(status, raw)
        if isinstance(raw, str):
            text = raw
        elif isinstance(raw, (bytes, bytearray)):
            text = bytes(raw).decode("utf-8")
        else:
            raise BridgeProtocolError("bridge response body is not bytes")
        try:
            return json.loads(text)
        except json.JSONDecodeError as error:
            raise BridgeProtocolError("bridge response must be valid JSON") from error

    @staticmethod
    def _raise_http_error(status: int, body: bytes) -> None:
        if status == 401:
            raise BridgeUnauthorizedError("bridge request was unauthorized (401)", status=status, body=body)
        if status == 403:
            raise BridgeForbiddenError("bridge request was forbidden (403)", status=status, body=body)
        raise BridgeHTTPError(f"bridge request failed ({status})", status=status, body=body)

    async def _request(
        self,
        method: str,
        route: str,
        body: JsonObject | None = None,
        network_timeout: float | None = None,
    ) -> object:
        return await asyncio.to_thread(self._request_sync, method, route, body, network_timeout)

    async def list_peers(self) -> list[JsonObject]:
        value = await self._request("GET", "/v1/peers?targetHarness=omp")
        if not isinstance(value, list):
            raise BridgeProtocolError("bridge peers response must be a JSON array")
        peers: list[JsonObject] = []
        for peer in value:
            if not isinstance(peer, dict):
                raise BridgeProtocolError("bridge peers response entries must be objects")
            peers.append(peer)
        return peers

    async def send(self, target: str, message: str, reply_to: str | None = None) -> JsonObject:
        if not self.active_session_id:
            raise BridgeConfigError("active Prime session ID is required for send")
        payload: JsonObject = {
            "meshMessageId": str(uuid.uuid4()),
            "idempotencyKey": str(uuid.uuid4()),
            "originHarness": "prime",
            "originSessionId": self.active_session_id,
            "targetHarness": "omp",
            "targetId": target,
            "body": message,
            "projectRoot": self.project_root,
            "createdAt": _utc_now(),
        }
        if reply_to is not None:
            payload["replyTo"] = reply_to
        value = await self._request("POST", "/v1/messages", payload)
        if not isinstance(value, dict):
            raise BridgeProtocolError("bridge receipt response must be a JSON object")
        return value

    async def inbox(self, peek: bool = False) -> list[JsonObject]:
        if not self.active_session_id:
            raise BridgeConfigError("active Prime session ID is required for inbox")
        target = urllib.parse.quote(self.active_session_id, safe="")
        value = await self._request("GET", f"/v1/inbox?targetId={target}&peek={'true' if peek else 'false'}")
        if not isinstance(value, list):
            raise BridgeProtocolError("bridge inbox response must be a JSON array")
        messages: list[JsonObject] = []
        for message in value:
            if not isinstance(message, dict):
                raise BridgeProtocolError("bridge inbox response entries must be objects")
            messages.append(message)
        return messages

    async def wait(self, from_peer: str | None = None, timeout: int | None = None) -> JsonObject | None:
        if not self.active_session_id:
            raise BridgeConfigError("active Prime session ID is required for wait")
        timeout_ms = DEFAULT_WAIT_TIMEOUT_MS if timeout is None else timeout
        if not isinstance(timeout_ms, int) or timeout_ms < 0:
            raise ValueError("timeout must be a non-negative integer number of milliseconds")
        payload: JsonObject = {"targetId": self.active_session_id, "timeoutMs": timeout_ms}
        if from_peer is not None:
            payload["from"] = from_peer
        network_timeout = max(self.timeout, timeout_ms / 1000 + 1)
        value = await self._request("POST", "/v1/wait", payload, network_timeout)
        if value is None:
            return None
        if not isinstance(value, dict):
            raise BridgeProtocolError("bridge wait response must be an object or null")
        return value


def _session_id(value: str | None) -> str:
    return value or os.environ.get(ACTIVE_SESSION_ENV, "")


def _client(client: BridgeClient | None, active_session_id: str | None) -> BridgeClient:
    return client if client is not None else BridgeClient(_session_id(active_session_id))


async def list_peers(*, client: BridgeClient | None = None) -> list[JsonObject]:
    """List active OMP peers visible to the bridge."""

    return await _client(client, None).list_peers()


async def send(
    target: str,
    message: str,
    reply_to: str | None = None,
    *,
    active_session_id: str | None = None,
    client: BridgeClient | None = None,
) -> JsonObject:
    """Send a Prime-origin message to an OMP peer."""

    return await _client(client, active_session_id).send(target, message, reply_to)


async def inbox(
    peek: bool = False,
    *,
    active_session_id: str | None = None,
    client: BridgeClient | None = None,
) -> list[JsonObject]:
    """Read Prime-bound messages, consuming them unless ``peek`` is true."""

    return await _client(client, active_session_id).inbox(peek)


async def wait(
    from_peer: str | None = None,
    timeout: int | None = None,
    *,
    active_session_id: str | None = None,
    client: BridgeClient | None = None,
) -> JsonObject | None:
    """Wait for one Prime-bound message, using milliseconds for ``timeout``."""

    return await _client(client, active_session_id).wait(from_peer, timeout)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="omp_message")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("peers", aliases=["list-peers"])

    send_parser = commands.add_parser("send")
    send_parser.add_argument("target")
    send_parser.add_argument("message")
    send_parser.add_argument("--reply-to")
    send_parser.add_argument("--session-id")

    inbox_parser = commands.add_parser("inbox")
    inbox_parser.add_argument("--peek", action="store_true")

    wait_parser = commands.add_parser("wait")
    wait_parser.add_argument("--from-peer")
    wait_parser.add_argument("--timeout", type=int)
    return parser


async def _run_cli(args: argparse.Namespace) -> object:
    if args.command in {"peers", "list-peers"}:
        return await list_peers()
    if args.command == "send":
        client = BridgeClient(_session_id(args.session_id))
        return await client.send(args.target, args.message, args.reply_to)
    if args.command == "inbox":
        return await inbox(peek=args.peek)
    return await wait(from_peer=args.from_peer, timeout=args.timeout)


def main(argv: Sequence[str] | None = None) -> int:
    """Run the ``omp_message`` JSON CLI and return a process exit code."""

    args = _parser().parse_args(argv)
    try:
        value = asyncio.run(_run_cli(args))
    except BridgeError as error:
        print(str(error), file=sys.stderr)
        return 1
    sys.stdout.write(json.dumps(value, sort_keys=True))
    sys.stdout.write("\n")
    return 0


__all__ = [
    "ACTIVE_SESSION_ENV",
    "BridgeClient",
    "BridgeConfig",
    "BridgeConfigError",
    "BridgeError",
    "BridgeForbiddenError",
    "BridgeHTTPError",
    "BridgeProtocolError",
    "BridgeUnauthorizedError",
    "ForbiddenError",
    "UnauthorizedError",
    "discover_config",
    "inbox",
    "list_peers",
    "main",
    "send",
    "wait",
]
