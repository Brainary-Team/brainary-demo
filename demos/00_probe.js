// @exec: {"yield_time_ms": 60000}
//
// DEMO 0 -- environment probe. Costs one code-mode call and no subagents.
//
// Run this first after changing model, provider, or profile: it reports which multi-agent
// backend (if any) actually reached code mode, which is decided by model metadata rather
// than by local config.

const agentTools = ALL_TOOLS.map((t) => t.name)
  .filter((n) => n.includes("agent") || n.startsWith("collaboration__"))
  .sort();

text(
  JSON.stringify(
    {
      demo: "probe",
      backend: AGENT_BACKEND, // null means no multi-agent tools reached code mode
      agent_tools: agentTools,
      all_tools: ALL_TOOLS.map((t) => t.name).sort(),
      globals: Object.getOwnPropertyNames(globalThis)
        .filter((g) => ["tools", "ALL_TOOLS", "store", "load", "notify", "yield_control"].includes(g))
        .sort(),
      hint:
        AGENT_BACKEND === null
          ? "No agent tools in code mode. If this model resolves to multi-agent v2, use the v2 profile (non_code_mode_only = false)."
          : `Backend ${AGENT_BACKEND} is available; demos 01-04 will run.`,
    },
    null,
    2,
  ),
);
