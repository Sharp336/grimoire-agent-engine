#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: scripts/update-custom-omp.sh [options]

Options:
  --branch <name>    Branch to update (default: current branch)
  --base <ref>       Upstream ref to rebase onto (default: origin/main)
  --allow-dirty      Allow running with uncommitted changes
  --skip-build       Skip native + binary build steps
  --dry-run          Print planned actions only
  -h, --help         Show help
EOF
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_REF="origin/main"
BRANCH=""
ALLOW_DIRTY="false"
SKIP_BUILD="false"
DRY_RUN="false"

while [[ $# -gt 0 ]]; do
	case "$1" in
		--branch)
			BRANCH="${2:-}"
			shift 2
			;;
		--base)
			BASE_REF="${2:-}"
			shift 2
			;;
		--allow-dirty)
			ALLOW_DIRTY="true"
			shift
			;;
		--skip-build)
			SKIP_BUILD="true"
			shift
			;;
		--dry-run)
			DRY_RUN="true"
			shift
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			echo "Unknown option: $1" >&2
			usage >&2
			exit 1
			;;
	esac
done

run_cmd() {
	echo "+ $*"
	if [[ "$DRY_RUN" == "false" ]]; then
		"$@"
	fi
}

if [[ -z "$BRANCH" ]]; then
	BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
fi

if [[ "$ALLOW_DIRTY" != "true" ]]; then
	if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
		echo "Working tree is not clean. Commit/stash changes first, or rerun with --allow-dirty." >&2
		exit 1
	fi
fi

CURRENT_BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
	run_cmd git -C "$REPO_ROOT" checkout "$BRANCH"
fi

run_cmd git -C "$REPO_ROOT" fetch origin --tags

echo "Rebasing $BRANCH onto $BASE_REF"
if [[ "$DRY_RUN" == "false" ]]; then
	if ! git -C "$REPO_ROOT" rebase "$BASE_REF"; then
		echo
		echo "Rebase stopped with conflicts."
		echo "Resolve conflicts, then run: git -C \"$REPO_ROOT\" rebase --continue"
		echo "Or abort with: git -C \"$REPO_ROOT\" rebase --abort"
		exit 1
	fi
else
	echo "+ git -C \"$REPO_ROOT\" rebase \"$BASE_REF\""
fi

run_cmd bun --cwd="$REPO_ROOT" install --force

if [[ "$SKIP_BUILD" != "true" ]]; then
	run_cmd bun --cwd="$REPO_ROOT/packages/natives" run build:native
	run_cmd bun --cwd="$REPO_ROOT/packages/coding-agent" run build:binary
fi

run_cmd omp --version
run_cmd git -C "$REPO_ROOT" status --short --branch

echo
echo "Update complete on branch: $BRANCH"
