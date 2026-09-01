// @exec: {"yield_time_ms": 120000, "max_output_tokens": 30000}
//
// DEMO 6 -- capability matrix: what this configuration actually lets a program call.
//
// profile: full (the fullest matrix); any profile runs, there are just more absences
// cwd:     any (nothing here depends on repository content)
// subagents: none -- which is what makes it cheap, fast and safe to re-run
//
// The six demos before this one show how to DO things with tools. This one shows how to find out
// which tools are there in the first place.
//
// Why it is needed: ALL_TOOLS on the JS side carries only { name, description } -- no parameter
// schema and no return shape -- and 12 of the 32 tools are declared Promise<unknown>, so not even
// the documentation promises anything. The only reliable way to write PoA is to call once for
// real, print the shape of what came back, and write the parsing against that. This demo turns
// that into a table.
//
// Three rules for reading the result:
//   1. Only read-only, side-effect-free calls are made. Anything with a write side effect
//      (apply_patch / memory writes / spawn_agent) is marked skipped honestly, with a pointer to
//      the demo that does exercise it, rather than being quietly left out.
//   2. absent is a normal result, not a bug -- it means "not present under this profile/provider",
//      and comes with the gate that is missing.
//   3. The unknown column is the most valuable one: names that appear in ALL_TOOLS but that this
//      demo does not recognise. After a provider change or an upstream addition, it tells you
//      first.

const t0 = Date.now();
const log = [];

// ---------------------------------------------------------------------------
// I. Global primitives (12 of them; not on tools, called directly)
// ---------------------------------------------------------------------------

const GLOBAL_NAMES = [
  "text", "image", "audio", "generatedImage", "store", "load",
  "notify", "setTimeout", "clearTimeout", "ALL_TOOLS", "exit", "yield_control",
];

// Presence: which ones the sandbox injected. An absence means a different host version, and the
// later demos that use it will simply crash.
const globalsPresent = Object.fromEntries(
  GLOBAL_NAMES.map((n) => [n, typeof globalThis[n] !== "undefined"]),
);

// Standard globals that were removed: confirm they really are gone (measuring the sandbox surface
// rather than copying the docs).
const removedGlobals = ["console", "Atomics", "SharedArrayBuffer", "WebAssembly", "fetch", "require"]
  .filter((n) => typeof globalThis[n] === "undefined");

// store / load: a write and read inside one cell. Note this does NOT prove survival across execs
// -- the runner sends a single cell per run, so under PoA it is effectively an ordinary global.
store("poa_probe", { written_at: t0 });
const loadedBack = load("poa_probe");

// setTimeout / clearTimeout: these two are the entire timer capability inside the sandbox.
const sleepStart = Date.now();
await new Promise((resolve) => setTimeout(resolve, 120));
const sleptMs = Date.now() - sleepStart;

let clearTimeoutWorks = true;
const doomed = setTimeout(() => { clearTimeoutWorks = false; }, 30);
clearTimeout(doomed);
await new Promise((resolve) => setTimeout(resolve, 80)); // wait past the moment it should have fired

// notify: the call goes through, but the PoA client never receives it (rpc_client handles only
// responses and reverse requests; notifications are dropped).
notify("demo 06: this notification will not appear in run.sh's output");

// Two are deliberately not called: exit() would end this run on the spot, and after
// yield_control() hands over the first half there is no wait RPC to pick up the rest -- either
// way this table would never be delivered.
const globalsNotCalled = {
  exit: "ends this run on the spot (for normal use see the empty-result branches in demos/01 and 02)",
  yield_control: "hands over the accumulated output and the script keeps running, but no wait RPC can pick up the rest, so this table is lost",
  image: "needs a real image, see demos/08",
  audio: "this demo has no audio material",
  generatedImage: "needs image_gen, which is a provider capability -- see the tools table below",
};

// ---------------------------------------------------------------------------
// II. The tool surface
//
// Each entry gives either a call (one real invocation) or a skip (why it is not called, and where
// to look instead). ctx lets a later probe use an earlier probe's result (memories__read needs a
// real path, read_mcp_resource needs a real uri).
// ---------------------------------------------------------------------------

