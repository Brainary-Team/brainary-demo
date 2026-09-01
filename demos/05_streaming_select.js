// @exec: {"yield_time_ms": 900000, "max_output_tokens": 30000}
//
// DEMO 5 -- streaming collection via Promise.race, on either backend.
//
// Each nested tool call is its own task on the host side, so N concurrent single-target
// waits can be raced. That gives v1 the same "process results as they land" shape people
// reach for v2's any-agent wait to get -- no polling loop required.
//
// Agents are given deliberately different durations so arrival order differs from spawn
// order; the demo records both.

const DURATIONS = [12, 2, 7]; // seconds of busywork per agent

const t0 = Date.now();
requireAgents();

const spawnSpecs = DURATIONS.map((secs, i) => ({
  name: `worker_${i}`,
  meta: { index: i, secs },
  message: [
    `Run exactly this, then report: sleep ${secs} && echo done_${i}`,
    ``,
    `Reply with ONLY one line of JSON:`,
    `{"index":${i},"slept":${secs},"echo":"<the echoed text>"}`,
  ].join("\n"),
}));

const handles = await spawnMany(spawnSpecs, DURATIONS.length);
notify(`spawned ${handles.length} with durations ${DURATIONS.join("/")}s`);

// ---- streaming join --------------------------------------------------------
// One in-flight wait per agent, each tagged with its handle. Race the set, remove the
// settled entry, race what remains. The losers are never re-issued -- their original
// promises stay pending and are reused on the next round.
const inflight = new Map(
  handles.map((h) => [
    h.key,
    collectAll([h], 300000).then((replies) => ({ h, reply: replies.get(h.key) ?? null })),
  ]),
);

const arrivals = [];
while (inflight.size > 0) {
  const { h, reply } = await Promise.race(inflight.values());
  inflight.delete(h.key);
  const { value } = parseJsonReply(reply);
  arrivals.push({
    order: arrivals.length + 1,
    spawn_index: h.meta.index,
    requested_secs: h.meta.secs,
    at_ms: Date.now() - t0,
    answer: value,
  });
  notify(`arrival ${arrivals.length}/${handles.length}: worker_${h.meta.index}`);
}

await closeAll(handles);

const spawnOrder = handles.map((h) => h.meta.index);
const arrivalOrder = arrivals.map((a) => a.spawn_index);
const expected = DURATIONS.map((secs, i) => ({ i, secs }))
  .sort((a, b) => a.secs - b.secs)
  .map((x) => x.i);

text(
  JSON.stringify(
    {
      demo: "streaming_select",
      backend: AGENT_BACKEND,
      elapsed_ms: Date.now() - t0,
      spawn_order: spawnOrder,
      arrival_order: arrivalOrder,
      expected_by_duration: expected,
      // The point: results are consumed as they land, not in the order they were started.
      streamed_out_of_order: JSON.stringify(arrivalOrder) !== JSON.stringify(spawnOrder),
      matches_duration_order: JSON.stringify(arrivalOrder) === JSON.stringify(expected),
      arrivals,
    },
    null,
    2,
  ),
);
