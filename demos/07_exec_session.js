// @exec: {"yield_time_ms": 180000, "max_output_tokens": 30000}
//
// DEMO 7 -- exec sessions and real parallelism: the part of the work that needs no agents.
//
// profile: any (exec_command / write_stdin are default tools)
// cwd:     any
// subagents: none
//
// Demo 5 is a negative result: the subagent waits do not declare themselves parallel-safe, so
// Promise.race cannot hand back whichever finished first. This one is its positive counterpart --
// exec_command does declare parallel safety, so Promise.all really is concurrent. Same JavaScript,
// different tool, opposite conclusion: what runs in parallel is decided by the handler you call,
// not by how you write the JS.
//
// Five things:
//   1. One-shot command vs session: when you get an exit_code, when you get a session_id
//   2. Multi-turn interaction over write_stdin, with session state (variables, cwd) surviving turns
//   3. Empty-write polling: write nothing, just collect whatever output appeared in the meantime
//   4. Measured parallel vs serial wall time
//   5. How max_output_tokens actually truncates (the item the docs mark "not measured")

const t0 = Date.now();
const log = [];
const out = {};

// ---------------------------------------------------------------------------
// 1. One-shot command vs session
//
// One tool, two return shapes. What decides is not an argument but whether the process finished
// inside yield_time_ms:
//   finished     -> exit_code, no session_id
//   still going  -> session_id, no exit_code, and the output so far
// ---------------------------------------------------------------------------

const oneShot = await callTool("exec_command", { cmd: "printf 'a\\nb\\nc\\n'" });
out.one_shot = {
  status: oneShot.status,
  exit_code: oneShot.value && oneShot.value.exit_code,
  has_session_id: Boolean(oneShot.value && oneShot.value.session_id),
  output: oneShot.value && oneShot.value.output,
};

// tty: true is the precondition for getting a session. Without a PTY, stdin is an empty pipe, so
// an interactive shell reads EOF immediately and exits -- you get an exit_code instead of a
// session_id, and every step below has nothing to work with.
const shell = await callTool("exec_command", {
  cmd: "PS1='' exec sh -i", // PS1='' keeps the prompt out of the output; exec saves a wrapper process
  tty: true,
  yield_time_ms: 500,
});
const sessionId = shell.value && shell.value.session_id;
out.session_open = {
  status: shell.status,
  session_id_type: typeof sessionId,
  has_exit_code: Boolean(shell.value && shell.value.exit_code !== undefined),
};

if (typeof sessionId !== "number") {
  text(JSON.stringify({ demo: "exec_session", error: "no session_id", detail: out }, null, 2));
  exit();
}
log.push(`session ${sessionId} opened in ${shell.value.wall_time_seconds.toFixed(2)}s`);

// ---------------------------------------------------------------------------
// 2. Multi-turn interaction, with state surviving between turns
//
// This is the whole value of a session over one-shot commands: the second turn can read the
// variable the first one set. Two independent exec_command calls would give the second one a
// brand new shell, where X does not exist.
// ---------------------------------------------------------------------------

// Every turn has to carry its own newline -- the shell reads by line, and a missing \n leaves it
// waiting forever (which shows up as empty output).
const send = async (chars, yieldMs = 700) =>
  callTool("write_stdin", { session_id: sessionId, chars, yield_time_ms: yieldMs });

const turns = [];
for (const [label, line] of [
  ["set", "X=41\n"],
  ["use", "echo $((X+1))\n"],       // reading back 41 is what proves the state is still there
  ["cd", "cd /tmp && pwd\n"],
  ["still-there", "echo still:$X at:$(pwd)\n"], // cwd is part of session state too
]) {
  const r = await send(line);
  turns.push({
    turn: label,
    sent: line.trim(),
    // A PTY echoes input, so output holds both the line you typed and the command's result.
    output: r.value && String(r.value.output || "").replace(/\r/g, ""),
    error: r.error || undefined,
  });
}
out.turns = turns;
const useTurn = turns.find((t) => t.turn === "use");
out.state_survives_turns = Boolean(useTurn && /42/.test(useTurn.output || ""));

// ---------------------------------------------------------------------------
// 3. Empty-write polling
//
// Omitting chars means: write nothing, just collect the output that appeared in the meantime.
// Useful for following a process that produces output slowly.
//
// Note that yield_time_ms has a FLOOR OF 5000ms on this branch (a non-empty write defaults to
// 250ms with a 30000ms ceiling; an empty poll is 5000-300000ms). Asking for less is not an error,
// it is silently raised to 5s -- the gap between adjacent at_ms values in polls below is that
// floor, measured.
// ---------------------------------------------------------------------------

