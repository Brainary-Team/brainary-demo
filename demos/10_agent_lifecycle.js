// @exec: {"yield_time_ms": 900000, "max_output_tokens": 30000}
//
// DEMO 10 -- the full subagent lifecycle: the raw tools the prelude hides.
//
// profile: v1-forced / full take the v1 branch, v2 takes the v2 branch (the two generations have
//          completely different lifecycle shapes)
// cwd:     any
// subagents: 4-5 short tasks by default; the size constants are below, set them all false to debug
//
// Demos 01-05 use the prelude layer (spawnAgent / collectAll / sendAndWait), which exists to
// flatten the differences between the two backend generations. This one does the opposite: it
// calls the raw tools and exposes what was flattened.
//
// It covers the things the prelude does not wrap, and which therefore never appeared in any
// earlier demo:
//   - v1: resume_agent (a closed agent can be brought back), close_agent's previous_status,
//         interrupt via send_input, the multi-target wait trap, spawn's model / reasoning_effort
//         overrides
//   - v2: interrupt_agent, send_message vs followup_task, list_agents, fork_turns
//   - both: the opposite behaviour on recursion depth (v1 blocks it, v2 does not)

const RUN_MULTI_WAIT_TRAP = true; // measure the multi-target wait (+2 agents)
const RUN_SPAWN_OVERRIDES = true; // the model / reasoning_effort overrides (+1 agent)
const RUN_DEPTH_PROBE = true; // let a subagent try to spawn a grandchild (+1 agent)

const t0 = Date.now();
const log = [];
const out = {};
requireAgents();

// Every subtask uses the same template: keep it very short, decidable, and free of side quests.
// A subagent's system prompt cannot be changed, so message is the program's only control surface.
const tiny = (task, shape) =>
  [task, ``, `Reply with a single line of JSON. No code fences, no explanation:`, shape].join("\n");

// A subagent's terminal status is a tagged union: {completed: string} or {errored: string}. Both
// have the same shape, and callTool's status reports whether the TOOL CALL succeeded -- wait_agent
// reaching an errored agent is still an ok tool call. Reading status alone turns "the model never
// answered at all" into "the backend behaved as expected".
//
// This is not hypothetical: point the provider at an unreachable address and this demo runs to
// completion entirely ok, hands back a pile of empty replies, judges same_agent_twice true (two
// empty arrays are of course equal) and finds v2's grandchildren empty -- so its own report
// refutes the true conclusion that v2 does not block recursion. Hence the terminal status has to
// be read explicitly.
const finalOf = (s) => {
  if (!s || typeof s !== "object") {
    return { kind: typeof s === "string" ? s : "unknown", text: "" };
  }
  if ("completed" in s) return { kind: "completed", text: String(s.completed || "") };
  if ("errored" in s) return { kind: "errored", text: String(s.errored || "") };
  return { kind: Object.keys(s)[0] || "unknown", text: "" };
};

// Every section below rests on subagents actually being able to answer. If the very first probe
// comes back errored, carrying on only produces an empty table that reads like a conclusion --
// better to stop here and say what to go and check.
const bail = (reason, detail) => {
  text(
    JSON.stringify(
      { demo: "agent_lifecycle", backend: AGENT_BACKEND, aborted: reason, detail, ...out },
      null,
      2,
    ),
  );
  exit();
};

