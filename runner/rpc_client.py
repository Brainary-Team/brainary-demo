#!/usr/bin/env python3
"""Minimal app-server JSON-RPC client that drives thread/codeMode/exec."""
import base64
import io
import json
import os
import queue
import shutil
import subprocess
import sys
import zipfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)


def resolve_codex_bin():
    """CODEX_BIN > ./bin/codex (where the release tarball unpacks) > `codex` on PATH.

    PATH comes last on purpose: a stock upstream `codex` will be found there and will
    fail at the JSON-RPC layer with "unknown method thread/codeMode/exec", which reads
    like a protocol bug rather than the real cause -- wrong binary.
    """
    explicit = os.environ.get("CODEX_BIN")
    if explicit:
        return explicit

    bundled = os.path.join(REPO, "bin", "codex")
    if os.path.isfile(bundled):
        return bundled

    found = shutil.which("codex")
    if found:
        return found

    raise RuntimeError(
        "could not locate a codex binary. Unpack the release tarball into ./bin/ "
        "(it contains both `codex` and `codex-code-mode-host`, which must stay in the "
        "same directory), or set CODEX_BIN to the path of `codex`. See README.md."
    )


# The zip epoch, matching what codex and build.sh write, so the same script is the same bytes.
FIXED_DATE = (1980, 1, 1, 0, 0, 0)


