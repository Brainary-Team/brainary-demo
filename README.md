# POA on Codex

A **Program of Agent** (POA) is a program that drives LLM agents rather than being one: the control
flow is code, the agents are what the code calls.
Brainary's own runtime runs POAs as wasm. This repository runs them on **Codex's code-mode runtime**
instead — the CoT program is JavaScript executed in Codex's V8 host, and the kernel is Codex itself.

Everything here is example material: PoA programs, a packaging script, a minimal client, and the
notes needed to read them. Running any of it needs the Brainary PoA runtime binaries — see
[Getting the runtime](#getting-the-runtime).

The orchestration costs **zero model calls**: the program is submitted directly over JSON-RPC and
executed by the runtime, not authored by a model.

```
any client ──JSON-RPC──▶ codex app-server ──▶ code-mode host (V8) ──▶ tools.* ──▶ subagents
            thread/codeMode/exec { source | packageBase64 }
```

The demos here drive that RPC from Python (`runner/`). A packaged program does not need a client at
all: `codex exec --poa <path>` packs the package and hands the bytes to the same method.

## How this maps onto brainary's POA model

The two runtimes reach the same shape from different directions, which makes the correspondence a
useful way to read either one:

| brainary POA | Codex code mode |
|---|---|
| CoT program, compiled to wasm | JS cell, evaluated in a V8 isolate |
| Interpreter: `brainary-runtime` (wasmtime) | Interpreter: `codex-code-mode-host` (V8) |
| Kernel: agent lifetime + LLM access | `ThreadManager` + `AgentControl` |
| Operators (syscalls) via `host.syscall` | Globals + nested tool calls on `tools` |
| `sys.hello` → static capability inventory | `ALL_TOOLS` |
| `agent.create` / `agent.ask` | `spawn_agent` / `wait_agent` |
| `tool.call { primitive, tool, args }` | `tools.<primitive>__<tool>(args)` |
| Primitives (MCP servers) | MCP servers from config, agent roles |
| Short-term memory (shared with subagents) | `store()` / `load()` — **per session, not shared** |
| Long-term memory | memories extension |
| `.poa` package: wasm + capabilities + resources | `.poa` package: JS body + capabilities |

Where they genuinely differ, and it matters:

- **Any language vs JavaScript.** A brainary POA is wasm, so it can be Rust, Python, anything.
  Code mode is V8 only.
- **What a package may carry.** Both formats let a program bring its own MCP servers. brainary's
  package also carries a `[build]` section and resources; this one carries a manifest, a JS body, and
  stdio servers, and nothing else yet.
- **Sync ask vs async handles.** `agent.ask` runs the whole tool-call loop and returns the answer.
  Codex gives you a handle and makes waiting explicit, which is what allows the fan-out in these
  demos but also means every join is hand-written (see the prelude).
- **Structured output.** `agent.ask(schema)` has the kernel enforce and validate JSON. Codex has no
  equivalent, so the demos ask for JSON in the prompt and parse defensively (`parseJsonReply`).
- **Determinism.** brainary routes wall-clock through `sys.now` so journaled runs replay. Code mode
  has a real `Date.now()` and no journal — reruns are not reproducible.

## What the runtime provides

Stock Codex cannot run any of this: its only entry into code mode is a tool call the model emits,
so there is no way to hand it a program. The Brainary runtime adds four capabilities that the
material here depends on:

1. **`thread/codeMode/exec`** — submit one code-mode cell to a thread and get its output back,
   without sampling the model. This is what makes the orchestration cost zero model calls.

2. **Plaintext subagent messages from code mode.** On multi-agent v2, messages a program assembles
   in JS reach the subagent as plain text rather than being filed as ciphertext. Only relevant on
   v2; v1 never takes that path.

3. **`requiredMcpServers`** — an exec may name MCP servers whose startup must finish before the
   cell's tool surface is captured. Without it, a cell that starts while a server is still
   initializing sees that server's tools as *absent* rather than pending, which is indistinguishable
   from a misconfiguration.

4. **The `.poa` package, assembled server-side.** An exec accepts a packed package instead of bare
   source. The server unpacks it, validates the manifest, reads its `entry`, and starts the MCP
   servers it declares for that thread alone. Every front end therefore runs a package by handing
   over the same bytes — `codex exec --poa` is a thin client that packs a directory and sends it.

## Getting the runtime

**Nothing here runs without the runtime binaries, which are not in this repository.** They are
released separately, as one archive per platform; get the one for your machine before going
further. Current builds target **x86_64 Linux** (statically linked), so on macOS or Windows run
the demos inside a Linux container, VM, or WSL.

The archive contains two binaries, `codex` and `codex-code-mode-host`. Codex locates the host in
its own directory, so **they must stay together**. Unpack them into `bin/` at the root of this
repository:

```bash
mkdir -p bin
tar -xzf codex-poa-<target>.tar.gz -C bin
./bin/codex --version
```

`bin/` is gitignored. If you keep the binaries elsewhere, point `CODEX_BIN` at `codex` instead;
resolution order is `CODEX_BIN` → `./bin/codex` → `PATH`. `PATH` is last on purpose — a stock
upstream `codex` found there fails with `unknown method thread/codeMode/exec`, which reads like a
protocol bug rather than the real cause.

## Quick start

Copy `.env.example` to `.env` and fill in your provider:

```sh
OPENAI_API_URL=https://your-provider.example/v1   # trailing /v1 optional
OPENAI_API_KEY=...
OPENAI_API_MODEL=your-model
```

Then:

```bash
./run.sh demos/00_probe.js          v1-forced       # 0.3s, no agents, no model call
./run.sh demos/01_fanout_summary.js v1-forced --cwd /path/to/any/multi-folder/repo
```

`run.sh` renders `config/<profile>.toml` into a per-profile `CODEX_HOME`, substituting model and
base URL from the environment. Overrides: `CODEX_DEMO_MODEL`, `CODEX_DEMO_BASE_URL`,
`CODEX_DEMO_SANDBOX`, `CODEX_BIN`.

Demos 0 and 6–9 spawn no agents and never sample a model, so they run with no provider at all —
start there if you have no API key yet. `demos/01`–`05` and `10` do spawn subagents and need a
working provider. Anything under `poas/` runs with no provider either way.

## Demos

| # | Demo | Shows |
|---|------|-------|
| 0 | `00_probe.js` | Which multi-agent backend reached code mode. Run after any model/profile change |
| 1 | `01_fanout_summary.js` | Parallel map: N folders → N subagents → structured report |
| 2 | `02_map_reduce.js` | Composition: mappers read the repo, a reducer agent synthesizes their output without reading anything |
| 3 | `03_adversarial_review.js` | Independent verification: one agent claims, three try to refute under different lenses, the program tallies votes |
| 4 | `04_stateful_dialogue.js` | A subagent as a long-lived worker: read once, then four dependent follow-up turns from memory |
| 5 | `05_streaming_select.js` | `Promise.race` over per-agent waits — and why it does not currently stream (see gotcha 6) |
| 6 | `06_capability_matrix.js` | What this configuration actually exposes. Every read-only tool called once, with the runtime shape of what came back. No agents, ~1s |
| 7 | `07_exec_session.js` | `exec_command` sessions driven through `write_stdin`, and a parallel-safe tool measured against itself run serially |
| 8 | `08_file_and_image.js` | `apply_patch` / `view_image` / `image()`, and the three independent gates a write has to clear |
| 9 | `09_memory_clock_goal.js` | The tools that carry state: memories on disk, the goal state machine, plan, context budget, permissions |
| 10 | `10_agent_lifecycle.js` | The raw subagent tools the prelude hides — `resume_agent`, `interrupt_agent`, the multi-target wait trap, and depth — down both backends |

Demos 0 and 6-9 spawn no agents at all, so they cost no model calls and can be re-run freely.
That is not an inference from how fast they are: pointed at an unreachable provider
(`CODEX_DEMO_BASE_URL=http://127.0.0.1:1/v1`) all four still complete, unchanged. The root
thread never takes a model turn — `thread/codeMode/exec` runs the program directly, so the only
LLM traffic any demo generates comes from the subagents it spawns. It is a useful thing to run:
it separates "the runtime did this" from "a model said this".

Demo 6 is the one to run after any change of model, provider or profile: it reports what is
present, what is absent and which gate each absent tool is behind.

Demo 2's reducer only ever sees the mappers' JSON, so its conclusions come from the fan-out rather
than its own exploration:

```json
"synthesis": {
  "shared_dependencies": ["codex-protocol"],
  "most_connected": "analytics",
  "observation": "The ANSI conversion component is intentionally isolated, whereas analytics
                  acts as the main cross-cutting integration hub."
}
```

## PoA packages

A demo is a loose `.js` that depends on whatever the host happens to provide. A **package** carries
its own capabilities, which is what a `.poa` does in brainary:

```
poas/00_echo/
├── manifest.toml       [poa] metadata + [[capabilities.mcp]] declarations
├── main.js             the body, submitted verbatim (no prelude is prepended)
└── mcp/echo.mjs        a dependency-free stdio MCP server, shipped with the package
```

A `.poa` is that directory zipped, with `manifest.toml` at the root. `poas/build.sh` produces one;
both forms then run the same way:

```bash
poas/build.sh poas/00_echo                # -> ./00_echo.poa
./run.sh poas/00_echo v1-forced           # profile + CODEX_HOME, then `codex exec --poa`
./bin/codex exec --poa poas/00_echo       # no runner at all
./bin/codex exec --poa ./00_echo.poa      # already packed
```

`build.sh` is only for handing someone a single file — `codex exec --poa <dir>` packs a directory on
the fly, so nothing has to be built first. It validates before writing (`manifest.toml` at the root,
`[poa].entry` present and included), fixes timestamps at the zip epoch so packing twice gives the
same bytes. The directory is taken as it is — no ignore rules, no exclusions — and anything that is
not a file is refused rather than dropped. Extracted files get a fixed mode, so a package declares
how to start its servers as a command line (`node mcp/echo.mjs`) rather than relying on an
executable bit.

**Assembly happens on the server.** The CLI packs a directory (or reads a `.poa`), validates the
manifest locally so a malformed package is a usage error rather than a half-started session, and
sends the bytes as `package`. Codex unpacks them, reads the manifest, contributes each
`[[capabilities.mcp]]` entry as a thread-scoped MCP server, waits for every one of them, and runs
`entry`. Nothing is written to the global `config.toml`, and the servers live and die with the
thread. The point of putting this behind the RPC is reuse: the TUI or an agent SDK runs a package by
sending the same bytes, without reimplementing any of it.

The format, its validation, and the server-side startup all live in the runtime, so a package is
the same package to every client that can send bytes.

Two things are easy to get wrong here, both encoded in the fixture:

- **Tool names are discovered, not assumed.** `mcp__echo__echo` is what the current config produces,
  but the prefix depends on `prefix_mcp_tool_names()` and namespaces are sanitized and
  hash-suffixed on collision. `main.js` matches on the `echo__echo` suffix and asserts exactly one
  hit, so a naming change fails loudly instead of silently calling the wrong tool.
- **A tool with no annotations prompts for approval.** Under the default `auto` approval mode, Codex
  assumes an unannotated tool may write and opens world, and raises an elicitation — which in a
  headless run is a hang. `echo.mjs` declares `readOnlyHint`, which is also what would make it
  parallel-safe.

The guarantees a package format has to make are enforced by the runtime's own test suite rather
than by convention: manifest validation, pack/unpack roundtrip, byte-for-byte reproducible
archives, preserved unix modes, rejection of zip-slip and absolute entries, `entry` containment,
duplicate and unsupported MCP declarations, a malformed package refused rather than half-started,
`requiredMcpServers` actually waiting, and the server processes being reclaimed when the thread
shuts down.

A package is runnable with no provider configured at all: `run.sh` falls back to a placeholder key,
model, and closed-port base URL for PoA targets. That fallback sits *below* `.env` and
`CODEX_DEMO_*`, so pointing a package at a real provider — which it will need once packages spawn
agents — works exactly as it does for the demos.

Not yet supported: `network` MCP capabilities (parsed and rejected, not silently ignored), `[build]`,
resources, and capability inheritance — a subagent runs on its own thread and does not get the
package's servers. A package is also capped at 64 MiB, because `packageBase64` rides in one JSON-RPC
message; a package that needs more wants a different transport, not a bigger buffer.

## Layout

```
run.sh                  profile-aware wrapper (isolates CODEX_HOME per profile)
poas/build.sh           packs a package directory into a distributable .poa
runner/rpc_client.py    minimal JSON-RPC client over `codex app-server` stdio
runner/run_workflow.py  prepends lib/prelude.js, submits, renders output
runner/make_catalog.py  derives a v1-pinned model catalog from vendor/models.json
lib/prelude.js          backend-agnostic orchestration primitives
demos/                  the programs
poas/                   packages that carry their own capabilities
config/                 one profile per backend selection strategy
vendor/models.json      the runtime's model catalog, verbatim (see Backend selection)
bin/                    where you unpack the runtime binaries (gitignored)
```

There is no PoA runner script: `run.sh` sets up a profile and calls `codex exec --poa`. Packages
are the one target that needs no Python.

## The prelude

`lib/prelude.js` is prepended to every demo — it is the equivalent of brainary's SDK harness, minus
packaging. It exists because the raw tools are sharp:

- `spawnAgent` / `spawnMany` / `runBatch` — bounded-concurrency spawning
- `collectAll` — waits for every agent, hiding the backends' very different semantics
- `sendAndWait` — follow-up turn on a live agent, polling past its stale prior status
- `parseJsonReply`, `shellLines`, `mapLimit`, `closeAll`
- `hasTool` / `callTool` / `shapeOf` / `timed` — capability probing. Reaching for an optional tool
  group means calling something that may legitimately not be there, and `ALL_TOOLS` gives a name
  and a description but no schema and no return shape. `callTool` never throws and distinguishes
  absent from failed; `shapeOf` describes what actually came back, which for the twelve tools
  declared `Promise<unknown>` is the only description there is.

## Backend selection

`AGENT_BACKEND` is detected at runtime from `ALL_TOOLS`, so every demo runs on either backend.

| | v1 (`multi_agent_v1__*`) | v2 (`collaboration__*`) |
|---|---|---|
| Reaches code mode | by default | only with `non_code_mode_only = false` |
| Spawn arg | `{message}` | `{task_name, message}` (required) |
| Spawn returns | `{agent_id, nickname}` | `{task_name}` — already fully qualified, e.g. `/root/scan_0` |
| Wait | returns the final message | mailbox signal only; read statuses from `list_agents` |
| Concurrency cap | `agent_max_threads` | `max_concurrent_threads_per_session`, default 4 **including root** |
| Message transport | plain user message | `agent_message` item, encrypted by default |
| Extra tools | — | `followup_task`, `interrupt_agent`, agent-path hierarchy |

Which backend you get is decided by **model metadata, not local config** — the model catalog
carries `multi_agent_version` per model. `vendor/models.json` here is a verbatim copy of the one
the runtime bundles; refresh it if your runtime ships a newer catalog.

### Pinning to v1

No feature flag can force v1: `multi_agent_version_override()` only yields V2 or Disabled. The one
lever is `model_catalog_json`, which replaces the process catalog. That is what `v1-forced` does.

```bash
./run.sh demos/00_probe.js v1-forced        # any model, always v1
```

`run.sh` regenerates the catalog on every run via `runner/make_catalog.py`, deriving it from
`vendor/models.json` and rewriting `v2` to `v1`. It is derived rather than checked in as a second
copy, so refreshing `vendor/models.json` is enough to pick up a new model instead of having to
hand-edit a pinned catalog too. Models marked `disabled` are left alone — that opt-out is
deliberate.

Same model, different profiles:

| profile | backend | agent tools | total tools |
|---|---|---|---|
| `v1` | none (model says v2, so v2 tools are `DirectModelOnly`) | 0 | 8 |
| `v1-forced` | v1 | 5 | 13 |
| `v2` | v2 | 6 | 14 |
| `full` | v1 (pinned like `v1-forced`) | 5 | 20 |

**That first row depends on the model, not the profile.** In the bundled catalog only
`gpt-5.6-sol` and `gpt-5.6-terra` carry `multi_agent_version: v2`; `gpt-5.6-luna` is already v1.
So with luna the plain `v1` profile resolves to v1 and hands code mode 5 agent tools, and
`v1-forced` is a no-op for it — measured, both ways:

```
./run.sh demos/06_capability_matrix.js v1                       # backend v1, 5 agent tools
./run.sh demos/06_capability_matrix.js v1 --model gpt-5.6-sol   # backend null, 0 agent tools
```

Which is the point of demo 6: the table is a snapshot of one model on one catalog, and the probe
is the only thing that answers for yours.

`full` differs from the others by *tool surface* rather than backend: it opens the optional
groups the later demos need — memories (which takes two switches, not one), the clock, the token
budget and the permission tool. Demo 6 prints the resulting matrix. Writes additionally need a
writable sandbox, which is env-driven:

```bash
CODEX_DEMO_SANDBOX=workspace-write ./run.sh demos/08_file_and_image.js full
```

v1 is the more stable base: plain-text transport, `wait_agent` returns results directly, and it
ignores `non_code_mode_only`. It is also the quieter of the two upstream — v2 is where the churn
is — so a program written against v1 keeps working for longer.

## Gotchas encoded here

Each of these cost a debugging cycle; the prelude and demos now handle them.

1. **v1 multi-target `wait_agent` re-reports the first finisher.** Collecting N results needs N
   single-target waits, not one N-target wait.
2. **v2 `spawn_agent` returns a fully-qualified `task_name`.** Matching it against `list_agents` by
   appending a `/` prefix silently never matches — five agents finish and nothing is collected.
3. **Shell failures look like data.** A failed `ls` prints diagnostics on the same channel; without a
   validator those strings become "folder names" and get fed to subagents, which will cheerfully
   summarize them. Hence `shellLines(..., {validate})`.
4. **The default `exec` yield is 10s.** Anything longer needs a `// @exec: {"yield_time_ms": ...}`
   pragma on line 1 (the runner keeps it there).
5. **v2's cap counts the root thread.** The default of 4 leaves room for only 3 subagents.
6. **Nested tool calls are serialized unless the tool opts in.** `ToolExecutor::supports_parallel_
   tool_calls()` defaults to `false`, and non-parallel tools take a write lock on a shared gate.
   `wait_agent` and `spawn_agent` do not opt in, so `Promise.race` over several waits does not
   actually stream — demo 5 measures this. Only `exec_command`, `write_stdin`, `shell_command`,
   `view_image`, `tool_search`, `web_search` and the MCP resource tools are parallel-safe.
7. **`model_catalog_json` must precede every `[table]`** in the config, or TOML folds it into that
   table and parsing fails.
8. **`exec_command` hands back a `session_id` only with `tty: true`.** Without a PTY, stdin is an
   empty pipe, so a command that reads it takes EOF immediately and exits — you get an `exit_code`
   where you expected a session, and `write_stdin` has nothing to write to.
9. **Empty-write polling clamps `yield_time_ms` up to 5000ms.** Asking for less is not an error and
   is not reported; the calls simply land 5s apart. Non-empty writes default to 250ms.
10. **A command failing is not the tool failing.** `exec_command` returns `ok` for a command that
    exited non-zero, with the diagnostics in `output` on the same channel as real data. The judge
    is `exit_code`, never the text.
11. **The exec policy rejects commands by content, independently of the sandbox.** `rm -rf` is
    refused ("rm -f style commands are not permitted") even under `danger-full-access`; `rm -r` on
    the same path is allowed.
12. **`memories__list` fails on a store that has never been written to.** The root does not exist
    until the first note, so an empty store reports `path '' was not found` rather than an empty
    listing. Ad hoc notes then land under `extensions/ad_hoc/notes/`, not at the root.
13. **A constraint in a tool description is not a server-side check.** `update_plan` documents "at
    most one `in_progress`" and then accepts two without complaint. Descriptions are written at the
    model; a program that needs the invariant has to enforce it itself.
14. **An agent that errored is still a successful tool call.** The terminal status is a tagged
    union — `{completed}` or `{errored}` — and `wait_agent` returns `ok` either way, with the
    provider's error text sitting where the reply would be. Judging by the tool's status makes an
    unreachable provider look like a backend that behaved as documented: demo 10 used to run to
    completion against a dead endpoint and report `same_agent_twice: true` off two empty lists.
    Every claim drawn from a subagent's answer needs the terminal kind checked first, and a claim
    drawn from an *absence* (no grandchildren, nothing matched) needs it more, not less.
15. **`request_permissions` answers itself under `approval_policy = never`.** It neither hangs nor
    errors: it returns in milliseconds with a JSON *string* (not an object) whose permissions are
    all `null`. Demo 9 still races it against a timeout, because that is host behaviour and another
    client could well block on it — and a blocked non-parallel tool holds the shared write lock,
    stalling every later call.

## Known limitations

- **No resume for yielded cells.** `thread/codeMode/exec` returns whatever the cell produced before
  it yielded, and there is no `thread/codeMode/wait` to resume it. Long programs rely on a large
  `yield_time_ms`. Adding a wait RPC is the obvious next step, and the closest thing to brainary's
  journaled replay.
- **No streaming join.** Because of gotcha 6, results are consumed in wait order rather than
  completion order. v2's any-agent `wait_agent` sidesteps this by needing only one call; porting
  that shape to v1, or opting `wait_agent` into parallel execution, would fix it.
- **Sandbox defaults to read-only, which needs `bwrap` on Linux.** If it is unavailable, pass
  `CODEX_DEMO_SANDBOX=danger-full-access`. The demos only read, but subagents *could* write under
  that setting.
- **`request_user_input` is root-only.** A subagent cannot ask the user a question, and the tool is
  `DirectModelOnly` so code mode cannot call it either. brainary's `poa.ui` has no equivalent here;
  user interaction must be relayed by the root agent.
- **Packaged capabilities are stdio-only and root-only.** A package declares its own MCP servers and
  they are registered on its thread alone. What is still missing is `network` transports, `[build]`,
  resources, and inheritance — a subagent gets its own thread and none of the package's servers.
- **`codex exec --poa` shares exec's flags but not all of its semantics.** It conflicts with a
  prompt and with the `resume` / `review` subcommands, since a PoA run is one cell rather than a
  sampling loop. The remaining exec flags (`--output-schema`, `--output-last-message`) are accepted
  but were not designed for this path.
- **Packing lives in `build.sh`, not in the CLI.** `codex exec --poa <dir>` packs on the fly, and
  `build.sh` covers distribution, so there is no `codex poa pack`. The two implementations agree on
  contents but not necessarily byte-for-byte, since one is the `zip` crate and the other is Python's
  `zipfile`; `build.sh`'s own output is reproducible run to run.
