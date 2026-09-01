// @exec: {"yield_time_ms": 900000, "max_output_tokens": 30000}
//
// DEMO 4 -- a subagent as a long-lived, stateful worker.
//
// Spawn one agent, have it read a file, then interrogate it across several turns.
// Later questions depend on earlier answers, and the agent never re-reads the file.
//
// Shows that a subagent is a real conversation, not a one-shot function call: it keeps
// its own history, so the orchestrator can amortize an expensive read across many queries.

const t0 = Date.now();
requireAgents();

// Pick a file with real structure to talk about.
const candidates = await shellLines(
  "ls Cargo.toml package.json pyproject.toml README.md 2>/dev/null",
);
const target = candidates[0];
if (!target) {
  text(JSON.stringify({ error: "no anchor file found in cwd", candidates }));
  exit();
}
notify(`anchor file: ${target}`);

const handle = await spawnAgent(
  [
    `Read ./${target} once, carefully. Keep it in mind for follow-up questions.`,
    `Do not read it again later; answer from memory.`,
    ``,
    `Reply with ONLY one line of JSON:`,
    `{"file":"${target}","loaded":true,"line_count":<int>,"topic":"<what this file is about>"}`,
  ].join("\n"),
  { name: "analyst" },
);

const transcript = [];
const ask = async (label, question) => {
  const reply = await sendAndWait(handle, question);
  const { value, error } = parseJsonReply(reply);
  transcript.push({
    turn: label,
    question,
    answer: value,
    parse_error: error,
    raw: value ? undefined : String(reply ?? "").slice(0, 200),
  });
  notify(`turn ${label} done`);
  return value;
};

// Turn 1: the initial load result.
const loadReplies = await collectAll([handle], 180000);
const loaded = parseJsonReply(loadReplies.get(handle.key) ?? null);
transcript.push({ turn: "load", question: "<initial>", answer: loaded.value, parse_error: loaded.error });

// Turn 2: recall -- answerable only if the first read is still in context.
await ask(
  "recall",
  [
    `Without reading any file again, from what you already loaded:`,
    `Reply with ONLY one line of JSON:`,
    `{"names":["<up to 5 named entries/sections you remember>"],"reread":false}`,
  ].join("\n"),
);

// Turn 3: a question that depends on turn 2's own answer.
await ask(
  "followup",
  [
    `Take the list you just gave me. Pick the single most important entry from it`,
    `and justify the pick using only what you already read.`,
    `Reply with ONLY one line of JSON:`,
    `{"picked":"<one of your own previous names>","why":"<one sentence>","reread":false}`,
  ].join("\n"),
);

// Turn 4: self-check on continuity.
await ask(
  "continuity",
  [
    `How many questions have I asked you in this conversation, including this one?`,
    `Reply with ONLY one line of JSON:`,
    `{"questions_seen":<int>,"first_file_read":"<the file path from the very first message>"}`,
  ].join("\n"),
);

await closeAll([handle]);

const continuity = transcript.find((t) => t.turn === "continuity")?.answer;
const followup = transcript.find((t) => t.turn === "followup")?.answer;
const recall = transcript.find((t) => t.turn === "recall")?.answer;

text(
  JSON.stringify(
    {
      demo: "stateful_dialogue",
      backend: AGENT_BACKEND,
      elapsed_ms: Date.now() - t0,
      agent: handle.label,
      anchor_file: target,
      // The point of the demo: state survived across separate send/wait round trips.
      context_retained: Boolean(
        continuity && continuity.first_file_read && continuity.first_file_read.includes(target),
      ),
      // And a later answer was derived from an earlier one, not from re-reading.
      built_on_own_answer: Boolean(
        followup && recall && (recall.names || []).includes(followup.picked),
      ),
      transcript,
    },
    null,
    2,
  ),
);
