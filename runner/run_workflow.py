#!/usr/bin/env python3
"""Run a code-mode JS workflow through the app-server `thread/codeMode/exec` RPC.

    run_workflow.py demos/01_fanout_summary.js --cwd /path/to/any/multi-folder/repo

`lib/prelude.js` is prepended automatically, so demos can use spawnMany/collectAll/etc.
Reads OPENAI_API_KEY (and friends) from the environment; source your .env first.
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from rpc_client import AppServer, adhoc_poa  # noqa: E402

PRELUDE = os.path.join(ROOT, "lib", "prelude.js")
# The pragma must stay on line 1, so it is lifted above the prelude.
PRAGMA_PREFIX = "// @exec:"


def build_source(script_path):
    body = open(script_path).read()
    prelude = open(PRELUDE).read()

    pragma = ""
    lines = body.split("\n")
    if lines and lines[0].startswith(PRAGMA_PREFIX):
        pragma = lines[0] + "\n"
        body = "\n".join(lines[1:])

    return f"{pragma}{prelude}\n// ---- demo ----\n{body}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("script")
    ap.add_argument("--cwd", default=None, help="working directory for the thread")
    ap.add_argument("--model", default=os.environ.get("CODEX_DEMO_MODEL"))
    ap.add_argument("--raw", action="store_true", help="print the raw RPC result")
    args = ap.parse_args()

    source = build_source(args.script)

    s = AppServer()
    t0 = time.time()
    try:
        s.request(
            "initialize",
            {
                "clientInfo": {"name": "workflow-demos", "title": "workflow-demos", "version": "0.1.0"},
                "capabilities": {"experimentalApi": True},
            },
        )
        start_params = {}
        if args.cwd:
            start_params["cwd"] = os.path.abspath(args.cwd)
        if args.model:
            start_params["model"] = args.model
        started = s.request("thread/start", start_params)
        tid = started["thread"]["id"]
        print(f"thread {tid}   cwd={start_params.get('cwd', '<default>')}"
              f"   model={args.model or '<config>'}\n", flush=True)

        result = s.request(
            "thread/codeMode/exec",
            {"threadId": tid, "package": adhoc_poa(source)},
            timeout=1800,
        )
        if args.raw:
            print(json.dumps(result, indent=2, ensure_ascii=False))
            return

        raw_output = result.get("output", {}).get("output", [])
        items = [raw_output] if isinstance(raw_output, str) else raw_output
        for it in items:
            # text() is not the only output primitive: image()/audio()/generatedImage() append
            # items that carry no "text" field, and printing "" for them reads as a bug in the
            # program rather than a value the runner declined to render.
            if isinstance(it, dict) and "text" not in it:
                summary = ", ".join(
                    f"{k}={len(v)} chars" if isinstance(v, str) and len(v) > 60 else f"{k}={v!r}"
                    for k, v in it.items()
                    if k != "type"
                )
                print(f"[{it.get('type', 'item')}] {summary}")
                continue
            text = it if isinstance(it, str) else it.get("text", "")
            stripped = text.strip()
            if stripped.startswith("{") or stripped.startswith("["):
                try:
                    print(json.dumps(json.loads(stripped), indent=2, ensure_ascii=False))
                    continue
                except json.JSONDecodeError:
                    pass
            print(text)
        print(f"\n--- wall clock: {time.time() - t0:.1f}s ---")
    finally:
        s.close()


if __name__ == "__main__":
    main()