// ---------------------------------------------------------------------------
// v1 branch
// ---------------------------------------------------------------------------
if (AGENT_BACKEND === "v1") {
  // ---- 1. Spawn one, wait for it, see what the terminal status looks like ----
  const spawned = await callTool("multi_agent_v1__spawn_agent", {
    message: tiny("Say who you are in one sentence. Do not read any files.", `{"who":"<one sentence>"}`),
  });
  const id = spawned.value.agent_id;
  out.spawn = {
    status: spawned.status,
    returned: shapeOf(spawned.value),
    // nickname comes from the model side and may be null -- so identify agents by meta you keep
    // yourself, never by the label
    nickname: spawned.value.nickname,
  };
  log.push(`spawned ${id}`);

  const waited = await callTool("multi_agent_v1__wait_agent", {
    targets: [id],
    timeout_ms: 180000,
  });
  const status1 = (waited.value.status || {})[id];
  const final1 = finalOf(status1);
  out.first_wait = {
    timed_out: waited.value.timed_out,
    status_shape: shapeOf(status1),
    final_kind: final1.kind, // completed / errored -- the judge is here, not in status
    reply: final1.text.slice(0, 120),
  };
  if (final1.kind !== "completed") {
    bail("the first subagent did not complete, and every section below depends on it being able to answer; check the provider and model are reachable", {
      final_kind: final1.kind,
      detail: final1.text.slice(0, 300),
    });
  }

  // ---- 2. close -> resume: v1 only, and the prelude wraps only close ----
  const closed = await callTool("multi_agent_v1__close_agent", { target: id });
  out.close = {
    status: closed.status,
    // What comes back is the status from BEFORE the close request, not after it
    previous_status: shapeOf(closed.value && closed.value.previous_status),
    note: "a completed agent still holds a concurrency slot until it is closed, so this step cannot be skipped",
  };

  const resumed = await callTool("multi_agent_v1__resume_agent", { id });
  out.resume = {
    status: resumed.status,
    returned: shapeOf(resumed.value),
    error: resumed.error ? String(resumed.error).slice(0, 160) : undefined,
  };

  // Being able to keep talking after the rescue is what makes resume meaningful
  if (resumed.status === "ok") {
    await callTool("multi_agent_v1__send_input", {
      target: id,
      message: tiny("Do you remember what you answered a moment ago? Do not read files.", `{"remembered":<true|false>}`),
    });
    const waited2 = await callTool("multi_agent_v1__wait_agent", { targets: [id], timeout_ms: 180000 });
    const status2 = (waited2.value.status || {})[id];
    const reply2 = status2 && typeof status2 === "object" ? status2.completed : null;
    out.resume.follow_up_reply = String(reply2 || "").slice(0, 160);
    out.resume.works = Boolean(reply2);
    await callTool("multi_agent_v1__close_agent", { target: id });
  }

  // ---- 3. The multi-target wait trap (README gotcha 1) ----
  if (RUN_MULTI_WAIT_TRAP) {
    const fast = await callTool("multi_agent_v1__spawn_agent", {
      message: tiny("Answer immediately. Do not run any commands.", `{"speed":"fast"}`),
    });
    const slow = await callTool("multi_agent_v1__spawn_agent", {
      message: tiny("First run `sleep 25`, then answer once the command has finished.", `{"speed":"slow"}`),
    });
    const targets = [fast.value.agent_id, slow.value.agent_id];

    // Passing two ids means "wait for whichever finishes first". The problem is that the second
    // call REPORTS THE SAME ONE AGAIN, so collecting N results cannot be done with N multi-target
    // waits -- only with N single-target waits.
    const w1 = await callTool("multi_agent_v1__wait_agent", { targets, timeout_ms: 120000 });
    const w2 = await callTool("multi_agent_v1__wait_agent", { targets, timeout_ms: 120000 });
    // Reaching a terminal status counts as "reported", errored included -- the question here is
    // who got reported, not whether the answer was any good.
    const finished = (w) =>
      Object.entries((w.value && w.value.status) || {})
        .filter(([, s]) => ["completed", "errored"].includes(finalOf(s).kind))
        .map(([k]) => (k === targets[0] ? "fast" : "slow"));
    const f1 = finished(w1);
    const f2 = finished(w2);

    out.multi_target_wait = {
      first_call_reports: f1,
      second_call_reports: f2,
      // Expect true: both calls report the same agent, and the slow one is never "waited for".
      // The f1.length term is not redundant: two empty arrays are also equal, and without it this
      // judgement would return a groundless true whenever neither wait reached anything.
      same_agent_twice: f1.length > 0 && JSON.stringify(f1) === JSON.stringify(f2),
      conclusive: f1.length > 0,
      note: "this is why the prelude's collectAll is written as N single-target waits on the v1 branch",
    };

    // Close the slow one before it finishes: close takes its descendants with it
    for (const target of targets) await callTool("multi_agent_v1__close_agent", { target });
  }

  // ---- 4. spawn's override parameters ----
  if (RUN_SPAWN_OVERRIDES) {
    const overridden = await callTool("multi_agent_v1__spawn_agent", {
      message: tiny("Reply with ok and nothing else.", `{"ok":true}`),
      reasoning_effort: "low", // omit to inherit from the parent
      fork_context: false, // do not fork the current thread's history into it
    });
    out.spawn_overrides = {
      status: overridden.status,
      error: overridden.error ? String(overridden.error).slice(0, 200) : undefined,
      note: "there is no system_prompt on the parameter surface: you can pick a role and swap the model, but not change a subagent's system prompt",
    };
    // Try a field that does not exist: v1's struct has no deny_unknown_fields, v2's does
    const bogus = await callTool("multi_agent_v1__spawn_agent", {
      message: tiny("Reply with ok and nothing else.", `{"ok":true}`),
      system_prompt: "You are a pirate", // expect: ignored (v1) rather than an error (v2 errors)
    });
    out.spawn_overrides.unknown_field = {
      status: bogus.status,
      error: bogus.error ? String(bogus.error).slice(0, 160) : undefined,
      note: "v1 has no deny_unknown_fields, so an extra field is silently dropped rather than rejected",
    };
    for (const r of [overridden, bogus]) {
      if (r.value && r.value.agent_id) {
        await callTool("multi_agent_v1__close_agent", { target: r.value.agent_id });
      }
    }
  }

  // ---- 5. Recursion depth: v1 removes the spawn tool from a subagent at the registry level ----
  if (RUN_DEPTH_PROBE) {
    const prober = await callTool("multi_agent_v1__spawn_agent", {
      message: tiny(
        "Check your own tool list for a tool that can spawn subagents (one with spawn_agent in " +
          "its name). If there is one, try to spawn a single agent and report honestly what " +
          "happened; if there is none, just say so. Do not read files.",
        `{"can_spawn":<true|false>,"detail":"<the tool name you saw, or the verbatim error>"}`,
      ),
    });
    const pid = prober.value.agent_id;
    const pw = await callTool("multi_agent_v1__wait_agent", { targets: [pid], timeout_ms: 240000 });
    const pf = finalOf((pw.value.status || {})[pid]);
    out.depth_probe = {
      child_final_kind: pf.kind,
      child_reply: pf.text.slice(0, 240),
      // If the probe itself did not run, "it says it has no spawn_agent" proves nothing
      conclusive: pf.kind === "completed",
      expectation:
        "under v1 agent_max_depth defaults to 1, and a subagent's tool surface has no " +
        "spawn_agent at all; v2 lets it through unconditionally, so the brake has to be applied " +
        "in your own JS",
    };
    await callTool("multi_agent_v1__close_agent", { target: pid });
  }
}

