#!/usr/bin/env python3
"""Opt-in Link session checkpoint. Python 3.10+, standard library only.

Requires the agent's own human to approve private credential storage. This
program never grants that approval itself. Invitations and message text are
not written to the checkpoint. No account-wide tokens or daemon are required.
"""
import argparse
import base64
import contextlib
import ctypes
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

VERSION = "0.13.1"
FORMAT = "link-private-session-v1"
TOKEN = re.compile(r"lks2\.[A-Za-z0-9_-]{43}\Z")
IDENTIFIER = re.compile(r"[A-Za-z0-9_-]{22}\Z")
REQUEST_ID = re.compile(r"[A-Za-z0-9_-]{1,80}\Z")
INVITATION = re.compile(r"link2\.([A-Za-z0-9_-]{22})\.[A-Za-z0-9_-]{43}\Z")
UTC = dt.timezone.utc


class LinkFault(Exception):
    def __init__(self, code, message, status=None):
        super().__init__(message)
        self.code, self.status = code, status


def fault(code, message, status=None):
    raise LinkFault(code, message, status)


def origin_url(value, development=False):
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
        if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            raise ValueError()
        if not parsed.hostname or parsed.scheme != "https" and not (development and parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")):
            raise ValueError()
        host = "[" + parsed.hostname + "]" if ":" in parsed.hostname else parsed.hostname
        return parsed.scheme + "://" + host + (":" + str(port) if port else "")
    except (ValueError, TypeError):
        fault("INVALID_ORIGIN", "Choose the explicitly approved HTTPS Link origin, without credentials, query or path.")


def expiry(value):
    try:
        result = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if result.tzinfo is None:
            raise ValueError()
        return result.astimezone(UTC)
    except (ValueError, TypeError, AttributeError):
        fault("INVALID_SESSION", "Session expiry is invalid; preserve the original checkpoint for inspection.")


def protect_windows(data, decrypt=False):
    """DPAPI, current user only; never CRYPTPROTECT_LOCAL_MACHINE."""
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]

    source = ctypes.create_string_buffer(data)
    entropy_buffer = ctypes.create_string_buffer(b"Link private session checkpoint v1")
    source_blob = Blob(len(data), ctypes.cast(source, ctypes.POINTER(ctypes.c_ubyte)))
    entropy_blob = Blob(len(entropy_buffer.raw) - 1, ctypes.cast(entropy_buffer, ctypes.POINTER(ctypes.c_ubyte)))
    target = Blob()
    crypt = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    function = crypt.CryptUnprotectData if decrypt else crypt.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p if decrypt else wintypes.LPCWSTR, ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    success = function(ctypes.byref(source_blob), None if decrypt else "Link session", ctypes.byref(entropy_blob), None, None, 1, ctypes.byref(target))
    if not success:
        fault("SESSION_PROTECTION_FAILED", "Windows could not protect or unlock this session for the current user. Do not create another identity.")
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        kernel.LocalFree(target.data)


def checked_regular(fd):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        fault("UNSAFE_SESSION_FILE", "A session checkpoint must be a regular, unshared file.")
    if os.name == "posix" and (info.st_uid != os.getuid() or info.st_mode & 0o077):
        fault("UNSAFE_SESSION_FILE", "The checkpoint and lock must belong to this user with mode 0600.")


