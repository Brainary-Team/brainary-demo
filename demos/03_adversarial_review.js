// @exec: {"yield_time_ms": 900000, "max_output_tokens": 30000}
//
// DEMO 3 -- independent verification.
//
// One agent makes a factual claim about the code. Three other agents, each given a
// different lens and none of them shown the others' verdicts, try to REFUTE it.
// The script tallies the votes.
//
// Shows what a single agent cannot do: produce an answer whose confidence comes from
// independent checks rather than from its own self-report.

const REVIEWERS = [
  { lens: "existence", ask: "Do the files and symbols named in the claim actually exist? Check." },
  { lens: "semantics", ask: "Even if the symbols exist, does the code actually behave as claimed?" },
  { lens: "scope", ask: "Is the claim overstated -- true only in a narrow case, or with caveats?" },
];

const t0 = Date.now();
requireAgents();

// ---- propose ---------------------------------------------------------------
const proposePrompt = [
  `Pick ONE small, checkable, factual claim about this repository.`,
  ``,
  `Rules:`,
  `- It must name a specific file path and a specific symbol in it.`,
  `- It must be verifiable by reading that one file.`,
  `- Read the file first. Do not guess.`,
  ``,
  `Reply with ONLY one line of JSON:`,
  `{"claim":"<one sentence>","file":"<path>","symbol":"<name>"}`,
].join("\n");

const [proposal] = await runBatch([{ message: proposePrompt, name: "proposer" }], {
  concurrency: 1,
});
const claim = parseJsonReply(proposal.reply);
await closeAll([proposal.handle]);

if (!claim.value) {
  text(
    JSON.stringify({
      error: "proposer produced no usable claim",
      detail: claim.error,
      raw: String(proposal.reply ?? "").slice(0, 300),
    }),
  );
  exit();
}
notify(`claim: ${claim.value.claim}`);

// ---- refute ----------------------------------------------------------------
const refutePrompt = (reviewer) =>
  [
    `Another agent made this claim about the repository:`,
    ``,
    `  claim:  ${claim.value.claim}`,
    `  file:   ${claim.value.file}`,
    `  symbol: ${claim.value.symbol}`,
    ``,
    `Your job is to REFUTE it. Your lens: ${reviewer.lens}.`,
    `${reviewer.ask}`,
    ``,
    `Open the file and check. Default to refuted=true if the evidence is not clear.`,
    ``,
    `Reply with ONLY one line of JSON:`,
    `{"lens":"${reviewer.lens}","refuted":<true|false>,`,
    ` "reason":"<one sentence>","evidence":"<what you read, e.g. path:line>"}`,
  ].join("\n");

const verdicts = await runBatch(
  REVIEWERS.map((r, i) => ({ message: refutePrompt(r), name: `refute_${i}`, meta: r })),
  { concurrency: 3 },
);

const parsed = verdicts.map(({ handle, reply }) => {
  const { value, error } = parseJsonReply(reply);
  return {
    lens: handle.meta.lens,
    verdict: value,
    parse_error: error,
    raw: value ? undefined : String(reply ?? "").slice(0, 200),
  };
});

await closeAll(verdicts.map((v) => v.handle));

const usable = parsed.filter((p) => p.verdict);
const refutedCount = usable.filter((p) => p.verdict.refuted === true).length;
const survives = usable.length > 0 && refutedCount < Math.ceil(usable.length / 2);

text(
  JSON.stringify(
    {
      demo: "adversarial_review",
      backend: AGENT_BACKEND,
      elapsed_ms: Date.now() - t0,
      claim: claim.value,
      reviewers: usable.length,
      refuted_votes: refutedCount,
      // Majority refutation kills the claim; ties count as refuted.
      survives_review: survives,
      verdicts: parsed,
    },
    null,
    2,
  ),
);
