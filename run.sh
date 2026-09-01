#!/usr/bin/env bash
#
# Usage: ./run.sh <demo.js|poa-package> [profile] [extra runner args]
#
#   ./run.sh demos/01_fanout_summary.js v1 --cwd /path/to/any/multi-folder/repo
#   ./run.sh poas/00_echo v1-forced
#   ./run.sh poas/00_echo.poa v1-forced
#
# A directory or a `.poa` file is a package and goes to `codex exec --poa`, which packs it
# and hands the bytes to the server; a `.js` file is a demo and goes to run_workflow.py.
#
# Reads connection settings from ./.env (or the environment):
#   OPENAI_API_URL    provider base, with or without a trailing /v1
#   OPENAI_API_KEY    forwarded to codex as env_key
#   OPENAI_API_MODEL  default model
#   WIRE_API          `responses` (default) or `anthropic`
#
# A PoA package needs no provider, so those fall back to placeholders when nothing
# supplies them. Precedence is unchanged: CODEX_DEMO_* > .env / environment > fallback.
#
# Overrides:
#   CODEX_BIN            path to the codex binary (else ./bin/codex, else PATH)
#   CODEX_DEMO_MODEL     model to use instead of OPENAI_API_MODEL
#   CODEX_DEMO_BASE_URL  full base URL instead of deriving it from OPENAI_API_URL
#   CODEX_DEMO_SANDBOX   sandbox_mode; defaults to read-only, see README
#   CODEX_DEMO_WIRE_API  wire protocol instead of WIRE_API
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TARGET="${1:?usage: ./run.sh <demo.js|poa-dir> [profile] [extra args]}"; shift
PROFILE="v1"
if [[ $# -gt 0 && "$1" != -* ]]; then PROFILE="$1"; shift; fi

TEMPLATE="$HERE/config/$PROFILE.toml"
[[ -f "$TEMPLATE" ]] || { echo "unknown profile '$PROFILE'" >&2; exit 1; }

# A package is a directory or a packed `.poa`; anything else is a demo. Checking for the
# extension matters: a packed package is a file, so a directory test alone would route it to
# the demo runner and try to prepend a prelude to a zip.
IS_POA=0
if [[ -d "$TARGET" || -d "$HERE/$TARGET" || "$TARGET" == *.poa ]]; then IS_POA=1; fi

if [[ -f "$HERE/.env" ]]; then set -a; . "$HERE/.env"; set +a; fi

if (( IS_POA )); then
  # A PoA body runs without sampling, so a package is runnable with no provider at all.
  # These sit at the same layer as .env -- last resort, below anything the environment or
  # CODEX_DEMO_* already said -- so configuring a real provider still works normally.
  # The placeholder base is a closed port rather than a plausible URL: if a program ever
  # does sample, it should fail loudly instead of reaching whatever host happens to answer.
  : "${OPENAI_API_KEY:=poa-unused}"
  : "${OPENAI_API_URL:=http://127.0.0.1:9}"
  # Must exist in the bundled catalog, otherwise pinning profiles cannot resolve it.
  : "${OPENAI_API_MODEL:=gpt-5.5}"
  export OPENAI_API_KEY
fi

: "${OPENAI_API_KEY:?set OPENAI_API_KEY (e.g. in $HERE/.env -- see .env.example)}"

# Accept the provider base with or without /v1; codex appends the endpoint itself
# (`/responses` or `/messages`, depending on wire_api).
BASE_URL="${CODEX_DEMO_BASE_URL:-}"
if [[ -z "$BASE_URL" ]]; then
  : "${OPENAI_API_URL:?set OPENAI_API_URL or CODEX_DEMO_BASE_URL}"
  BASE_URL="${OPENAI_API_URL%/}"
  [[ "$BASE_URL" == */v1 ]] || BASE_URL="$BASE_URL/v1"
fi

MODEL="${CODEX_DEMO_MODEL:-${OPENAI_API_MODEL:-}}"
: "${MODEL:?set OPENAI_API_MODEL or CODEX_DEMO_MODEL}"

# Rejected here rather than passed through, because codex reports an unknown wire_api as a
# config parse error naming a generated file under .home/ -- which is not a file anyone
# edited, so the message points away from the .env line that actually set it.
WIRE_API="${CODEX_DEMO_WIRE_API:-${WIRE_API:-responses}}"
case "$WIRE_API" in
  responses|anthropic) ;;
  *) echo "unknown WIRE_API '$WIRE_API'; expected 'responses' or 'anthropic'" >&2; exit 1 ;;
esac

SANDBOX_MODE="${CODEX_DEMO_SANDBOX:-read-only}"

# One CODEX_HOME per profile so config and state never bleed between runs.
export CODEX_HOME="$HERE/.home/$PROFILE"
mkdir -p "$CODEX_HOME"

# Profiles that pin a backend derive their catalog from vendor/models.json on every run,
# rather than checking in a second, hand-edited copy that would drift against it.
CATALOG=""
if grep -q "__CATALOG__" "$TEMPLATE"; then
  CATALOG="$CODEX_HOME/catalog.json"
  python3 "$HERE/runner/make_catalog.py" "$CATALOG"
fi

sed -e "s|__BASE_URL__|$BASE_URL|g" \
    -e "s|__MODEL__|$MODEL|g" \
    -e "s|__SANDBOX_MODE__|$SANDBOX_MODE|g" \
    -e "s|__CATALOG__|$CATALOG|g" \
    -e "s|__WIRE_API__|$WIRE_API|g" \
    "$TEMPLATE" > "$CODEX_HOME/config.toml"

echo "profile=$PROFILE model=$MODEL base_url=$BASE_URL sandbox=$SANDBOX_MODE wire_api=$WIRE_API" >&2

if (( IS_POA )); then
  # Packing, manifest validation, and starting the package's MCP servers all happen inside
  # codex, so there is nothing left here for a runner script to do.
  CODEX_BIN="${CODEX_BIN:-$(python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); from rpc_client import resolve_codex_bin; print(resolve_codex_bin())' "$HERE/runner")}"
  exec "$CODEX_BIN" exec --poa "$TARGET" "$@"
fi

exec python3 "$HERE/runner/run_workflow.py" "$TARGET" "$@"