def adhoc_poa(source):
    """Wrap a bare snippet of JavaScript as a base64 `.poa`.

    `thread/codeMode/exec` takes a package and nothing else, so a caller holding only a script
    says so as a package that declares no capabilities. Everything else about the request is
    identical to running a real package, which is the point: one shape on the wire.
    """
    manifest = (
        "[poa]\n"
        'name = "adhoc"\n'
        'version = "0.0.0"\n'
        'runtime = "codex-v8"\n'
        "poa_api_version = 1\n"
        'entry = "main.js"\n'
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, contents in sorted([("main.js", source), ("manifest.toml", manifest)]):
            info = zipfile.ZipInfo(name, date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            # create_system 3 (unix) is what makes a reader honor the mode in external_attr.
            info.create_system = 3
            info.external_attr = 0o644 << 16
            archive.writestr(info, contents)
    return base64.b64encode(buffer.getvalue()).decode("ascii")



class AppServer:
    """Drives `codex app-server` over stdio.

    A single reader thread owns stdout and routes each message to one of three places:
    responses to the waiting caller, server->client requests to an auto-approval, and
    notifications to a queue. Notifications used to be dropped on the floor, which made
    `mcpServer/startupStatus/updated` unobservable.
    """

    def __init__(self, codex_bin=None):
        CODEX = codex_bin or resolve_codex_bin()
        self.proc = subprocess.Popen(
            [CODEX, "app-server"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self._id = 0
        self._pending = {}
        self._notifications = queue.Queue()
        self._lock = threading.Lock()
        self._closed = threading.Event()
        threading.Thread(target=self._drain_stderr, daemon=True).start()
        threading.Thread(target=self._read_stdout, daemon=True).start()

    def _drain_stderr(self):
        for line in self.proc.stderr:
            if any(k in line for k in ("ERROR", "panic", "error:")):
                print(f"[stderr] {line.rstrip()}", file=sys.stderr)

    def _read_stdout(self):
        for line in self.proc.stdout:
            try:
                m = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "method" in m and "id" in m:
                self._answer_server_request(m)
            elif "method" in m:
                self._notifications.put(m)
            elif "id" in m:
                with self._lock:
                    slot = self._pending.pop(m["id"], None)
                if slot is not None:
                    slot.put(m)
        # Unblock anyone still waiting on a response the server will never send.
        self._closed.set()
        with self._lock:
            pending, self._pending = self._pending, {}
        for slot in pending.values():
            slot.put(None)

    # Server->client requests must be answered in the shape the server expects: a wrong
    # payload fails to deserialize and the server keeps waiting, which reads as a hang.
    DEFAULT_SERVER_REQUEST_REPLY = {"decision": "approved"}

    def _answer_server_request(self, message):
        method = message.get("method", "")
        params = message.get("params") or {}
        if os.environ.get("CODEX_RPC_DEBUG"):
            print(f"[rpc] server request: {method} {json.dumps(params)}", file=sys.stderr)

        if method == "mcpServer/elicitation/request":
            # Codex reuses elicitation to ask for tool-call approval, tagging those with
            # `codex_approval_kind`. A PoA's capabilities are declared in its manifest, so
            # approving them here is the manifest's decision rather than a blanket yes; a
            # genuine elicitation from a server has no one to answer it and is declined.
            is_codex_approval = "codex_approval_kind" in (params.get("_meta") or {})
            reply = (
                {"action": "accept", "content": {}}
                if is_codex_approval
                else {"action": "decline", "content": None}
            )
        else:
            reply = self.DEFAULT_SERVER_REQUEST_REPLY
        self._send({"jsonrpc": "2.0", "id": message["id"], "result": reply})

    def _send(self, message):
        try:
            self.proc.stdin.write(json.dumps(message) + "\n")
            self.proc.stdin.flush()
        except (BrokenPipeError, ValueError) as err:
            raise RuntimeError("app-server closed stdin") from err

    def request(self, method, params, timeout=180):
        slot = queue.Queue(1)
        with self._lock:
            self._id += 1
            rid = self._id
            self._pending[rid] = slot
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        try:
            m = slot.get(timeout=timeout)
        except queue.Empty:
            with self._lock:
                self._pending.pop(rid, None)
            raise RuntimeError(f"{method} timed out after {timeout}s") from None
        if m is None:
            raise RuntimeError("app-server closed stdout")
        if "error" in m:
            # An app-server that does not know this method lists every method it *does* know,
            # which is ~150 names -- the one useful word is buried. This is also the single
            # most likely first-run failure (a stock upstream `codex` picked up from PATH),
            # so name the cause instead of leaving it in the haystack.
            if method == "thread/codeMode/exec" and "unknown variant" in str(m["error"]):
                raise RuntimeError(
                    f"this codex binary has no {method} method -- it is not a Brainary PoA "
                    f"runtime. Check which binary ran: CODEX_BIN > ./bin/codex > PATH. "
                    f"See README.md, 'Getting the runtime'.\n\nServer said: {m['error']}"
                )
            raise RuntimeError(f"{method} failed: {m['error']}")
        return m.get("result")

    def wait_for_notification(self, method, predicate=None, timeout=30):
        """Return the first buffered-or-incoming notification matching `method`.

        Returns None on timeout so callers can decide whether a missing notification is
        fatal; notifications that do not match are dropped rather than requeued, so only
        wait on a method you are actually driving.
        """
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            try:
                m = self._notifications.get(timeout=remaining)
            except queue.Empty:
                return None
            if m.get("method") != method:
                continue
            if predicate is None or predicate(m.get("params") or {}):
                return m

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=10)


def main():
    """Smoke test: `python3 rpc_client.py 'text("hi");'`"""
    source = sys.argv[1] if len(sys.argv) > 1 else 'text("hello from rpc");'
    print(f"codex: {resolve_codex_bin()}", file=sys.stderr)
    s = AppServer()
    try:
        s.request(
            "initialize",
            {
                "clientInfo": {"name": "rpc-smoke", "title": "rpc-smoke", "version": "0.0.0"},
                "capabilities": {"experimentalApi": True},
            },
        )
        started = s.request("thread/start", {})
        thread_id = started["thread"]["id"]
        result = s.request(
            "thread/codeMode/exec", {"threadId": thread_id, "package": adhoc_poa(source)}
        )
        print(json.dumps(result, indent=2, ensure_ascii=False))
    finally:
        s.close()


if __name__ == "__main__":
    main()