const ctx = {};

// The memories root does not exist at all before the first write, and until then list / search
// report "path '' was not found" -- which reads like a malformed call but means "the store is
// still empty". Write one note (demos/09) and come back, and these two lines turn ok.
const noteEmptyStore = (r) => {
  if (r.status === "error" && /was not found/.test(r.error || "")) {
    r.error += " (the memories store is not initialised yet: the root does not exist before the first write, see demos/09)";
  }
  return r;
};

const PROBES = [
  // ---- exec and files ----
  {
    group: "exec and files",
    name: "exec_command",
    call: () => callTool("exec_command", { cmd: "printf poa" }),
  },
  {
    group: "exec and files",
    name: "write_stdin",
    // Needs a session that is still alive. tty: true is mandatory: without a PTY, stdin is an
    // empty pipe, so a command reading stdin takes EOF immediately and exits -- exec_command then
    // returns an exit_code rather than a session_id, and write_stdin has no session to write to.
    // (Measured; the tool description does not mention this.) Under a PTY, head -c 3 blocks for
    // input; once three bytes arrive it echoes them and exits, leaving no stray process.
    call: async () => {
      const opened = await callTool("exec_command", {
        cmd: "head -c 3",
        tty: true,
        yield_time_ms: 300,
      });
      const sessionId = opened.value && opened.value.session_id;
      if (typeof sessionId !== "number") {
        return { name: "write_stdin", status: "error", value: null, ms: opened.ms,
          error: `exec_command returned no session_id (got ${shapeOf(opened.value)})` };
      }
      return callTool("write_stdin", { session_id: sessionId, chars: "poa" });
    },
  },
  {
    group: "exec and files",
    name: "shell_command",
    // With unified_exec in effect it registers as Hidden, so absent is the expected result here
    // rather than a misconfiguration.
    call: () => callTool("shell_command", { command: "printf poa", workdir: "." }),
  },
  {
    group: "exec and files",
    name: "apply_patch",
    skip: "writes a file (and takes a bare string, not an object), see demos/08",
  },
  { group: "exec and files", name: "view_image", skip: "needs a real image on disk, see demos/08" },

  // ---- plan and goal ----
  {
    group: "plan and goal",
    name: "update_plan",
    call: () => callTool("update_plan", {
      explanation: "capability matrix probe",
      plan: [
        { step: "probe tool surface", status: "in_progress" },
        { step: "report matrix", status: "pending" },
      ],
    }),
  },
  { group: "plan and goal", name: "get_goal", call: () => callTool("get_goal", {}) },
  {
    group: "plan and goal",
    name: "create_goal",
    skip: "creates an active goal, and fails outright while an unfinished one exists, see demos/09",
  },
  { group: "plan and goal", name: "update_goal", skip: "only meaningful with an active goal, see demos/09" },

  // ---- context and permissions ----
  {
    group: "context and permissions",
    name: "get_context_remaining",
    call: () => callTool("get_context_remaining", {}),
  },
  {
    group: "context and permissions",
    name: "request_permissions",
    skip: "waits for the client to grant; demos/09 probes the real behaviour under approval_policy=never, behind a timeout",
  },

  // ---- time ----
  { group: "time", name: "clock__curr_time", call: () => callTool("clock__curr_time", {}) },

  // ---- memories ----
  {
    group: "memories",
    name: "memories__list",
    call: async () => {
      const r = noteEmptyStore(await callTool("memories__list", {}));
      const entries = (r.value && r.value.entries) || [];
      const file = entries.find((e) => e.entry_type === "file");
      if (file) {
        ctx.memory_path = file.path; // for memories__read to use
      } else if (entries.length > 0) {
        // list returns only DIRECT children, and ad hoc notes live under
        // extensions/ad_hoc/notes -- the root shows only directories. Getting a real file path
        // means walking one level deeper.
        const deeper = await callTool("memories__list", {
          path: "extensions/ad_hoc/notes",
          max_results: 1,
        });
        const found = ((deeper.value && deeper.value.entries) || [])[0];
        if (found) ctx.memory_path = found.path;
      }
      return r;
    },
  },
  {
    group: "memories",
    name: "memories__read",
    call: () => (ctx.memory_path
      ? callTool("memories__read", { path: ctx.memory_path, max_lines: 5 })
      : { name: "memories__read", status: "skipped", value: null, ms: 0,
          error: "no file in the memories store yet; write one and read it back, see demos/09" }),
  },
  {
    group: "memories",
    name: "memories__search",
    call: async () =>
      noteEmptyStore(
        await callTool("memories__search", { queries: ["poa"], max_results: 3 }),
      ),
  },
  { group: "memories", name: "memories__add_ad_hoc_note", skip: "writes a note to disk, see demos/09" },

  // ---- subagents v1 / v2 ----
  { group: "subagents v1", name: "multi_agent_v1__spawn_agent", skip: "spawns a subagent, see demos/01-05 and 10" },
  { group: "subagents v1", name: "multi_agent_v1__wait_agent", skip: "needs a live agent, see demos/10" },
  { group: "subagents v1", name: "multi_agent_v1__send_input", skip: "needs a live agent, see demos/10" },
  { group: "subagents v1", name: "multi_agent_v1__resume_agent", skip: "needs a closed agent, see demos/10" },
  { group: "subagents v1", name: "multi_agent_v1__close_agent", skip: "needs a live agent, see demos/10" },
  {
    group: "subagents v2",
    name: "collaboration__list_agents",
    call: () => callTool("collaboration__list_agents", {}), // read-only; returns an empty table when there are no agents
  },
  { group: "subagents v2", name: "collaboration__spawn_agent", skip: "spawns a subagent, see demos/10" },
  { group: "subagents v2", name: "collaboration__wait_agent", skip: "blocks until timeout, see demos/10" },
  { group: "subagents v2", name: "collaboration__send_message", skip: "needs a live agent, see demos/10" },
  { group: "subagents v2", name: "collaboration__followup_task", skip: "needs a live agent, see demos/10" },
  { group: "subagents v2", name: "collaboration__interrupt_agent", skip: "needs a live agent, see demos/10" },

  // ---- MCP ----
  {
    group: "MCP",
    name: "list_mcp_resources",
    call: async () => {
      const r = await callTool("list_mcp_resources", {});
      // The return type is Promise<unknown>, so the field name can only be found by trying:
      // cover both of the common shapes.
      const list = (r.value && (r.value.resources || r.value.contents)) || [];
      if (Array.isArray(list) && list[0]) ctx.mcp_resource = list[0];
      return r;
    },
  },
  {
    group: "MCP",
    name: "list_mcp_resource_templates",
    call: () => callTool("list_mcp_resource_templates", {}),
  },
  {
    group: "MCP",
    name: "read_mcp_resource",
    call: () => (ctx.mcp_resource && ctx.mcp_resource.uri
      ? callTool("read_mcp_resource", {
          server: ctx.mcp_resource.server || ctx.mcp_resource.serverName,
          uri: ctx.mcp_resource.uri,
        })
      : { name: "read_mcp_resource", status: "skipped", value: null, ms: 0,
          error: "no readable resource (no MCP server attached, or it exposes no resources)" }),
  },

  // ---- three that depend on provider capability ----
  { group: "provider-dependent", name: "skills__list", call: () => callTool("skills__list", {}) },
  { group: "provider-dependent", name: "skills__read", skip: "needs a real skill name, look at skills__list first" },
  { group: "provider-dependent", name: "web__run", skip: "would really search the web; this only reports whether it is present" },
];

