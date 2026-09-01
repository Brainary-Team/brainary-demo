// @exec: {"yield_time_ms": 120000, "max_output_tokens": 30000}
//
// DEMO 9 -- the tools that carry state: memories, clock, goal, plan, context budget, permissions.
//
// profile: full (each group sits behind its own feature gate; under the other profiles most of
//          them are simply absent)
// cwd:     any
// subagents: none
//
// Every tool so far has been ask-once-answer-once. These are not: memories reach disk and survive
// across sessions, goal is a state machine (create_goal fails outright while an unfinished goal
// exists), and update_plan documents an "at most one in_progress" constraint. A program that uses
// them has to know these state rules first.
//
// It also shows one real composition between tools: memories__add_ad_hoc_note requires a filename
// of the form YYYY-MM-DDTHH-MM-SS-<slug>.md, and that timestamp is exactly what clock__curr_time
// hands back.

const t0 = Date.now();
const out = {};

// ---------------------------------------------------------------------------
// 1. Clock: what clock__curr_time gives you that Date.now() does not
//
// Date.now() exists inside the sandbox (which is also why re-running the same program can differ,
// with no log to reproduce from). The value of clock__curr_time is not "being able to read the
// time" but that it reads the HOST's UTC clock -- the same one the subagents see.
// ---------------------------------------------------------------------------

const clock = await callTool("clock__curr_time", {});
const nowUtc = clock.value && clock.value.current_time; // "YYYY-MM-DD HH:MM:SS UTC"
out.clock = {
  status: clock.status,
  current_time: nowUtc,
  js_date_now: t0,
  note: "on the JS side Date.now() is enough for a timestamp; this tool is only needed to share one UTC clock with the subagents",
};

// ---------------------------------------------------------------------------
// 2. Memories: write -> list -> read -> search
//
// The four tools need [features] memories AND [memories] dedicated_tools turned on TOGETHER;
// turning on only one yields zero memory tools rather than half of them.
//
// Note the state before the first write: the root does not exist, so list / search report
// "path '' was not found". It reads like a bad argument but means "the store is still empty"
// (those two error lines in demos/06 are this).
// ---------------------------------------------------------------------------

const before = await callTool("memories__list", {});
const nMatches = (r) => ((r.value && r.value.matches) || []).length;

// The filename format is a hard requirement: YYYY-MM-DDTHH-MM-SS-<slug>.md, where slug may only
// contain lowercase letters, digits and hyphens. Built from the host clock read above -- one real
// composition of two tools.
const stamp = (nowUtc || "")
  .replace(" UTC", "")
  .replace(" ", "T")
  .replace(/:/g, "-");
const filename = `${stamp}-poa-demo-note.md`;

// The note carries two markers: one identical on every run (so accumulation is visible) and one
// stamped with this run (unique to it). The three searches below use both to demonstrate what
// match_mode actually means, rather than just reporting a number.
const runMarker = `poa-run-${stamp}`;
const added = await callTool("memories__add_ad_hoc_note", {
  filename,
  note:
    "# PoA demo\n\nWritten by demos/09 to exercise the four memory tools.\n" +
    `marker: poa-demo-marker\nrun: ${runMarker}\n`,
});

// list returns only DIRECT children, and an ad hoc note does not land at the root: its real path
// is extensions/ad_hoc/notes/<filename>. Looking for it at the root gives an empty result rather
// than an error -- which is exactly why memories__list has to be walked level by level.
const after = await callTool("memories__list", {});
const rootEntries = (after.value && after.value.entries) || [];

const NOTES_DIR = "extensions/ad_hoc/notes";
const notes = await callTool("memories__list", { path: NOTES_DIR, max_results: 50 });
const noteEntries = (notes.value && notes.value.entries) || [];
// Match on the FULL filename, not a fuzzy prefix: every run of this demo adds another note
// sharing the same prefix, so includes would hit the previous one and read_back would prove
// nothing about this run's write.
const mine = noteEntries.find((e) => e.path && e.path.endsWith(filename));

const readBack = mine
  ? await callTool("memories__read", { path: mine.path })
  : { status: "skipped", error: `note just written was not found under ${NOTES_DIR}`, value: null };

