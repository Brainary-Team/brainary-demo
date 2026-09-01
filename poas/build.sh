#!/usr/bin/env bash
#
# Usage: poas/build.sh <package-dir> [output.poa]
#
#   poas/build.sh poas/00_echo              # -> ./00_echo.poa
#   poas/build.sh poas/00_echo dist/echo.poa
#
# Needs Python 3.11+ for `tomllib`; set PYTHON to point at one if `python3` is older.
#
# Packs a PoA package directory into a `.poa` archive: a zip with `manifest.toml` at its
# root. `codex exec --poa <dir>` already packs a directory on the fly, so this exists for
# the other case -- handing someone one file instead of a tree.
#
# The archive is reproducible (entries sorted, timestamps fixed at the zip epoch) and keeps
# unix permission bits, because a bundled stdio server is usually an executable script and a
# package that loses its exec bit fails at the moment the server is spawned.
#
# The package is validated before anything is written, so a `.poa` that exists is a `.poa`
# that loads -- the same rule `codex_poa::pack_dir` follows.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SRC="${1:?usage: poas/build.sh <package-dir> [output.poa]}"
[[ -d "$SRC" ]] || { [[ -d "$HERE/$SRC" ]] && SRC="$HERE/$SRC"; } || true
[[ -d "$SRC" ]] || { echo "not a package directory: $SRC" >&2; exit 2; }
SRC="$(cd "$SRC" && pwd)"

OUT="${2:-$(basename "$SRC").poa}"
mkdir -p "$(dirname "$OUT")"

# `.gitignore` is what keeps build junk and local secrets out of a distributed package, so
# selection goes through git when the package sits in a work tree. Anything git drops is
# reported rather than silently omitted: a file missing from the archive but present in the
# directory is exactly the failure that only shows up on someone else's machine.
FILES=""
if git -C "$SRC" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  FILES="$(git -C "$SRC" ls-files --cached --others --exclude-standard)"
fi

# `tomllib` is stdlib only from 3.11, and the `python3` on a stock macOS is 3.9. Pick an
# interpreter that actually has it, rather than dying inside the heredoc with a bare
# ModuleNotFoundError that names a module nobody asked for.
PY_BIN=""
for candidate in "${PYTHON:-}" python3 python3.13 python3.12 python3.11; do
  [[ -n "$candidate" ]] || continue
  command -v "$candidate" >/dev/null 2>&1 || continue
  if "$candidate" -c 'import tomllib' >/dev/null 2>&1; then PY_BIN="$candidate"; break; fi
done
[[ -n "$PY_BIN" ]] || {
  echo "no Python 3.11+ found (needed for tomllib); tried PYTHON, python3, python3.13-3.11." >&2
  echo "Install one, or set PYTHON=/path/to/python3.11+." >&2
  exit 2
}

OUT="$OUT" SRC="$SRC" FILES="$FILES" "$PY_BIN" - <<'PY'
import os
import stat
import sys
import tomllib
import zipfile

src = os.environ["SRC"]
out = os.environ["OUT"]
selected = [line for line in os.environ["FILES"].splitlines() if line]

# Every file on disk, so a git-dropped entry can be named instead of just vanishing.
on_disk = []
for root, dirs, names in os.walk(src):
    dirs[:] = sorted(d for d in dirs if d != ".git")
    for name in sorted(names):
        on_disk.append(os.path.relpath(os.path.join(root, name), src))

if selected:
    dropped = sorted(set(on_disk) - set(selected))
    if dropped:
        print("ignored (per .gitignore): " + ", ".join(dropped), file=sys.stderr)
else:
    # Not a work tree: there is no ignore machinery to consult, so take everything but .git.
    selected = on_disk

selected = sorted(selected)

# Validate before writing. A malformed package should fail here, not on the far side.
if "manifest.toml" not in selected:
    sys.exit(f"no manifest.toml at the root of {src}")
with open(os.path.join(src, "manifest.toml"), "rb") as handle:
    manifest = tomllib.load(handle)
poa = manifest.get("poa")
if not isinstance(poa, dict):
    sys.exit("manifest.toml has no [poa] table")
entry = poa.get("entry")
if not entry:
    sys.exit("manifest.toml has no [poa].entry")
if entry not in selected:
    sys.exit(f"[poa].entry is not in the package: {entry}")

# The zip epoch, matching what codex writes, so packing the same tree twice is the same bytes.
FIXED_DATE = (1980, 1, 1, 0, 0, 0)

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
    for name in selected:
        path = os.path.join(src, name)
        info = zipfile.ZipInfo(name, date_time=FIXED_DATE)
        info.compress_type = zipfile.ZIP_DEFLATED
        # create_system 3 (unix) is what makes a reader honor the mode in external_attr.
        info.create_system = 3
        info.external_attr = (stat.S_IMODE(os.stat(path).st_mode)) << 16
        with open(path, "rb") as handle:
            archive.writestr(info, handle.read())

size = os.path.getsize(out)
print(
    f"{out}: {poa.get('name', '?')} {poa.get('version', '?')}, "
    f"{len(selected)} files, {size} bytes",
    file=sys.stderr,
)
PY
