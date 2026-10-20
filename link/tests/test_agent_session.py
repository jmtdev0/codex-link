"""Hermetic checkpoint tests: synthetic identities, loopback HTTP only."""
import base64
import contextlib
import datetime as dt
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "agent-session.py"
spec = importlib.util.spec_from_file_location("link_agent_session", SCRIPT)
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)
ROOM = "R" * 22
INVITATION = "link2." + ROOM + "." + "I" * 43


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, status, value):
        raw = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self.process()

    def do_POST(self):
        self.process()

    def process(self):
        server = self.server
        server.requests += 1
        token = self.headers.get("Authorization", "").removeprefix("Bearer ")
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        if server.redirect:
            self.send_response(302)
            self.send_header("Location", server.origin + "/unexpected-target")
            self.end_headers()
            return
        if self.path == "/link/v1/join":
            if token not in server.identities:
                server.join_count += 1
                participant = base64.urlsafe_b64encode(hashlib.sha256(token.encode()).digest()).decode()[:22]
                server.identities[token] = {"roomId": ROOM, "participantId": participant, "apiBase": server.origin + "/link/v1", "expiresAt": (dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=24)).isoformat(), "cursor": 0, "participantCount": 1}
                checkpoint = client.PrivateCheckpoint(server.checkpoint_path, True).load()
                server.saved_before_join = checkpoint["credential"] == token
            if server.drop_join_once:
                server.drop_join_once = False
                self.close_connection = True
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            self.respond(201, server.identities[token])
            return
        if token not in server.identities or server.revoked:
            self.respond(401, {"error": {"code": "SESSION_REQUIRED", "message": "Synthetic denial"}})
            return
        if self.path == "/link/v1/session":
            self.respond(200, server.identities[token])
        elif self.path == "/link/v1/send":
            key = (token, body["requestId"])
            if key not in server.sent:
                server.sent[key] = {"accepted": True, "messageId": str(len(server.sent) + 1).zfill(22), "sequence": len(server.sent) + 1}
            self.respond(202, server.sent[key])
        elif self.path == "/link/v1/receive":
            server.receive_started.set()
            if server.hold_receive:
                server.receive_release.wait(6)
            self.respond(200, {"messages": [{"messageId": "M" * 22, "text": "Synthetic message, not a checkpoint", "sequence": 1}], "nextCursor": 1, "more": False})
        elif self.path == "/link/v1/confirm":
            self.respond(200, {"confirmed": True})
        elif self.path.startswith("/link/v1/outbox/"):
            key = (token, self.path.rsplit("/", 1)[1])
            self.respond(200 if key in server.sent else 404, server.sent.get(key, {}))
        else:
            self.respond(404, {"error": {"code": "NOT_FOUND"}})


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="link-checkpoint-test-")
        self.root = Path(self.temp.name)
        self.state = self.root / "private" / "session.json"
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.server.origin = "http://127.0.0.1:" + str(self.server.server_port)
        self.server.checkpoint_path = self.state
        self.server.identities, self.server.sent = {}, {}
        self.server.join_count = self.server.requests = 0
        self.server.saved_before_join = self.server.drop_join_once = self.server.revoked = self.server.redirect = self.server.hold_receive = False
        self.server.receive_started = threading.Event()
        self.server.receive_release = threading.Event()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.receive_release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(3)
        self.temp.cleanup()

    def operation(self, action="join", **extra):
        return {"action": action, **({"invitation": INVITATION, "name": "Synthetic peer", "consentToPlaintextGateway": True} if action == "join" else {}), **extra}

    def execute(self, operation=None, **extra):
        return client.execute(operation or self.operation(), origin=self.server.origin, filename=str(self.state), approved=True, development=True, **extra)

    def command(self):
        return [sys.executable, "-B", str(SCRIPT), "--origin", self.server.origin, "--state-file", str(self.state), "--allow-private-session-file", "--development-loopback"]

    def process(self, operation):
        result = subprocess.run(self.command(), input=json.dumps(operation).encode(), capture_output=True, timeout=12)
        self.assertEqual(result.stderr, b"")
        return result, json.loads(result.stdout)

    def test_consent_is_required_before_files_or_network(self):
        with self.assertRaises(client.LinkFault) as error:
            client.execute(self.operation(), origin=self.server.origin, filename=str(self.state), approved=False, development=True)
        self.assertEqual(error.exception.code, "STORAGE_CONSENT_REQUIRED")
        self.assertFalse(self.state.parent.exists())
        self.assertEqual(self.server.requests, 0)

    def test_checkpoint_precedes_join_and_two_new_processes_resume_same_identity(self):
        result, joined = self.process(self.operation())
        self.assertEqual(result.returncode, 0)
        self.assertTrue(self.server.saved_before_join)
        result, resumed = self.process(self.operation("resume"))
        self.assertEqual(result.returncode, 0)
        self.assertEqual(joined["session"]["participantId"], resumed["session"]["participantId"])
        self.assertEqual(self.server.join_count, 1)
        result, again = self.process(self.operation())
        self.assertEqual(result.returncode, 0)
        self.assertTrue(again["resumed"])
        self.assertEqual(self.server.join_count, 1)

    def test_lost_setup_response_recovers_without_second_join(self):
        self.server.drop_join_once = True
        with self.assertRaises(client.LinkFault) as error:
            self.execute()
        self.assertEqual(error.exception.code, "NETWORK_UNCONFIRMED")
        self.assertTrue(self.state.exists())
        _, result = self.process(self.operation("resume"))
        self.assertTrue(result["ok"])
        self.assertEqual(self.server.join_count, 1)

    def test_checkpoint_failure_prevents_any_authenticated_request(self):
        with mock.patch.object(client.PrivateCheckpoint, "save", side_effect=OSError("synthetic save failure")):
            with self.assertRaises(OSError):
                self.execute()
        self.assertEqual(self.server.requests, 0)
        self.assertFalse(self.state.exists())

    def test_uncommitted_setup_retry_reuses_checkpoint_and_rejects_changed_fields(self):
        with mock.patch.object(client.LinkHTTP, "call", side_effect=client.LinkFault("NETWORK_UNCONFIRMED", "Synthetic pre-dispatch failure")):
            with self.assertRaises(client.LinkFault):
                self.execute()
        first = client.PrivateCheckpoint(str(self.state), True).load()["credential"]
        with self.assertRaises(client.LinkFault):
            self.execute(self.operation(name="Changed pending name"))
        self.assertEqual(self.server.join_count, 0)
        result = self.execute()
        self.assertFalse(result["resumed"])
        self.assertEqual(client.PrivateCheckpoint(str(self.state), True).load()["credential"], first)
        self.assertEqual(self.server.join_count, 1)

    def test_saved_file_has_no_invitation_or_message_and_windows_credential_is_encrypted(self):
        self.execute()
        self.execute(self.operation("send", text="Synthetic private draft", requestId="checkpoint-no-message"))
        raw = self.state.read_bytes()
        self.assertNotIn(INVITATION.encode(), raw)
        self.assertNotIn(b"Synthetic private draft", raw)
        with client.PrivateCheckpoint(str(self.state), True).locked() as checkpoint:
            saved = checkpoint.load()
        if os.name == "nt":
            self.assertNotIn(saved["credential"].encode(), raw)
            self.assertEqual(json.loads(raw)["protection"], "windows-dpapi")
        else:
            self.assertEqual(self.state.stat().st_mode & 0o777, 0o600)
            self.assertEqual(self.state.parent.stat().st_mode & 0o777, 0o700)

    def test_missing_corrupt_and_revoked_sessions_never_create_an_identity(self):
        _, result = self.process(self.operation("resume"))
        self.assertEqual(result["error"]["code"], "SESSION_FILE_MISSING")
        self.assertEqual(self.server.requests, 0)
        self.execute()
        original = self.state.read_bytes()
        self.state.write_bytes(b"invalid synthetic checkpoint")
        _, result = self.process(self.operation())
        self.assertEqual(result["error"]["code"], "INVALID_SESSION_FILE")
        self.assertEqual(self.state.read_bytes(), b"invalid synthetic checkpoint")
        self.state.write_bytes(original)
        self.server.revoked = True
        _, result = self.process(self.operation())
        self.assertEqual(result["error"]["status"], 401)
        self.assertEqual(self.server.join_count, 1)

    def test_expiry_removes_only_the_selected_checkpoint_without_network(self):
        self.execute()
        with client.PrivateCheckpoint(str(self.state), True).locked() as checkpoint:
            saved = checkpoint.load()
            saved["expiresAt"] = "2020-01-01T00:00:00Z"
            checkpoint.save(saved)
        before = self.server.requests
        _, result = self.process(self.operation("resume"))
        self.assertEqual(result["error"]["code"], "SESSION_EXPIRED")
        self.assertFalse(self.state.exists())
        self.assertEqual(self.server.requests, before)

    def test_origin_and_room_mismatch_do_not_disclose_or_rejoin(self):
        self.execute()
        before = self.server.requests
        with self.assertRaises(client.LinkFault) as error:
            client.execute(self.operation("resume"), origin="https://different.example", filename=str(self.state), approved=True)
        self.assertEqual(error.exception.code, "ORIGIN_MISMATCH")
        self.assertEqual(self.server.requests, before)
        with self.assertRaises(client.LinkFault) as error:
            self.execute(self.operation(invitation="link2." + "X" * 22 + "." + "Y" * 43))
        self.assertEqual(error.exception.code, "ROOM_MISMATCH")
        self.assertEqual(self.server.join_count, 1)

    def test_output_never_exports_credentials_or_invitation(self):
        self.execute()
        saved = client.PrivateCheckpoint(str(self.state), True).load()
        public = client.public_output({"credential": saved["credential"], "Authorization": "synthetic", "nested": {"text": "Never echo " + saved["credential"] + " or " + INVITATION}})
        encoded = json.dumps(public)
        self.assertNotIn(saved["credential"], encoded)
        self.assertNotIn(INVITATION, encoded)
        self.assertNotIn("Authorization", encoded)
        result, _ = self.process(self.operation("receive"))
        self.assertNotIn(saved["credential"].encode(), result.stdout + result.stderr)

    def test_send_requires_stable_request_id_and_replays_without_duplicates(self):
        self.execute()
        _, failed = self.process(self.operation("send", text="Synthetic send"))
        self.assertEqual(failed["error"]["code"], "INVALID_INPUT")
        first = self.execute(self.operation("send", text="Synthetic send", requestId="stable-test"))
        second = self.execute(self.operation("send", text="Synthetic send", requestId="stable-test"))
        self.assertEqual(first["result"]["messageId"], second["result"]["messageId"])
        self.assertEqual(len(self.server.sent), 1)

    def test_long_poll_releases_checkpoint_lock_for_another_sending_process(self):
        self.execute()
        self.server.hold_receive = True
        receiver = subprocess.Popen(self.command(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        receiver.stdin.write(json.dumps(self.operation("receive", waitMs=5000)).encode())
        receiver.stdin.close()
        try:
            self.assertTrue(self.server.receive_started.wait(5))
            result, sent = self.process(self.operation("send", text="Synthetic concurrent send", requestId="during-wait"))
            self.assertEqual(result.returncode, 0)
            self.assertTrue(sent["result"]["accepted"])
        finally:
            self.server.receive_release.set()
            receiver.wait(10)
            receiver.stdout.close()
            receiver.stderr.close()

    def test_redirect_is_not_followed_and_https_is_required_by_default(self):
        with self.assertRaises(client.LinkFault) as error:
            client.execute(self.operation(), origin=self.server.origin, filename=str(self.state), approved=True)
        self.assertEqual(error.exception.code, "INVALID_ORIGIN")
        self.assertEqual(self.server.requests, 0)
        self.execute()
        self.server.redirect = True
        before = self.server.requests
        _, result = self.process(self.operation("resume"))
        self.assertEqual(result["error"]["code"], "REDIRECT_BLOCKED")
        self.assertEqual(self.server.requests, before + 1)

    def test_git_repository_and_relative_state_paths_are_rejected(self):
        repository = self.root / "repo"
        (repository / ".git").mkdir(parents=True)
        with self.assertRaises(client.LinkFault) as error:
            client.execute(self.operation(), origin=self.server.origin, filename=str(repository / "private" / "session.json"), approved=True, development=True)
        self.assertEqual(error.exception.code, "UNSAFE_SESSION_LOCATION")
        with self.assertRaises(client.LinkFault):
            client.PrivateCheckpoint("relative-session.json", True)
        self.assertEqual(self.server.requests, 0)

    @unittest.skipUnless(os.name == "posix", "POSIX permissions and symlinks")
    def test_insecure_directory_symlink_and_hardlink_are_rejected(self):
        self.state.parent.mkdir(mode=0o755)
        with self.assertRaises(client.LinkFault):
            self.execute()
        self.state.parent.chmod(0o700)
        target = self.root / "unrelated-file"
        target.write_text("must not change")
        self.state.symlink_to(target)
        with self.assertRaises(client.LinkFault):
            self.execute()
        self.assertEqual(target.read_text(), "must not change")
        self.state.unlink()
        os.link(target, self.state)
        with self.assertRaises(client.LinkFault):
            self.execute()
        self.assertEqual(target.read_text(), "must not change")


if __name__ == "__main__":
    unittest.main(verbosity=2)
