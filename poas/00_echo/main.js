// PoA body. Runs in Codex's code-mode V8 host; no model is sampled to produce or approve it.
//
// The tool name is discovered rather than hardcoded: the `mcp__` prefix depends on
// `prefix_mcp_tool_names()`, and namespaces are sanitized and hash-suffixed on collision,
// so `mcp__echo__echo` is a current-config detail rather than a contract.

const matches = ALL_TOOLS.map((t) => t.name).filter((n) => /(^|__)echo__echo$/.test(n));

if (matches.length !== 1) {
  throw new Error(
    `expected exactly one echo tool, found ${matches.length} (${JSON.stringify(matches)}); ` +
      `all tools: ${ALL_TOOLS.map((t) => t.name).sort().join(", ")}`,
  );
}

const resolvedToolName = matches[0];
const result = await tools[resolvedToolName]({ message: "ping" });

text(JSON.stringify({ poa: "echo_expert", resolvedToolName, result }, null, 2));
