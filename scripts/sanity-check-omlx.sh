#!/usr/bin/env bash
# OMLX sanity check: verify omp can discover and talk to an OMLX-served model.
#
# Steps:
#   1. Confirm the OMLX server answers GET /v1/models.
#   2. Pick a chat model (CLI arg / $OMLX_MODEL, else first non-embedding model).
#   3. Check omp's discovery cache (models.db) and configured default model
#      against the live server. A stale cache or a default pointing at a removed
#      model is exactly what makes omp emit "Could not restore model omlx/… —
#      Using <cloud-model>" on restart, so flag it explicitly.
#   4. Run omp non-interactively with a simple "hello world" prompt and assert
#      it produces output.
#
# Usage:
#   scripts/sanity-check-omlx.sh [model-id]
#
# Environment:
#   OMLX_BASE_URL  OMLX server base URL          (default: http://localhost:8000)
#   OMLX_MODEL     Model id to test              (default: auto-detected)
#   OMP_BIN        omp binary/command to run     (default: `omp` on PATH — i.e. what
#                                                 you actually run; falls back to the
#                                                 built ./packages/coding-agent/dist/omp)
#   OMP_AGENT_DIR  omp agent dir (cache/config)  (default: $HOME/.omp/agent)
#   OMP_TIMEOUT    Per-run timeout in seconds    (default: 180)
set -euo pipefail

base_url="${OMLX_BASE_URL:-http://localhost:8000}"
base_url="${base_url%/}"        # strip trailing slash
base_url="${base_url%/v1}"      # strip trailing /v1 so we can append it ourselves
models_url="$base_url/v1/models"
timeout_s="${OMP_TIMEOUT:-180}"

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
default_bin="$repo_root/packages/coding-agent/dist/omp"
# Prefer the `omp` the user actually runs (PATH) over the built artifact, which
# can be stale relative to the current source and silently fail to resolve models.
if [ -n "${OMP_BIN:-}" ]; then
	omp_bin="$OMP_BIN"
elif command -v omp >/dev/null 2>&1; then
	omp_bin="omp"
elif [ -x "$default_bin" ]; then
	omp_bin="$default_bin"
else
	echo "✗ no omp found ('omp' not on PATH and built $default_bin missing). Install/link omp, run 'bun run build', or set OMP_BIN." >&2
	exit 1
fi

echo "→ OMLX base URL : $base_url"
echo "→ omp binary    : $omp_bin"

# 1. Server reachable?
echo "→ Checking $models_url ..."
models_json="$(curl -fsS -m 10 "$models_url" 2>/dev/null || true)"
if [ -z "$models_json" ]; then
	echo "✗ OMLX server is not reachable at $models_url" >&2
	echo "  Start OMLX or set OMLX_BASE_URL (e.g. export OMLX_BASE_URL=http://jupiter.local:2524)." >&2
	exit 1
fi

# 2. Resolve the model to test.
model="${1:-${OMLX_MODEL:-}}"
if [ -z "$model" ]; then
	# First model whose id is not an embedding/reranker/utility model.
	model="$(printf '%s' "$models_json" \
		| jq -r '.data[].id
			| select((ascii_downcase | test("embed|rerank|markitdown")) | not)' \
		| head -n1)"
fi
if [ -z "$model" ]; then
	echo "✗ Could not find a chat model in $models_url" >&2
	printf '%s\n' "$models_json" | jq -r '.data[].id' >&2 || true
	exit 1
fi
echo "→ Model         : $model"

# 3. Discovery-cache + default-model freshness check.
#
# omp resolves the startup model SYNCHRONOUSLY from a local cache (models.db);
# the live /v1/models discovery only refreshes that cache asynchronously. So if
# the cache is stale (e.g. after the server's model set changed), a served model
# is not resolvable the instant omp picks a model — session restore and the
# configured default then silently fall back to the first available *cloud*
# model. That is the "Could not restore model omlx/… — Using google/…" symptom.
agent_dir="${OMP_AGENT_DIR:-${PI_CODING_AGENT_DIR:-${PI_CONFIG_DIR:-$HOME/.omp}/agent}}"
cache_db="$agent_dir/models.db"
config_yml="$agent_dir/config.yml"

