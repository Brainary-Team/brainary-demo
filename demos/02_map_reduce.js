// @exec: {"yield_time_ms": 900000, "max_output_tokens": 30000}
//
// DEMO 2 -- map then reduce, with the reducer itself being an agent.
//
// Stage 1: N mappers each read one crate and report facts.
// Stage 2: ONE reducer agent receives all mapper output and answers a cross-cutting
//          question no single mapper could -- it never reads the repo itself.
//
// Shows agents composing: the script routes information between them, and the reduce step
// gets a context assembled from work that happened in parallel.

const MAX_FOLDERS = 4;
const CONCURRENCY = 3;

const t0 = Date.now();
requireAgents();

const folders = (
  await shellLines("ls -d */ 2>/dev/null | sed 's#/$##' | sort", {
    validate: (line) => SAFE_NAME.test(line),
  })
).slice(0, MAX_FOLDERS);

if (folders.length < 2) {
  text(JSON.stringify({ error: "need at least 2 subdirectories", found: folders }));
  exit();
}
notify(`map stage: ${folders.length} folders`);

// ---- map -------------------------------------------------------------------
const mapPrompt = (folder) =>
  [
    `Inspect ./${folder} and report what it depends on.`,
    ``,
    `1. Read ${folder}/Cargo.toml (or package.json / pyproject.toml).`,
    `2. Skim the main entry source to see what it actually uses.`,
    ``,
    `Reply with ONLY one line of JSON:`,
    `{"folder":"${folder}","role":"<one short phrase>",`,
    ` "depends_on":["<internal deps, e.g. codex-protocol>"],`,
    ` "external_deps":["<up to 4 third-party crates>"]}`,
  ].join("\n");

const mapped = await runBatch(
  folders.map((folder, i) => ({ message: mapPrompt(folder), name: `map_${i}`, meta: { folder } })),
  { concurrency: CONCURRENCY },
);

const facts = mapped
  .map(({ handle, reply }) => {
    const { value } = parseJsonReply(reply);
    return value ? { ...value, folder: handle.meta.folder } : null;
  })
  .filter(Boolean);

await closeAll(mapped.map((m) => m.handle));

if (facts.length < 2) {
  text(JSON.stringify({ error: "map stage produced too few usable results", facts }));
  exit();
}
notify(`reduce stage: synthesizing ${facts.length} reports`);

// ---- reduce ----------------------------------------------------------------
// The reducer sees only the mappers' JSON. It is explicitly told not to read the repo,
// so whatever it concludes came from the fan-out, not from its own exploration.
const reducePrompt = [
  `You are a synthesizer. Below are dependency reports produced by other agents.`,
  `Do NOT read any files. Reason only from this data.`,
  ``,
  JSON.stringify(facts, null, 2),
  ``,
  `Reply with ONLY one line of JSON:`,
  `{"shared_dependencies":["<deps appearing in 2+ reports>"],`,
  ` "layering":"<one sentence on how these components relate>",`,
  ` "most_connected":"<the folder with the most dependencies>",`,
  ` "observation":"<one non-obvious thing this cross-section reveals>"}`,
].join("\n");

const [reduced] = await runBatch([{ message: reducePrompt, name: "reducer" }], {
  concurrency: 1,
});
const synthesis = parseJsonReply(reduced.reply);
await closeAll([reduced.handle]);

text(
  JSON.stringify(
    {
      demo: "map_reduce",
      backend: AGENT_BACKEND,
      elapsed_ms: Date.now() - t0,
      mappers: facts.length,
      map_results: facts,
      synthesis: synthesis.value,
      synthesis_error: synthesis.error,
      synthesis_raw: synthesis.value ? undefined : String(reduced.reply ?? "").slice(0, 300),
    },
    null,
    2,
  ),
);