// Run them one at a time. Serial is deliberate: a tool that is not parallel-safe takes the shared
// write lock, so running concurrently would only make the ms column meaningless.
const rows = [];
for (const probe of PROBES) {
  if (probe.skip) {
    rows.push({
      group: probe.group,
      tool: probe.name,
      // Distinguish "not present under this configuration" from "present but deliberately not
      // called here" -- they point in completely different directions when investigating.
      status: hasTool(probe.name) ? "present_not_called" : "absent",
      why: probe.skip,
    });
    continue;
  }
  // Check presence before deciding to call. Without this step, the hand-written "precondition not
  // met" returns inside the probes (memories__read with no readable file, read_mcp_resource with no
  // resource) would also report skipped when the tool DOES NOT EXIST AT ALL -- and this table would
  // start lying as soon as the profile changed. absent and skipped point opposite ways.
  if (!hasTool(probe.name)) {
    rows.push({ group: probe.group, tool: probe.name, status: "absent", error: "not in ALL_TOOLS" });
    log.push(`${probe.name}: absent`);
    continue;
  }
  const r = await probe.call();
  rows.push({
    group: probe.group,
    tool: probe.name,
    status: r.status,
    ms: r.status === "ok" ? r.ms : undefined,
    // The return shape from one real call. For the 12 tools declared Promise<unknown>, this is the
    // only source of a shape at all.
    shape: r.status === "ok" ? shapeOf(r.value) : undefined,
    error: r.error || undefined,
  });
  log.push(`${probe.name}: ${r.status}${r.status === "ok" ? ` (${r.ms}ms)` : ""}`);
}

