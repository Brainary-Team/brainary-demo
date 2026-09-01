// Orchestration primitives for code-mode workflows.
//
// The runner prepends this file to every demo, so demos can assume these globals exist.
// Everything here is plain JS on top of the nested `tools` surface -- no host changes.
//
// It exists because the raw multi-agent tools differ between backends and have sharp edges:
//   * v1 `wait_agent` returns the final message, but a multi-target wait keeps returning
//     whichever agent finished first, so collecting N results needs N single-target waits.
//   * v2 `wait_agent` is only a mailbox signal; statuses (with their final text) come from
//     `list_agents`, so collection is a poll loop.
//   * Both backends cap concurrent agents per session; oversubscribing fails the spawn.

const AGENT_BACKEND = (() => {
  const names = new Set(ALL_TOOLS.map((t) => t.name));
  if (names.has("multi_agent_v1__spawn_agent")) return "v1";
  if (names.has("collaboration__spawn_agent")) return "v2";
  return null;
})();

/** Throws with a diagnostic listing when no multi-agent tools reached code mode. */
function requireAgents() {
  if (AGENT_BACKEND) return AGENT_BACKEND;
  throw new Error(
    "no multi-agent tools exposed to code mode; available: " +
      ALL_TOOLS.map((t) => t.name).sort().join(", "),
  );
}

/** Runs `fn` over `items` with at most `limit` in flight. Preserves input order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Spawns one agent. Returns a backend-agnostic handle:
 *   { key, label, meta }
 * `key` is whatever the backend needs for later wait/send/close calls.
 */
async function spawnAgent(message, opts = {}) {
  const backend = requireAgents();
  if (backend === "v1") {
    const a = await tools.multi_agent_v1__spawn_agent({ message });
    return { key: a.agent_id, label: a.nickname || a.agent_id, meta: opts.meta };
  }
  const taskName = String(opts.name || `task_${Math.floor(Date.now() % 1e6)}`).replace(
    /[^A-Za-z0-9_]/g,
    "_",
  );
  const a = await tools.collaboration__spawn_agent({ task_name: taskName, message });
  return { key: a.task_name, label: a.task_name, meta: opts.meta };
}

/** Spawns many agents with bounded concurrency. `specs` is [{message, name?, meta?}]. */
async function spawnMany(specs, concurrency = 3) {
  return mapLimit(specs, concurrency, (spec, i) =>
    spawnAgent(spec.message, { name: spec.name || `task_${i}`, meta: spec.meta }),
  );
}

const _isFinalStatus = (status) =>
  status && typeof status === "object" && ("completed" in status || "errored" in status);

/**
 * Waits for every handle to reach a final state.
 * Returns a Map keyed by handle.key -> final message string (or null).
 */
async function collectAll(handles, timeoutMs = 300000, pollMs = 15000) {
  const backend = requireAgents();
  const replies = new Map();

  if (backend === "v1") {
    // One target per wait: a multi-target wait re-reports the first finisher.
    for (const h of handles) {
      const outcome = await tools.multi_agent_v1__wait_agent({
        targets: [h.key],
        timeout_ms: timeoutMs,
      });
      const status = (outcome.status || {})[h.key] || {};
      replies.set(h.key, status.completed ?? null);
    }
    return replies;
  }

  const deadline = Date.now() + timeoutMs;
  while (replies.size < handles.length && Date.now() < deadline) {
    const listed = await tools.collaboration__list_agents({});
    for (const entry of listed.agents || []) {
      const match = handles.find(
        (h) => entry.agent_name === h.key || entry.agent_name.endsWith(`/${h.key}`),
      );
      if (match && !replies.has(match.key) && _isFinalStatus(entry.agent_status)) {
        replies.set(match.key, entry.agent_status.completed ?? null);
      }
    }
    if (replies.size >= handles.length) break;
    await tools.collaboration__wait_agent({ timeout_ms: pollMs });
  }
  for (const h of handles) if (!replies.has(h.key)) replies.set(h.key, null);
  return replies;
}

/** Convenience: spawn a batch, wait for all, return [{handle, reply}] in input order. */
async function runBatch(specs, { concurrency = 3, timeoutMs = 300000 } = {}) {
  const handles = await spawnMany(specs, concurrency);
  const replies = await collectAll(handles, timeoutMs);
  return handles.map((h) => ({ handle: h, reply: replies.get(h.key) ?? null }));
}

