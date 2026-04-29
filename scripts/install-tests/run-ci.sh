#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
ROOT_DIR="$(pwd)"
WORK_DIR="$(mktemp -d)"
TMP_WORK_DIR="$WORK_DIR/tmp"
mkdir -p "$TMP_WORK_DIR"
export TMPDIR="$TMP_WORK_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

section() {
	echo ""
	echo "=== $1 ==="
}

smoke_cli() {
	local omp_bin="$1"
	local runtime_dir
	runtime_dir="$(mktemp -d "$WORK_DIR/compiled-runtime.XXXXXX")"
	XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$omp_bin" --version
	XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$omp_bin" --help >/dev/null
	XDG_DATA_HOME="$runtime_dir/xdg" HOME="$runtime_dir/home" "$omp_bin" stats --summary >/dev/null
}

find_tarball() {
	local pattern="$1"
	local matches=()
	shopt -s nullglob
	matches=("$pattern")
	shopt -u nullglob

	if [ "${#matches[@]}" -ne 1 ]; then
		echo "Expected exactly one tarball matching: $pattern"
		exit 1
	fi

	echo "${matches[0]}"
}

discover_packages() {
	for dir in "$ROOT_DIR"/packages/*/; do
		[ -f "$dir/package.json" ] || continue
		local is_private
		is_private=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$dir/package.json','utf8')).private || false)")
		[ "$is_private" = "true" ] && continue
		printf '%s\n' "$dir"
	done
}

section "Binary install smoke"
bun --cwd=packages/natives run build
bun --cwd=packages/coding-agent run build

BINARY_DIR="$WORK_DIR/binary-bin"
mkdir -p "$BINARY_DIR"
cp packages/coding-agent/dist/omp "$BINARY_DIR/omp"
smoke_cli "$BINARY_DIR/omp"

section "Source install smoke"
SOURCE_BUN_HOME="$WORK_DIR/bun-source"
(
	export BUN_INSTALL="$SOURCE_BUN_HOME"
	export PATH="$BUN_INSTALL/bin:$PATH"
	bun --cwd="$ROOT_DIR/packages/coding-agent" link
	smoke_cli "$BUN_INSTALL/bin/omp"
)

section "Tarball install smoke"
TARBALL_DIR="$WORK_DIR/tarballs"
mkdir -p "$TARBALL_DIR"

declare -a PKG_DIRS
mapfile -t PKG_DIRS < <(discover_packages)
for pkg_dir in "${PKG_DIRS[@]}"; do
	(
		cd "$pkg_dir"
		bun pm pack --destination "$TARBALL_DIR" --quiet >/dev/null
	)
done

declare -A TARBALLS
declare -a OVERRIDES
declare -a ALL_TARBALLS
for pkg_dir in "${PKG_DIRS[@]}"; do
	pkg_name=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$pkg_dir/package.json','utf8')).name)")
	tarball_stem="${pkg_name#@}"       # strip leading @
	tarball_stem="${tarball_stem//\//-}" # replace / with -
	pkg_tgz="$(find_tarball "$TARBALL_DIR"/${tarball_stem}-*.tgz)"
	TARBALLS["$pkg_name"]="$pkg_tgz"
	OVERRIDES+=("$pkg_name=$pkg_tgz")
	ALL_TARBALLS+=("$pkg_tgz")
done

TARBALL_APP_DIR="$WORK_DIR/tarball-install"
mkdir -p "$TARBALL_APP_DIR"
(
	cd "$TARBALL_APP_DIR"
	bun init -y >/dev/null

	# Write overrides so bun resolves inter-package deps from tarballs, not the registry
	# (version 12.x.y hasn't been published yet when CI runs pre-release)
	node -e "
		const pkg = JSON.parse(require('fs').readFileSync('package.json', 'utf8'));
		pkg.overrides = Object.fromEntries(process.argv.slice(1).map(e => e.split('=')));
		require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));
	" "${OVERRIDES[@]}"

	bun add "${ALL_TARBALLS[@]}"
	smoke_cli ./node_modules/.bin/omp
)

echo ""
echo "All install method smoke tests passed"