// ---------------------------------------------------------------------------
// III. Control: are the ones expected to be unreachable in fact unreachable
//
// These tools exist in a code mode session but cannot be called from PoA. They are here to turn a
// documented conclusion into a measurement: the day any of them turns true, upstream has changed
// either the exposure or the spec-kind decision.
// ---------------------------------------------------------------------------

const EXPECTED_ABSENT = {
  request_user_input: "DirectModelOnly -- the technical reason PoA is unattended end to end",
  new_context: "DirectModelOnly",
  clock__sleep: "DirectModelOnly; to wait, use setTimeout or run sleep through exec_command",
  tool_search: "dropped wholesale by spec kind, independent of exposure -- no configuration lets it in",
};
const unexpectedlyPresent = Object.keys(EXPECTED_ABSENT).filter((n) => hasTool(n));

// ---------------------------------------------------------------------------
// IV. Coverage accounting: does ALL_TOOLS hold a name this demo does not recognise
// ---------------------------------------------------------------------------

const known = new Set(PROBES.map((p) => p.name));
const allNames = ALL_TOOLS.map((t) => t.name).sort();
// How many mcp__<server>__<tool> there are depends on what is attached, so group them by prefix
// rather than naming each one.
const mcpToolNames = allNames.filter((n) => n.startsWith("mcp__"));
const unknownNames = allNames.filter((n) => !known.has(n) && !n.startsWith("mcp__"));

text(
  JSON.stringify(
    {
      demo: "capability_matrix",
      backend: AGENT_BACKEND,
      elapsed_ms: Date.now() - t0,

      globals: {
        present: globalsPresent,
        removed_as_expected: removedGlobals,
        store_load_roundtrip: loadedBack && loadedBack.written_at === t0,
        store_load_note: "a round trip inside one cell; surviving across execs needs the client to send several execs on the same thread",
        set_timeout_slept_ms: sleptMs,
        clear_timeout_works: clearTimeoutWorks,
        notify_note: "called once; the PoA client never receives notifications, so progress is always accumulated through text()",
        not_called: globalsNotCalled,
      },

      tools: {
        total_in_all_tools: allNames.length,
        called_ok: rows.filter((r) => r.status === "ok").length,
        called_error: rows.filter((r) => r.status === "error").length,
        absent: rows.filter((r) => r.status === "absent").length,
        present_not_called: rows.filter((r) => r.status === "present_not_called").length,
        matrix: rows,
      },

      expected_absent: {
        checked: EXPECTED_ABSENT,
        // Expected to be an empty array. Non-empty means upstream moved the exposure or the
        // spec-kind decision.
        unexpectedly_present: unexpectedlyPresent,
      },

      // Tools this demo does not recognise but which do exist. Look here first after changing
      // provider or profile.
      unknown_to_this_demo: unknownNames,
      mcp_tools: mcpToolNames,
      all_tools: allNames,
      log,
    },
    null,
    2,
  ),
);
