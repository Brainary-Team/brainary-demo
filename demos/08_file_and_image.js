// @exec: {"yield_time_ms": 120000, "max_output_tokens": 30000}
//
// DEMO 8 -- files and images: apply_patch, view_image, and the output primitives beyond text().
//
// profile: any (both tools are present as long as there is an environment)
// cwd:     any -- every write lands in a mktemp -d directory, nothing touches the repo
// needs a writable sandbox:
//     CODEX_DEMO_SANDBOX=workspace-write ./run.sh demos/08_file_and_image.js full
// subagents: none
//
// This demo is the inverse of every one before it: they only read, this one writes. Three claims:
//
//   - apply_patch is the only tool here whose argument is a BARE STRING (a freeform tool), and it
//     returns an empty object -- whether the edit landed can only be checked by reading back.
//   - Failure surfaces in JS as a thrown exception, not an error return value. A bad patch and a
//     read-only sandbox both take that path, so try/catch can absorb them without the whole
//     program going down with them.
//   - text() is not the only way out: image() appends an input_image item to this call's return.

const t0 = Date.now();
const out = {};
const sh = async (cmd) => callTool("exec_command", { cmd });

// ---------------------------------------------------------------------------
// 1. Prepare a scratch area: a temp directory at an absolute path
//
// mktemp -d rather than a path relative to cwd, so this demo leaves nothing behind wherever
// --cwd happens to point. Under a read-only sandbox this step is the one that fails, which makes
// it double as the sandbox probe.
// ---------------------------------------------------------------------------

const made = await sh("mktemp -d");
const scratch = String((made.value && made.value.output) || "").trim();
// Under a read-only sandbox mktemp prints "mkdtemp failed ... Operation not permitted" and exits
// non-zero, while the exec_command call itself SUCCEEDS (status = ok) -- a failing command is not
// a failing tool. The judge is exit_code, not status, and certainly not whether output happens to
// look like a path.
const writable =
  made.status === "ok" && made.value.exit_code === 0 && scratch.startsWith("/");

if (!writable) {
  text(
    JSON.stringify(
      {
        demo: "file_and_image",
        error: "could not get a writable temp directory -- most likely a read-only sandbox",
        hint: "CODEX_DEMO_SANDBOX=workspace-write ./run.sh demos/08_file_and_image.js full",
        detail: { status: made.status, error: made.error, output: scratch },
      },
      null,
      2,
    ),
  );
  exit();
}
out.scratch = scratch;

const target = `${scratch}/note.txt`;
const read = async (path) => String(((await sh(`cat ${path} 2>&1`)).value || {}).output || "");

// ---------------------------------------------------------------------------
// 2. The three apply_patch operations
//
// The argument is the patch text ITSELF, not an object like { patch: "..." } -- unlike every
// other tool here. Getting it wrong throws on the JS side.
// ---------------------------------------------------------------------------

const steps = [];

// Add File: lines starting with + are the new content
const add = await callTool(
  "apply_patch",
  `*** Begin Patch\n*** Add File: ${target}\n+line one\n+line two\n+line three\n*** End Patch`,
);
steps.push({
  op: "Add File",
  status: add.status,
  // Measured: it returns an empty object. The tool tells you nothing about what it changed, so
  // the only way to verify is to read the file back.
  returned: shapeOf(add.value),
  content_after: await read(target),
  error: add.error || undefined,
});

// Update File: after @@, a leading space marks a context line, - a deletion, + an addition
const update = await callTool(
  "apply_patch",
  `*** Begin Patch\n*** Update File: ${target}\n@@\n line one\n` +
    `-line two\n+line two (patched)\n line three\n*** End Patch`,
);
steps.push({
  op: "Update File",
  status: update.status,
  content_after: await read(target),
  error: update.error || undefined,
});