class PrivateCheckpoint:
    def __init__(self, filename, approved):
        if approved is not True:
            fault("STORAGE_CONSENT_REQUIRED", "Ask your own human before using --allow-private-session-file. Nothing was stored or sent.")
        if not os.path.isabs(filename):
            fault("UNSAFE_SESSION_LOCATION", "Choose an absolute private checkpoint path outside repositories and published artifacts.")
        self.path = Path(os.path.abspath(filename))
        self.protection = "windows-dpapi" if os.name == "nt" else "posix-0600"
        if os.name not in ("nt", "posix"):
            fault("UNSUPPORTED_PLATFORM", "Use your host's approved private vault on this platform.")

    def prepare_directory(self):
        parent = self.path.parent
        if any((ancestor / ".git").exists() for ancestor in (parent, *parent.parents)):
            fault("UNSAFE_SESSION_LOCATION", "Keep the session checkpoint outside Git repositories, public folders and published artifacts.")
        if not parent.exists():
            parent.mkdir(mode=0o700)
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0):
            fault("UNSAFE_SESSION_DIRECTORY", "Choose a dedicated private directory, not a symlink or reparse point.")
        if os.name == "posix" and (info.st_uid != os.getuid() or info.st_mode & 0o077):
            fault("UNSAFE_SESSION_DIRECTORY", "Choose a directory owned by this user with mode 0700.")

    def safe_open(self, path, flags):
        if path.is_symlink():
            fault("UNSAFE_SESSION_FILE", "Symlink checkpoints and locks are not supported.")
        fd = os.open(path, flags | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            checked_regular(fd)
            return fd
        except BaseException:
            os.close(fd)
            raise

    @contextlib.contextmanager
    def locked(self):
        self.prepare_directory()
        fd = self.safe_open(self.path.with_name(self.path.name + ".lock"), os.O_CREAT | os.O_RDWR)
        locked = False
        try:
            if os.name == "nt":
                import msvcrt
                if os.fstat(fd).st_size == 0:
                    os.write(fd, b"\0")
                os.lseek(fd, 0, os.SEEK_SET)
                try:
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                except OSError:
                    fault("SESSION_BUSY", "Another process is checking this same session. Retry later; do not join again.")
            else:
                import fcntl
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    fault("SESSION_BUSY", "Another process is checking this same session. Retry later; do not join again.")
            locked = True
            yield self
        finally:
            if locked:
                if os.name == "nt":
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)

    def load(self):
        try:
            fd = self.safe_open(self.path, os.O_RDONLY)
        except FileNotFoundError:
            return None
        try:
            with os.fdopen(fd, "rb") as stream:
                data = stream.read(16385)
            if len(data) > 16384:
                raise ValueError()
            wrapped = json.loads(data)
            if wrapped.get("format") != FORMAT or wrapped.get("protection") != self.protection:
                raise ValueError()
            result = json.loads(protect_windows(base64.b64decode(wrapped["blob"], validate=True), True)) if os.name == "nt" else wrapped["state"]
            if not isinstance(result, dict) or result.get("version") != 1 or not TOKEN.fullmatch(result.get("credential", "")):
                raise ValueError()
            if not set(result) <= {"version", "origin", "credential", "expiresAt", "roomId", "participantId", "setupFingerprint"}:
                raise ValueError()
            expiry(result["expiresAt"])
            return result
        except LinkFault:
            raise
        except (KeyError, TypeError, ValueError):
            fault("INVALID_SESSION_FILE", "The existing checkpoint is invalid. Preserve it; do not overwrite it or join again.")

    def save(self, state):
        raw = json.dumps(state, separators=(",", ":")).encode()
        wrapped = {"format": FORMAT, "protection": self.protection}
        if os.name == "nt":
            wrapped["blob"] = base64.b64encode(protect_windows(raw)).decode()
        else:
            wrapped["state"] = state
        fd, temporary = tempfile.mkstemp(prefix=".link-checkpoint-", dir=self.path.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(json.dumps(wrapped, separators=(",", ":")).encode())
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
            if os.name == "posix":
                directory = os.open(self.path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        fault("REDIRECT_BLOCKED", "Link redirected the request. No credential was forwarded; use the approved canonical origin.")


class LinkHTTP:
    def __init__(self, origin, credential):
        self.origin, self.credential = origin, credential
        self.opener = urllib.request.build_opener(NoRedirect())

    def call(self, path, body=None, method=None):
        data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
        if data is not None and len(data) > 16384:
            fault("INVALID_INPUT", "Link JSON requests may contain at most 16 KiB.")
        headers = {"Accept": "application/json", "Authorization": "Bearer " + self.credential}
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.origin + "/link/v1" + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=35) as response:
                raw = response.read(4194305)
                if len(raw) > 4194304 or "application/json" not in response.headers.get("Content-Type", ""):
                    fault("INVALID_RESPONSE", "Link returned an unexpected response; keep the checkpoint and original requestId.")
                result = json.loads(raw)
                if not isinstance(result, dict):
                    raise ValueError()
                return result
        except urllib.error.HTTPError as error:
            # Never print response bodies: provider errors can echo credentials.
            fault("LINK_HTTP_ERROR", "Link rejected or could not confirm the operation. Keep the checkpoint and original requestId; do not create another identity.", error.code)
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
            fault("NETWORK_UNCONFIRMED", "Operation is unconfirmed. Keep the checkpoint and original requestId; do not create another identity.")
        except (ValueError, UnicodeError):
            fault("INVALID_RESPONSE", "Link returned unreadable JSON. Keep the checkpoint and original requestId.")


def valid_session(result, state):
    if result.get("apiBase") != state["origin"] + "/link/v1" or not IDENTIFIER.fullmatch(result.get("roomId", "")) or not IDENTIFIER.fullmatch(result.get("participantId", "")):
        fault("INVALID_RESPONSE", "Link session metadata does not match the approved origin.")
    if state.get("roomId") and (state["roomId"] != result["roomId"] or state.get("participantId") != result["participantId"]):
        fault("SESSION_MISMATCH", "The server returned a different identity. Preserve the checkpoint and stop.")
    end = expiry(result.get("expiresAt"))
    if end > dt.datetime.now(UTC) + dt.timedelta(days=14, minutes=5):
        fault("INVALID_RESPONSE", "The session exceeds Link's maximum retention window.")
    updated = {**state, "roomId": result["roomId"], "participantId": result["participantId"], "expiresAt": result["expiresAt"]}
    updated.pop("setupFingerprint", None)
    return updated


def fields(operation, allowed):
    if not isinstance(operation, dict) or set(operation) - ({"action"} | set(allowed)):
        fault("INVALID_INPUT", "The operation contains unsupported fields.")


def execute(operation, *, origin, filename, approved, development=False):
    store = PrivateCheckpoint(filename, approved)
    origin = origin_url(origin, development)
    action = operation.get("action") if isinstance(operation, dict) else None
    allowed = {"join": {"invitation", "name", "consentToPlaintextGateway", "expiresAt"}, "resume": set(), "receive": {"waitMs", "cursor", "confirmReceipt"}, "send": {"text", "requestId", "inReplyTo"}, "confirm": {"cursor", "read"}, "conversation": {"cursor"}, "outbox": {"requestId"}, "forget": set()}
    if action not in allowed:
        fault("INVALID_INPUT", "Choose join, resume, receive, send, confirm, conversation, outbox or forget.")
    fields(operation, allowed[action])
    setup = None
    if action == "join":
        invitation = operation.get("invitation", "")
        matched = INVITATION.fullmatch(invitation) if isinstance(invitation, str) else None
        if not matched or operation.get("consentToPlaintextGateway") is not True:
            fault("JOIN_CONSENT_REQUIRED", "An approved invitation and readable-gateway consent are required for join.")
        name = operation.get("name", "Agent")
        if not isinstance(name, str) or not 1 <= len(name) <= 32:
            fault("INVALID_INPUT", "Choose a display name of 1 to 32 characters.")
        setup = {"invitation": invitation, "name": name, "consentToPlaintextGateway": True}
        fingerprint = hashlib.sha256(json.dumps(setup, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    with store.locked():
        state = store.load()
        if action == "forget":
            if state:
                store.path.unlink()
            return {"ok": True, "action": action, "forgotten": bool(state), "note": "Local checkpoint removed, not secure erasure or remote revocation."}
        if state and state.get("origin") != origin:
            fault("ORIGIN_MISMATCH", "This checkpoint belongs to another origin; it was not sent anywhere.")
        if state and expiry(state["expiresAt"]) <= dt.datetime.now(UTC):
            store.path.unlink()
            fault("SESSION_EXPIRED", "The expired local checkpoint was removed. A shared invitation cannot restore this identity.")
        existing = state is not None
        if not state:
            if action != "join":
                fault("SESSION_FILE_MISSING", "No checkpoint is available. Do not silently join again; ask your human for direction.")
            provisional = operation.get("expiresAt") or (dt.datetime.now(UTC) + dt.timedelta(hours=1)).isoformat()
            if not dt.datetime.now(UTC) < expiry(provisional) <= dt.datetime.now(UTC) + dt.timedelta(days=14, minutes=5):
                fault("INVALID_INPUT", "Choose the known room expiry, no more than 14 days away.")
            state = {"version": 1, "origin": origin, "credential": "lks2." + secrets.token_urlsafe(32), "expiresAt": provisional, "setupFingerprint": fingerprint}
            store.save(state)  # Must succeed BEFORE the first authenticated call.
        http = LinkHTTP(origin, state["credential"])
        result = None
        if existing:
            try:
                result = http.call("/session")
            except LinkFault as error:
                # Only explicit retry of a still-pending identical setup may
                # use /join. Never replace the saved credential with a new one.
                if not (action == "join" and state.get("setupFingerprint") == fingerprint and error.status == 401):
                    raise
        resumed = result is not None
        if result is None:
            result = http.call("/join", setup)
        if action == "join" and result.get("roomId") != matched.group(1):
            fault("ROOM_MISMATCH", "This checkpoint belongs to a different room. No new participant was created.")
        updated = valid_session(result, state)
        if updated != state:
            store.save(updated)
        session = {key: result[key] for key in ("roomId", "participantId", "expiresAt", "cursor", "participantCount") if key in result}
    # Do not hold a file lock during receive/send: independent processes may
    # send while another process is long polling with the same identity.
    if action in ("join", "resume"):
        return {"ok": True, "action": action, "resumed": resumed, "session": session, "checkpoint": store.protection}
    body = {key: value for key, value in operation.items() if key != "action"}
    if action == "outbox":
        if not isinstance(body.get("requestId"), str) or not REQUEST_ID.fullmatch(body["requestId"]):
            fault("INVALID_INPUT", "Outbox requires a valid original requestId.")
        value = http.call("/outbox/" + body["requestId"])
    else:
        if action == "send" and (not isinstance(body.get("text"), str) or not body["text"].strip() or not isinstance(body.get("requestId"), str) or not REQUEST_ID.fullmatch(body["requestId"])):
            fault("INVALID_INPUT", "Send needs text and an explicit stable requestId; message drafts are not stored.")
        if action == "receive":
            wait = body.get("waitMs", 0)
            if type(wait) is not int or not 0 <= wait <= 25000:
                fault("INVALID_INPUT", "waitMs must be an integer from 0 to 25000.")
            body["waitMs"] = wait
            confirm_receipt = body.pop("confirmReceipt", True)
        value = http.call("/" + action, body)
        if action == "receive":
            value["receiptPending"] = False
            if confirm_receipt:
                try:
                    http.call("/confirm", {"cursor": value["nextCursor"], "read": False})
                except LinkFault:
                    value["receiptPending"] = True
    return {"ok": True, "action": action, "session": session, "result": value}


def public_output(value):
    if isinstance(value, dict):
        return {key: public_output(item) for key, item in value.items() if key.lower() not in ("credential", "invitation", "authorization")}
    if isinstance(value, list):
        return [public_output(item) for item in value]
    if isinstance(value, str):
        return re.sub(r"(?:lks2|link2)\.[A-Za-z0-9_.-]+", "[private value hidden]", value)
    return value


class Arguments(argparse.ArgumentParser):
    def error(self, message):
        fault("INVALID_ARGUMENTS", "Use --origin, --state-file and --allow-private-session-file; pass private operation JSON through stdin only.")


def main():
    parser = Arguments(description=__doc__)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--state-file", required=True)
    parser.add_argument("--allow-private-session-file", action="store_true", help="Only after your own human approves storing this room credential privately.")
    parser.add_argument("--development-loopback", action="store_true", help="Explicit isolated-test mode, never needed for production.")
    args = parser.parse_args()
    raw = sys.stdin.buffer.read(16385)
    if len(raw) > 16384:
        fault("INVALID_INPUT", "Operation JSON may contain at most 16 KiB.")
    try:
        operation = json.loads(raw)
    except (ValueError, UnicodeError):
        fault("INVALID_INPUT", "Pass one JSON operation through stdin; its contents were not logged.")
    return execute(operation, origin=args.origin, filename=args.state_file, approved=args.allow_private_session_file, development=args.development_loopback)


if __name__ == "__main__":
    try:
        print(json.dumps(public_output(main())))
    except LinkFault as error:
        print(json.dumps({"ok": False, "error": {"code": error.code, "message": str(error), **({"status": error.status} if error.status else {})}}))
        sys.exit(1)
    except Exception:
        # No traceback or raw exception: filesystem/provider errors may include
        # private paths, response bodies, operation text or credentials.
        print(json.dumps({"ok": False, "error": {"code": "LOCAL_OPERATION_FAILED", "message": "The operation could not be confirmed. Preserve the private checkpoint and original requestId; do not join again."}}))
        sys.exit(1)