# Models the server serves right now, with the same non-chat filter discovery applies.
live_ids="$(printf '%s' "$models_json" \
	| jq -r '.data[].id | select((ascii_downcase | test("embed|rerank|markitdown")) | not)' \
	| sort -u)"

echo "→ Checking omp discovery cache : $cache_db"
if command -v sqlite3 >/dev/null 2>&1 && [ -f "$cache_db" ]; then
	cached_ids="$(sqlite3 "$cache_db" \
		"SELECT models FROM model_cache WHERE provider_id LIKE 'omlx%';" 2>/dev/null \
		| jq -r '.[].id' 2>/dev/null \
		| grep -viE 'embed|rerank|markitdown' \
		| sort -u || true)"
	if [ -z "$cached_ids" ]; then
		echo "  ⚠ No OMLX models cached yet — first omp launch will discover them;"
		echo "    restore/default may fall back to a cloud model until then."
	else
		missing="$(comm -23 <(printf '%s\n' "$live_ids") <(printf '%s\n' "$cached_ids") || true)"
		stale="$(comm -13 <(printf '%s\n' "$live_ids") <(printf '%s\n' "$cached_ids") || true)"
		if [ -n "$missing" ]; then
			echo "  ⚠ STALE CACHE — served but NOT in omp's cache (omp can't resolve these at startup):"
			printf '      %s\n' $missing
		fi
		if [ -n "$stale" ]; then
			echo "  ⚠ STALE CACHE — cached but no longer served (will fail to restore):"
			printf '      %s\n' $stale
		fi
		if [ -n "$missing" ] || [ -n "$stale" ]; then
			echo "    → relaunch omp (or run /refresh-models) so the cache matches the server."
		else
			echo "  ✓ Cache matches the live server."
		fi
	fi
else
	echo "  ⚠ Skipped (sqlite3 unavailable or cache missing) — cannot verify cache freshness."
fi

# Configured default model: if it points at a model the server no longer serves,
# session restore on startup falls back to a cloud model.
if [ -f "$config_yml" ]; then
	default_model="$(grep -E '^[[:space:]]*default:[[:space:]]*omlx/' "$config_yml" 2>/dev/null \
		| head -n1 | sed -E 's@.*default:[[:space:]]*omlx/@@; s/[[:space:]]*$//' || true)"
	if [ -n "$default_model" ]; then
		if printf '%s\n' "$live_ids" | grep -qxF "$default_model"; then
			echo "  ✓ Default model omlx/$default_model is served by OMLX."
		else
			echo "  ⚠ Default model omlx/$default_model is NOT served right now →"
			echo "    omp will fall back to a cloud model on restart. Update modelRoles.default in"
			echo "    $config_yml to a served model, e.g.:"
			printf '      %s\n' $live_ids
		fi
	fi
fi

# 4. Run omp with a simple prompt.
prompt="Reply with exactly: hello world"
echo "→ Running omp (timeout ${timeout_s}s, this can be slow on local models) ..."
set +e
output="$(OMLX_BASE_URL="$base_url" timeout "$timeout_s" \
	"$omp_bin" -p --model "omlx/$model" --no-tools "$prompt" 2>&1)"
status=$?
set -e

echo "──────── omp output ────────"
printf '%s\n' "$output"
echo "────────────────────────────"

if [ "$status" -eq 124 ]; then
	echo "✗ FAIL: omp timed out after ${timeout_s}s (model too slow for the prompt?)." >&2
	exit 1
fi
if [ "$status" -ne 0 ]; then
	echo "✗ FAIL: omp exited with status $status." >&2
	exit 1
fi
if printf '%s' "$output" | grep -qi "hello world"; then
	echo "✓ PASS: omp communicated with omlx/$model"
	exit 0
fi
if [ -n "$(printf '%s' "$output" | tr -d '[:space:]')" ]; then
	echo "✓ PASS: omp got a response from omlx/$model (did not contain 'hello world', but output was produced)"
	exit 0
fi
echo "✗ FAIL: omp produced no output for omlx/$model." >&2
exit 1