await send("for i in $(seq 1 12); do echo tick $i; sleep 1; done\n", 250); // get it running first
const polls = [];
for (let i = 0; i < 3; i++) {
  const r = await callTool("write_stdin", { session_id: sessionId, yield_time_ms: 1800 });
  polls.push({
    at_ms: Date.now() - t0,
    requested_yield_ms: 1800, // actually raised to 5000
    new_output: r.value && String(r.value.output || "").replace(/\r/g, "").trim(),
  });
}
out.polls = polls;
out.poll_note =
  "each poll returns only the output added since the last one, not a replay from the start; " +
  "the gap between adjacent at_ms values is ~5000ms, which is the floor";

// Close the session: exit lets the shell finish on its own, so the last read carries an exit_code.
const closed = await send("exit\n", 800);
out.session_close = {
  exit_code: closed.value && closed.value.exit_code,
  note: "exit_code only appears once the process has ended; until then it is undefined",
};

// ---------------------------------------------------------------------------
// 4. Parallel vs serial
//
// exec_command's handler declares supports_parallel_tool_calls(), so the three sleeps really do
// overlap. A tool that does not declare it takes a shared write lock, and no other tool call can
// go out for the duration -- which is exactly the shape demo 5 runs into.
// ---------------------------------------------------------------------------

const SLEEPS = [2, 2, 2];

const parallel = await timed(() =>
  Promise.all(SLEEPS.map((s, i) => callTool("exec_command", { cmd: `sleep ${s}; echo done${i}` }))),
);

const serial = await timed(async () => {
  const results = [];
  for (const [i, s] of SLEEPS.entries()) {
    results.push(await callTool("exec_command", { cmd: `sleep ${s}; echo done${i}` }));
  }
  return results;
});

const sumSecs = SLEEPS.reduce((a, b) => a + b, 0);
out.parallelism = {
  sleeps_seconds: SLEEPS,
  parallel_ms: parallel.ms,
  serial_ms: serial.ms,
  // In parallel the total should land near the slowest one (2s), not the sum of the three (6s).
  parallel_is_max_not_sum: parallel.ms < (sumSecs - 1) * 1000,
  speedup: Number((serial.ms / Math.max(parallel.ms, 1)).toFixed(2)),
  note: "compare demos/05: the same Promise code degrades to serial once the tool is wait_agent, which declares no parallel safety",
};
log.push(`parallel ${parallel.ms}ms vs serial ${serial.ms}ms`);

// ---------------------------------------------------------------------------
// 5. How max_output_tokens truncates
//
// The docs mark this one "not measured". Give it a tiny budget, run a command with a large
// output, and look at what survives in the return value: how short output gets cut, and whether
// original_token_count reports the pre-truncation size.
// ---------------------------------------------------------------------------

const big = "seq 1 4000";
const untruncated = await callTool("exec_command", { cmd: big });
const truncated = await callTool("exec_command", { cmd: big, max_output_tokens: 64 });
out.truncation = {
  budget_default: {
    output_chars: untruncated.value && String(untruncated.value.output || "").length,
    original_token_count: untruncated.value && untruncated.value.original_token_count,
  },
  budget_64: {
    output_chars: truncated.value && String(truncated.value.output || "").length,
    original_token_count: truncated.value && truncated.value.original_token_count,
    head: truncated.value && String(truncated.value.output || "").slice(0, 100),
    tail: truncated.value && String(truncated.value.output || "").slice(-40),
    // The elision marker left behind, of the form "…4660 tokens truncated…" (inserted in place,
    // on the same line)
    elision:
      truncated.value &&
      (String(truncated.value.output || "").match(/…[^…]*truncated…/) || [null])[0],
  },
  // Measured (the docs mark this one "not measured"):
  //   - BOTH head and tail survive; what gets dropped is the middle -- not a plain tail chop
  //   - Two lines are prepended: "Warning: truncated output (original token count: N)" and
  //     "Total output lines: M"
  //   - "…N tokens truncated…" is inserted in place at the elision point
  //   - original_token_count reports the PRE-truncation size, so it reads the same either way
  //   - under the default 10000-token budget, seq 1 4000 (~4700 tokens) does not truncate at all
  note: "head and tail both kept, middle elided; two metadata lines prepended; original_token_count is the pre-truncation size",
};

text(
  JSON.stringify(
    { demo: "exec_session", backend: AGENT_BACKEND, elapsed_ms: Date.now() - t0, ...out, log },
    null,
    2,
  ),
);