/**
 * Sends a follow-up to a live agent and waits for the *new* answer.
 * v1 `wait_agent` returns immediately when the agent is already final, so the previous
 * reply is remembered and polled past.
 */
async function sendAndWait(handle, message, { timeoutMs = 180000, pollMs = 3000 } = {}) {
  const backend = requireAgents();
  const before = (await collectAll([handle], 1000)).get(handle.key) ?? null;

  if (backend === "v1") {
    await tools.multi_agent_v1__send_input({ target: handle.key, message });
  } else {
    await tools.collaboration__followup_task({ target: handle.key, message });
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = (await collectAll([handle], pollMs)).get(handle.key) ?? null;
    if (now !== null && now !== before) return now;
  }
  return null;
}

/** Best-effort shutdown; never throws. */
async function closeAll(handles) {
  if (AGENT_BACKEND !== "v1") return;
  await Promise.all(
    handles.map((h) => tools.multi_agent_v1__close_agent({ target: h.key }).catch(() => null)),
  );
}

/** Pulls the first JSON object out of an agent reply. Returns {value, error}. */
function parseJsonReply(raw) {
  if (typeof raw !== "string") return { value: null, error: "agent produced no final message" };
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { value: null, error: "no JSON object in reply" };
  try {
    return { value: JSON.parse(match[0]), error: null };
  } catch (err) {
    return { value: null, error: String(err) };
  }
}

/** Runs a shell command and returns trimmed stdout lines, rejecting failed runs. */
async function shellLines(cmd, { validate = null } = {}) {
  const res = await tools.exec_command({ cmd });
  const lines = String(res.output || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // A failed shell prints diagnostics on the same channel; without a filter those
  // become "data" and flow straight into agent prompts.
  return validate ? lines.filter(validate) : lines;
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

// ---------------------------------------------------------------------------
// Capability probing
//
// Everything above assumes the tools it calls are present. Demos 06+ deliberately reach for the
// optional groups -- memories, clock, MCP, the provider-gated ones -- where "not configured in
// this profile" is a normal outcome rather than a bug. Without these, a demo that touches an
// optional tool either crashes on `tools.x is not a function` or has to hand-roll the same
// try/catch around every call.
// ---------------------------------------------------------------------------

const _TOOL_NAMES = new Set(ALL_TOOLS.map((t) => t.name));

/** True when `name` reached code mode under this profile, model and provider. */
function hasTool(name) {
  return _TOOL_NAMES.has(name);
}

/**
 * Calls a nested tool without letting an absent or failing tool end the program.
 * Never throws. Returns:
 *   { name, status: "ok" | "absent" | "error", value, error, ms }
 *
 * `args` is passed through verbatim, so a freeform tool takes a string rather than an object
 * (`callTool("apply_patch", "*** Begin Patch\n...")`).
 */
async function callTool(name, args = {}) {
  if (!hasTool(name)) {
    return { name, status: "absent", value: null, error: "not in ALL_TOOLS", ms: 0 };
  }
  const t0 = Date.now();
  try {
    return { name, status: "ok", value: await tools[name](args), error: null, ms: Date.now() - t0 };
  } catch (err) {
    // A failing nested tool surfaces in JS as a thrown exception, not an error return.
    return { name, status: "error", value: null, error: String(err), ms: Date.now() - t0 };
  }
}

/**
 * Describes a runtime value structurally, e.g. `object{output: string, exit_code: number}`.
 * The tools declared `Promise<unknown>` promise no shape at all, so the only way to learn one
 * is to look at what actually came back.
 */
function shapeOf(value, depth = 1) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "array(0)";
    return depth <= 0
      ? `array(${value.length})`
      : `array(${value.length}) of ${shapeOf(value[0], depth - 1)}`;
  }
  const type = typeof value;
  if (type !== "object") return type;
  const keys = Object.keys(value).sort();
  if (keys.length === 0) return "object{}";
  if (depth <= 0) return `object{${keys.join(", ")}}`;
  return `object{${keys.map((k) => `${k}: ${shapeOf(value[k], depth - 1)}`).join(", ")}}`;
}

/** Runs `fn`, reporting wall time alongside its outcome. Never throws. */
async function timed(fn) {
  const t0 = Date.now();
  try {
    return { ok: true, value: await fn(), error: null, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, value: null, error: String(err), ms: Date.now() - t0 };
  }
}