// Search: queries is an array of substrings, and match_mode decides whether several substrings
// mean "any of them hits" or "all of them must co-occur close together". The three calls below
// are a controlled comparison with the expected value written down for each -- a single matches
// count proves nothing about the semantics (an earlier version had two of them both bump into
// max_results and return 5, which made them indistinguishable).
//
//   any          : the shared marker -> every past run's note hits, growing with each run
//   all (positive): shared marker + this run's marker, within a few lines -> only this note can match
//   all (negative): plus a term that cannot exist -> 0, proving it really is co-occurrence and has
//                   not degraded into any
const searchAny = await callTool("memories__search", {
  queries: ["poa-demo-marker"],
  max_results: 50,
});
const searchAll = await callTool("memories__search", {
  queries: ["poa-demo-marker", runMarker],
  match_mode: { type: "all_within_lines", line_count: 5 },
  max_results: 50,
});
const searchAllMiss = await callTool("memories__search", {
  // This second term must be a guaranteed miss for the negative control to mean anything --
  // it appears in no note this demo writes, and in nothing else under the store.
  queries: ["poa-demo-marker", "no-note-contains-this-phrase-zzz"],
  match_mode: { type: "all_within_lines", line_count: 5 },
  max_results: 50,
});

out.memories = {
  // On the very first run (empty store) this is an error, "path '' was not found"; after one run
  // it becomes ok. Both are normal -- the only difference is whether this machine has ever
  // written a memory before.
  before_first_write: { status: before.status, error: before.error || undefined },
  wrote: {
    filename,
    status: added.status,
    returned: shapeOf(added.value),
    error: added.error || undefined,
  },
  after_write: {
    status: after.status,
    root_entries: rootEntries, // the root holds only extensions/; the note is not at this level
    notes_dir: NOTES_DIR,
    notes_count: noteEntries.length,
    my_entry: mine || null,
    // Cross-session evidence: run this demo again and notes_count goes up by one. store()/load()
    // does not.
    persistence_note: "notes_count rises by one per run -- that is the line between long-term memory and store()/load()",
  },
  read_back: {
    status: readBack.status,
    shape: shapeOf(readBack.value),
    first_line: readBack.value ? String(readBack.value.content || "").split("\n")[0] : undefined,
    error: readBack.error || undefined,
  },
  search: {
    // Expect: >= the number of times this demo has run on this machine (one note per run)
    any: {
      status: searchAny.status,
      matches: nMatches(searchAny),
      truncated: searchAny.value && searchAny.value.truncated,
    },
    // Expect: exactly 1 -- the second term exists only in this run's note
    all_within_lines: { status: searchAll.status, matches: nMatches(searchAll) },
    // Expect: exactly 0
    all_within_lines_miss: {
      status: searchAllMiss.status,
      matches: nMatches(searchAllMiss),
    },
    semantics_confirmed:
      nMatches(searchAll) === 1 && nMatches(searchAllMiss) === 0 && nMatches(searchAny) >= 1,
  },
};

// Where it lands: memories are LONG-TERM, surviving a change of session -- that is the line
// between them and store()/load(). Looking directly inside $CODEX_HOME below proves they really
// are on disk and not just a table held in the process.
const onDisk = await callTool("exec_command", {
  cmd: 'find "$CODEX_HOME/memories" -type f 2>&1 | tail -3',
});
out.memories.on_disk = String((onDisk.value && onDisk.value.output) || "").trim();
out.memories.note =
  "stored under $CODEX_HOME/memories and survives across sessions; store()/load() is program-private, invisible to the model, and gone when the process ends";

// ---------------------------------------------------------------------------
// 3. Goal: a state machine
//
// create_goal fails while an unfinished goal exists, so the order is read -> create -> read ->
// complete -> read. This group is of little use in PoA (a program keeps state in ordinary
// variables), and is here to pin down the state rules.
// ---------------------------------------------------------------------------

const goalTrace = [];
const snapGoal = async (label) => {
  const g = await callTool("get_goal", {});
  goalTrace.push({
    at: label,
    status: g.status,
    goal: g.value && g.value.goal,
    shape: shapeOf(g.value),
  });
  return g;
};

await snapGoal("before-create");
const created = await callTool("create_goal", {
  objective: "demonstrate the goal tool's state machine (created by demos/09)",
  token_budget: 5000,
});
await snapGoal("after-create");

// Creating a second goal while one is unfinished: expect failure. The rule is stated in the tool
// description; this runs it.
const secondGoal = await callTool("create_goal", { objective: "second goal, expected to be refused" });

const completed = await callTool("update_goal", { status: "complete" });
await snapGoal("after-complete");