// ---------------------------------------------------------------------------
// v2 branch: the same intent, an entirely different interface
// ---------------------------------------------------------------------------
if (AGENT_BACKEND === "v2") {
  // task_name is required, but what comes back is the FULLY QUALIFIED path (like /root/probe_1).
  // Intuitively prefixing it again before comparing against list_agents matches nothing at all,
  // and raises no error.
  const a = await callTool("collaboration__spawn_agent", {
    task_name: "probe_1",
    message: tiny("Say who you are in one sentence. Do not read files.", `{"who":"<one sentence>"}`),
    fork_turns: "none", // none / all / a positive integer as a string, like "3"
  });
  const name = a.value && a.value.task_name;
  out.spawn = { status: a.status, returned: shapeOf(a.value), fully_qualified: name };

  // wait_agent is only a "something happened" signal and carries no content; the content has to
  // be fetched from list_agents
  const w = await callTool("collaboration__wait_agent", { timeout_ms: 120000 });
  out.wait_signal = { returned: shapeOf(w.value), timed_out: w.value && w.value.timed_out };

  const listed = await callTool("collaboration__list_agents", {});
  const agents = (listed.value && listed.value.agents) || [];
  // Match with endsWith: spawn already returned a fully qualified name, and prefixing it again
  // matches nothing at all -- without raising an error.
  const mine = agents.find((x) => name && x.agent_name.endsWith(name.split("/").pop()));
  const mineFinal = finalOf(mine && mine.agent_status);
  out.list_agents = {
    count: agents.length, // includes root itself
    matched: Boolean(mine),
    // root's status is a plain string ("running"); only a finished subagent gives {completed: ...}
    status_shapes: agents.map((x) => `${x.agent_name}: ${shapeOf(x.agent_status)}`),
    final_kind: mineFinal.kind,
    reply: mineFinal.text.slice(0, 120),
    note: "under v2 this is the only way to get the final reply; wait_agent gives a bare 'something happened' signal with no content",
  };
  if (mineFinal.kind !== "completed") {
    bail("the first subagent did not complete, and every section below depends on it being able to answer; check the provider and model are reachable", {
      final_kind: mineFinal.kind,
      detail: mineFinal.text.slice(0, 300),
    });
  }

  // send_message and followup_task differ only in whether they trigger a new turn
  const sent = await callTool("collaboration__send_message", {
    target: name,
    message: "delivery only, this should not trigger a new turn",
  });
  const follow = await callTool("collaboration__followup_task", {
    target: name,
    message: tiny("Answer once more: do you remember what you said earlier?", `{"remembered":<true|false>}`),
  });
  out.message_vs_task = {
    send_message: { status: sent.status, returned: shapeOf(sent.value) },
    followup_task: { status: follow.status, returned: shapeOf(follow.value) },
    note: "send_message triggers no new turn; followup_task does when the target is idle -- sendAndWait uses the latter under v2",
  };

  // interrupt_agent: cuts the current turn short; the agent itself stays alive and can still
  // receive messages afterwards
  const interrupted = await callTool("collaboration__interrupt_agent", { target: name });
  out.interrupt = {
    status: interrupted.status,
    previous_status: shapeOf(interrupted.value && interrupted.value.previous_status),
    note: "the prelude does not wrap it; this v2 group also has no counterpart to close/resume",
  };

  // Unknown field: v2's parameter struct carries deny_unknown_fields, so inventing one throws
  const bogus = await callTool("collaboration__spawn_agent", {
    task_name: "probe_2",
    message: "Reply with ok and nothing else",
    system_prompt: "You are a pirate",
  });
  out.unknown_field = {
    status: bogus.status, // expect error
    // The error message lists EVERY legal field -- which is the only way to obtain the parameter
    // surface at runtime, since ALL_TOOLS carries name and description but no schema.
    error: bogus.error ? String(bogus.error).slice(0, 220) : undefined,
    note: "v2 carries deny_unknown_fields -- the exact opposite of v1's silent drop",
  };

  // ---- Recursion depth: the opposite of v1, v2 applies neither brake ----
  if (RUN_DEPTH_PROBE) {
    const prober = await callTool("collaboration__spawn_agent", {
      task_name: "depth_probe",
      fork_turns: "none",
      message: tiny(
        "Check your own tool list for a tool that can spawn subagents (one with spawn_agent in " +
          "its name). If there is one, spawn EXACTLY ONE, ask it to answer immediately, then " +
          "report honestly what happened; if there is none, just say so. Do not spawn a second " +
          "one under any circumstances. Do not read files.",
        `{"can_spawn":<true|false>,"detail":"<the tool name you saw, or the verbatim error>"}`,
      ),
    });
    // wait_agent is a mailbox signal for ANY live agent and returns as soon as some other agent
    // stirs -- waiting once and then inspecting the tree will very likely catch this probe before
    // it has started work. It has to be polled until the probe itself reaches a terminal status.
    const deadline = Date.now() + 180000;
    let tree = [];
    let probeFinal = { kind: "timeout", text: "" };
    while (Date.now() < deadline) {
      const after = await callTool("collaboration__list_agents", {});
      const agents = (after.value && after.value.agents) || [];
      tree = agents.map((x) => x.agent_name);
      const me = agents.find((x) => x.agent_name.endsWith("/depth_probe"));
      if (me && typeof me.agent_status === "object") {
        probeFinal = finalOf(me.agent_status);
        break;
      }
      await callTool("collaboration__wait_agent", { timeout_ms: 15000 });
    }
    const grandchildren = tree.filter((n) => n.split("/").length > 3);

    out.depth_probe = {
      spawned: prober.value && prober.value.task_name,
      child_final_kind: probeFinal.kind,
      child_reply: probeFinal.text.slice(0, 240),
      // A /root/depth_probe/<something> appearing means a grandchild really was spawned
      agent_tree: tree,
      grandchildren,
      // An empty grandchildren has two readings: v2 blocked it (false), or the probe never ran at
      // all (true). Without this field, one run against an unreachable provider would let this
      // demo refute its own correct conclusion.
      conclusive: probeFinal.kind === "completed" || grandchildren.length > 0,
      expectation:
        "v1 blocks at both the registry level and at runtime, so a subagent never even sees " +
        "spawn_agent; v2 lets it through unconditionally, with the total agent cap as the only " +
        "backstop -- the brake has to be applied in your own JS",
    };
  }
}

text(
  JSON.stringify(
    { demo: "agent_lifecycle", backend: AGENT_BACKEND, elapsed_ms: Date.now() - t0, ...out, log },
    null,
    2,
  ),
);
