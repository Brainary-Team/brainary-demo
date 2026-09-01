// @exec: {"yield_time_ms": 900000, "max_output_tokens": 30000}
//
// DEMO 1 -- parallel map.
//
// Discover subdirectories from JS, hand one to each subagent, collect structured results.
// The shape every other demo builds on: N independent workers, one join.

const MAX_FOLDERS = 3;
const CONCURRENCY = 3;

const t0 = Date.now();
requireAgents();

const folders = (
  await shellLines("ls -d */ 2>/dev/null | sed 's#/$##' | sort", {
    validate: (line) => SAFE_NAME.test(line),
  })
).slice(0, MAX_FOLDERS);

if (folders.length === 0) {
  text(JSON.stringify({ error: "no subdirectories found" }));
  exit();
}
notify(`backend=${AGENT_BACKEND} folders=${folders.join(", ")}`);

const prompt = (folder) =>
  [
    `Analyze exactly one folder: ./${folder}`,
    ``,
    `Do real work before answering:`,
    `1. Run: ls -R ${folder} | head -60`,
    `2. Read its manifest (Cargo.toml / package.json / pyproject.toml) if present.`,
    `3. Open the main entry source and ONE other substantial file. Actually read them.`,
    `4. Run: find ${folder} -name '*.rs' -o -name '*.ts' -o -name '*.py' | wc -l`,
    ``,
    `Reply with ONLY one line of JSON, no fence, no prose:`,
    `{"folder":"${folder}","purpose":"<one precise sentence>",`,
    ` "public_api":["<up to 4 symbols you actually saw>"],`,
    ` "notable_deps":["<up to 3>"],"source_file_count":<int>,`,
    ` "evidence":["<the 2 files you read>"]}`,
    ``,
    `Stay inside ./${folder}. Accuracy over verbosity.`,
  ].join("\n");

const batch = await runBatch(
  folders.map((folder, i) => ({ message: prompt(folder), name: `scan_${i}`, meta: { folder } })),
  { concurrency: CONCURRENCY },
);

const results = batch.map(({ handle, reply }) => {
  const { value, error } = parseJsonReply(reply);
  return {
    folder: handle.meta.folder,
    agent: handle.label,
    summary: value,
    parse_error: error,
    raw_reply: value ? undefined : String(reply ?? "").slice(0, 200),
  };
});

await closeAll(batch.map((b) => b.handle));

text(
  JSON.stringify(
    {
      demo: "fanout_summary",
      backend: AGENT_BACKEND,
      elapsed_ms: Date.now() - t0,
      succeeded: results.filter((r) => r.summary).length,
      total: results.length,
      results,
    },
    null,
    2,
  ),
);