out.goal = {
  create: {
    status: created.status,
    returned: shapeOf(created.value),
    error: created.error || undefined,
  },
  create_while_active: {
    status: secondGoal.status, // expect error
    error: secondGoal.error ? String(secondGoal.error).slice(0, 160) : undefined,
  },
  complete: { status: completed.status, returned: shapeOf(completed.value) },
  trace: goalTrace,
};

// ---------------------------------------------------------------------------
// 4. Plan: at most one in_progress at a time
//
// The tool description states the constraint but not what happens if you break it. Running it
// once settles whether it is refused or quietly accepted.
// ---------------------------------------------------------------------------

const legalPlan = await callTool("update_plan", {
  explanation: "legal: exactly one step in_progress",
  plan: [
    { step: "one", status: "completed" },
    { step: "two", status: "in_progress" },
    { step: "three", status: "pending" },
  ],
});
const illegalPlan = await callTool("update_plan", {
  explanation: "violation: two steps in_progress at once",
  plan: [
    { step: "one", status: "in_progress" },
    { step: "two", status: "in_progress" },
  ],
});
out.plan = {
  legal: { status: legalPlan.status, returned: shapeOf(legalPlan.value) },
  two_in_progress: {
    status: illegalPlan.status,
    error: illegalPlan.error ? String(illegalPlan.error).slice(0, 160) : undefined,
    // Measured: status is ok. "At most one in_progress" in the tool description is a convention
    // written at the model, not a server-side check. A program that needs the invariant has to
    // enforce it itself on the JS side.
    note: "measured: silently accepted (status=ok), not refused; the constraint lives only in the description, with no server-side validation",
  },
};

// ---------------------------------------------------------------------------
// 5. Context budget
//
// Read this number carefully in a PoA setting: it describes THIS thread's context window, and the
// intermediate tool outputs never enter that context (only what text() hands back does). So under
// PoA it usually barely moves.
// ---------------------------------------------------------------------------

const ctxBefore = await callTool("get_context_remaining", {});
const noise = await callTool("exec_command", { cmd: "seq 1 2000" }); // produce a large tool output
const ctxAfter = await callTool("get_context_remaining", {});
out.context = {
  before: ctxBefore.value && ctxBefore.value.tokens_left,
  after: ctxAfter.value && ctxAfter.value.tokens_left,
  noise_tokens: noise.value && noise.value.original_token_count,
  note: "tool output stays in the sandbox and never enters the context, so before/after barely differ -- that saving is the point of code mode",
};

// ---------------------------------------------------------------------------
// 6. request_permissions: last, and behind a timeout
//
// It waits for the client to grant permissions. The PoA client does not implement that reverse
// request and approval_policy is never, so it may fail outright or hang indefinitely. If it hangs,
// the shared write lock held by a non-parallel tool stalls every tool call after it -- which is
// why this has to come last and carry its own timeout.
// ---------------------------------------------------------------------------

const permsCall = callTool("request_permissions", {
  permissions: { file_system: { read: ["/tmp"] } },
  reason: "demos/09 probe: what this tool actually does in a PoA setting",
});
const timeoutMs = 8000;
const raced = await Promise.race([
  permsCall,
  new Promise((resolve) => setTimeout(() => resolve({ status: "timeout" }), timeoutMs)),
]);
out.request_permissions = {
  status: raced.status, // ok / error / timeout / absent
  // The return type is Promise<unknown>: print the real shape first, then decide how to parse it
  returned: raced.status === "ok" ? shapeOf(raced.value, 2) : undefined,
  value: raced.status === "ok" ? raced.value : undefined,
  error: raced.error ? String(raced.error).slice(0, 200) : undefined,
  timeout_ms: timeoutMs,
  // Measured: it neither hangs nor errors. Within milliseconds it returns a JSON STRING (not an
  // object):
  //   {"permissions":{"network":null,"file_system":null},"scope":"turn"}
  // So under approval_policy=never it is answered on the spot, with both requested permissions
  // null. The timeout stays anyway: this behaviour is up to the host, and another client really
  // could hang.
  note: "measured: returns a JSON string within milliseconds, permissions all null; the timeout is kept because this depends on the host implementation",
};

text(
  JSON.stringify(
    { demo: "memory_clock_goal", backend: AGENT_BACKEND, elapsed_ms: Date.now() - t0, ...out },
    null,
    2,
  ),
);
