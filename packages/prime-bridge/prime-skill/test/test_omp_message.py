import asyncio
import io
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

import omp_message


class _Response:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status = status

    def read(self):
        return json.dumps(self._payload).encode("utf-8")

    def getcode(self):
        return self.status

    def close(self):
        pass


class BridgeSkillTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.config_path = self.root / ".prime" / "agent" / "omp-bridge.json"
        self.token_path = self.root / "bridge-token"
        self.config_path.parent.mkdir(parents=True)
        self.token_path.write_text("secret-token\n", encoding="utf-8")
        self.config_path.write_text(
            json.dumps({"url": "http://127.0.0.1:3210/", "tokenFile": str(self.token_path)}),
            encoding="utf-8",
        )
        os.chmod(self.config_path, stat.S_IRUSR | stat.S_IWUSR)
        self.calls = []

    def tearDown(self):
        self.temp_dir.cleanup()

    def _urlopen(self, request, timeout=None):
        self.calls.append((request, timeout))
        return _Response([])

    def _client(self, **kwargs):
        return omp_message.BridgeClient(
            "prime-session-1",
            config_path=self.config_path,
            **kwargs,
        )

    def test_default_discovery_reads_secure_pointer_and_bearer_token(self):
        with patch.dict(os.environ, {"HOME": self.root.as_posix()}, clear=True):
            client = omp_message.BridgeClient("prime-session-1", urlopen=self._urlopen)
        result = asyncio.run(client.list_peers())
        self.assertEqual(result, [])
        request, timeout = self.calls[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:3210/v1/peers?targetHarness=omp")
        self.assertIsNotNone(timeout)

    def test_environment_overrides_pointer_fields(self):
        with patch.dict(
            os.environ,
            {
                "OMP_PRIME_BRIDGE_URL": "http://127.0.0.1:3211",
                "OMP_PRIME_BRIDGE_TOKEN_FILE": str(self.token_path),
            },
            clear=True,
        ):
            client = omp_message.BridgeClient("prime-session-1", config_path=self.root / "missing.json", urlopen=self._urlopen)
        asyncio.run(client.list_peers())
        self.assertEqual(self.calls[0][0].full_url, "http://127.0.0.1:3211/v1/peers?targetHarness=omp")
    def test_explicit_url_and_token_file_do_not_read_pointer(self):
        with patch.object(omp_message, "_read_json_file", side_effect=AssertionError("pointer read")):
            client = omp_message.BridgeClient(
                "prime-session-1",
                url="http://localhost:3210",
                token_file=self.token_path,
                config_path=self.root / "missing.json",
            )
        self.assertEqual(client.config.url, "http://localhost:3210")

    def test_rejects_non_loopback_url_before_reading_token(self):
        with patch.object(omp_message, "_read_json_file", return_value={"url": "http://example.com", "tokenFile": str(self.token_path)}):
            with self.assertRaises(omp_message.BridgeConfigError):
                omp_message.BridgeClient("prime-session-1")
        with patch.object(Path, "open", side_effect=AssertionError("token read")):
            with self.assertRaises(omp_message.BridgeConfigError):
                omp_message.BridgeClient(
                    "prime-session-1",
                    url="http://127.0.0.1:3210/evil?token=secret",
                    token_file=self.token_path,
                )

    def test_send_builds_prime_to_omp_envelope_and_preserves_receipt(self):
        receipt = {"meshMessageId": "message-id", "status": "injected", "extra": None}

        def urlopen(request, timeout=None):
            self.calls.append((request, timeout))
            return _Response(receipt)

        client = self._client(project_root="/work/project", urlopen=urlopen)
        with patch.object(
            omp_message.uuid, "uuid4", side_effect=["mesh-id", "idem-id"]
        ), patch.object(omp_message, "_utc_now", return_value="2026-08-11T00:00:00.000Z"):
            result = asyncio.run(client.send("omp-session", "hello", reply_to="prior"))
        self.assertEqual(result, receipt)
        request = self.calls[0][0]
        self.assertEqual(request.full_url, "http://127.0.0.1:3210/v1/messages")
        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(
            payload,
            {
                "meshMessageId": "mesh-id",
                "idempotencyKey": "idem-id",
                "originHarness": "prime",
                "originSessionId": "prime-session-1",
                "targetHarness": "omp",
                "targetId": "omp-session",
                "body": "hello",
                "replyTo": "prior",
                "projectRoot": "/work/project",
                "createdAt": "2026-08-11T00:00:00.000Z",
            },
        )

    def test_routes_null_message_and_wait_network_timeout_are_preserved(self):
        responses = iter([
            [{"id": "peer"}],
            [{"body": "inbox"}],
            None,
        ])

        def urlopen(request, timeout=None):
            self.calls.append((request, timeout))
            return _Response(next(responses))

        client = self._client(timeout=0.5, urlopen=urlopen)
        peers = asyncio.run(client.list_peers())
        inbox = asyncio.run(client.inbox(peek=True))
        waited = asyncio.run(client.wait(from_peer="prime-session-2", timeout=1234))
        self.assertEqual(peers, [{"id": "peer"}])
        self.assertEqual(inbox, [{"body": "inbox"}])
        self.assertIsNone(waited)
        self.assertEqual(
            self.calls[1][0].full_url,
            "http://127.0.0.1:3210/v1/inbox?targetId=prime-session-1&peek=true",
        )
        self.assertEqual(
            json.loads(self.calls[2][0].data.decode("utf-8")),
            {"targetId": "prime-session-1", "from": "prime-session-2", "timeoutMs": 1234},
        )
    def test_401_and_403_have_explicit_errors(self):
        for status, error_type in (
            (401, omp_message.BridgeUnauthorizedError),
            (403, omp_message.BridgeForbiddenError),
        ):
            with self.subTest(status=status):
                error = urllib.error.HTTPError(
                    "http://bridge", status, "denied", {}, io.BytesIO(b'{"error":"denied"}')
                )
                client = self._client(urlopen=unittest.mock.Mock(side_effect=error))
                with self.assertRaises(error_type) as raised:
                    asyncio.run(client.list_peers())
                self.assertEqual(raised.exception.status, status)

    def test_cli_parses_send_and_prints_json(self):
        receipt = {"status": "injected", "meshMessageId": "m"}
        client = self._client()
        with patch.object(omp_message, "BridgeClient", return_value=client), patch.object(
            client, "send", new=unittest.mock.AsyncMock(return_value=receipt)
        ), patch("sys.stdout") as stdout:
            exit_code = omp_message.main(
                ["send", "omp-session", "hello", "--session-id", "prime-session-1"]
            )
        self.assertEqual(exit_code, 0)
        stdout.write.assert_any_call(json.dumps(receipt, sort_keys=True))
        stdout.write.assert_any_call("\n")

    def test_package_module_runs_cli(self):
        result = subprocess.run(
            [sys.executable, "-m", "omp_message", "--help"],
            capture_output=True,
            check=False,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("usage: omp_message", result.stdout)


if __name__ == "__main__":
    unittest.main()