// A bad patch: the context does not match. Failure is the point here -- what matters is how it
// fails. The context line below is chosen so it cannot match: the file holds "line one/two/three".
const bad = await callTool(
  "apply_patch",
  `*** Begin Patch\n*** Update File: ${target}\n@@\n-no such line in this file\n+x\n*** End Patch`,
);
steps.push({
  op: "Update File (deliberately broken)",
  status: bad.status, // expect error: a failing tool surfaces in JS as a thrown exception
  error: bad.error ? String(bad.error).slice(0, 200) : undefined,
  content_after: await read(target), // expect the same as the previous step: a failed patch must not touch the file
});

// Delete File
const del = await callTool(
  "apply_patch",
  `*** Begin Patch\n*** Delete File: ${target}\n*** End Patch`,
);
steps.push({
  op: "Delete File",
  status: del.status,
  content_after: await read(target), // expect "No such file or directory"
  error: del.error || undefined,
});

out.apply_patch = steps;

// ---------------------------------------------------------------------------
// 3. view_image: pull an image from disk into context
//
// The sandbox has neither network nor filesystem APIs, so the image has to reach disk via
// exec_command first. This writes a 1x1 PNG straight from base64, depending on no image library.
// ---------------------------------------------------------------------------

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const pngPath = `${scratch}/dot.png`;
const written = await sh(
  `python3 -c "import base64;open('${pngPath}','wb').write(base64.b64decode('${PNG_B64}'))"`,
);
// Same discipline as the mktemp step above: the judge is exit_code, not status. With python3
// missing the exec_command call is still ok; only exit_code goes non-zero.
const pngOk = written.status === "ok" && written.value.exit_code === 0;

if (pngOk) {
  const high = await callTool("view_image", { path: pngPath, detail: "high" });
  const original = await callTool("view_image", { path: pngPath, detail: "original" });
  const url = (high.value && high.value.image_url) || "";
  out.view_image = {
    high: { status: high.status, detail: high.value && high.value.detail, url_chars: url.length },
    original: {
      status: original.status,
      detail: original.value && original.value.detail,
      url_chars: original.value ? String(original.value.image_url).length : 0,
    },
    // Measured: the data URL's mime is application/octet-stream, not image/png
    mime: url.slice(0, url.indexOf(";")),
    // A path that does not exist: also a thrown exception
    missing_path: (await callTool("view_image", { path: `${scratch}/nope.png` })).status,
  };

  // ---- image(): the output primitive beyond text() ----
  // It appends an input_image to this exec's return items. The runner renders that as a single
  // [input_image] line (--raw shows the full item). Order matters: whatever calls image() first
  // comes first.
  image(url);
  out.image_primitive = "image() was called; the output should carry an [input_image] line";
} else {
  out.view_image = { skipped: "python3 unavailable, cannot produce the PNG", detail: written.error };
}

// ---------------------------------------------------------------------------
// 4. Cleanup: remove the scratch area -- and run into the third gate on the way
//
// Up to here, "can this command run" has been governed by two things: tool exposure (is
// exec_command reachable at all) and sandbox mode (can anything be written). There is a third,
// independent of both: the exec policy rejects commands by content. rm -rf is on the refused
// list; dropping the -f lets the same path through.
//
// This section is also a discipline: when a command fails, its diagnostics travel on the same
// channel as real output, so reading output alone turns "refused" into "the output happened to
// be empty". The judge is always status / exit_code.
// ---------------------------------------------------------------------------

const refused = await sh(`rm -rf ${scratch}`);
const cleaned = await sh(`rm -r ${scratch}`);
const gone = await sh(`ls -d ${scratch} 2>&1 | head -1`);
out.cleanup = {
  rm_rf: {
    status: refused.status, // expect error
    error: refused.error ? String(refused.error).slice(-96) : undefined,
  },
  rm_r: { status: cleaned.status }, // expect ok
  after: String((gone.value && gone.value.output) || "").trim(), // expect No such file or directory
};

text(
  JSON.stringify(
    { demo: "file_and_image", backend: AGENT_BACKEND, elapsed_ms: Date.now() - t0, ...out },
    null,
    2,
  ),
);
