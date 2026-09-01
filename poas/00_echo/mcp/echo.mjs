#!/usr/bin/env node
// A dependency-free stdio MCP server bundled inside the PoA package.
//
// It exists to prove the capability path, not to be useful: one tool, deterministic
// output, no filesystem or network access. Exits when stdin closes, which is how the
// package's servers get reaped when the run ends.
import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";

const TOOLS = [
  {
    name: "echo",
    description: "Return `pong: <message>`. Deterministic; used to verify tool registration.",
    // Without these hints Codex's `auto` approval mode assumes a tool may write and opens
    // world, and prompts before every call -- which for a headless PoA run means a hang.
    // The hints are also what makes a tool parallel-safe.
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(request) {
  const { id, method, params } = request;
  // Notifications carry no id and must not be answered.
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      // Echo back whatever version the client asked for so this fixture keeps working
      // when Codex moves its preferred protocol version forward.
      reply(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "echo", version: "0.1.0" },
      });
      return;

    case "notifications/initialized":
    case "notifications/cancelled":
      return;

    case "ping":
      if (!isNotification) reply(id, {});
      return;

    case "tools/list":
      reply(id, { tools: TOOLS });
      return;

    case "tools/call": {
      if (params?.name !== "echo") {
        fail(id, -32602, `unknown tool: ${params?.name}`);
        return;
      }
      const message = params?.arguments?.message;
      if (typeof message !== "string") {
        fail(id, -32602, "`message` must be a string");
        return;
      }
      reply(id, {
        content: [{ type: "text", text: `pong: ${message}` }],
        isError: false,
      });
      return;
    }

    default:
      if (!isNotification) fail(id, -32601, `unsupported method: ${method}`);
  }
}

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  handle(request);
}
