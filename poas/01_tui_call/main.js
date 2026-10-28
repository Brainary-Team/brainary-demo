// @exec: {"yield_time_ms": 600000, "max_output_tokens": 10000}

const WAIT_MS = 240000;

function extractJson(text) {
  const raw = String(text ?? "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (_err) {
    return null;
  }
}

function replyOf(outcome, id) {
  const status = (outcome && outcome.status && outcome.status[id]) || {};
  if ("completed" in status) return String(status.completed ?? "");
  if ("errored" in status) return String(status.errored ?? "");
  return "";
}

async function runAgent(message) {
  const spawned = await tools.multi_agent_v1__spawn_agent({ message });
  const id = spawned && spawned.agent_id;
  if (!id) {
    throw new Error("spawn_agent did not return agent_id: " + JSON.stringify(spawned));
  }
  const outcome = await tools.multi_agent_v1__wait_agent({
    targets: [id],
    timeout_ms: WAIT_MS,
  });
  return replyOf(outcome, id);
}

const locationReply = await runAgent(
  [
    "Use exec_command to run exactly this command, and no other command:",
    "curl -fsS https://ipinfo.io/json",
    "",
    "Reply with one line of JSON and nothing else. No code fences.",
    'Copy city and ip from the command stdout: {"city":"<city>","ip":"<ip>"}',
  ].join("\n"),
);
const location = extractJson(locationReply);
const city = location && typeof location.city === "string" ? location.city.trim() : "";
if (!city) {
  throw new Error("location agent did not return a city: " + locationReply);
}

const weatherReply = await runAgent(
  [
    "Use exec_command to run exactly this command, and no other command:",
    `curl -fsS "https://wttr.in/${encodeURIComponent(city)}?format=%l:+%c+%t"`,
    "",
    "Reply with one line of JSON and nothing else. No code fences.",
    'Copy the command stdout into: {"weather":"<stdout>"}',
  ].join("\n"),
);

text(JSON.stringify({ city, ip: location.ip, weather: weatherReply }, null, 2));
