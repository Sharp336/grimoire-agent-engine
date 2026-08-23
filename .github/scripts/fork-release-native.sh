#!/usr/bin/env bash
set -euo pipefail

die() {
  echo "::error::$*" >&2
  exit 1
}

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <linux-x64|linux-arm64|win32-x64> <destination-directory>" >&2
  exit 2
fi

target="$1"
destination="$2"

case "$target" in
  linux-x64)
    package_name="@oh-my-pi/pi-natives-linux-x64"
    native_files=(
      pi_natives.linux-x64-baseline.node
      pi_natives.linux-x64-modern.node
    )
    ;;
  linux-arm64)
    package_name="@oh-my-pi/pi-natives-linux-arm64"
    native_files=(pi_natives.linux-arm64.node)
    ;;
  win32-x64)
    package_name="@oh-my-pi/pi-natives-win32-x64"
    native_files=(pi_natives.win32-x64-baseline.node)
    ;;
  *)
    die "unknown native target: $target"
    ;;
esac

work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/fork-native.XXXXXX")"
trap 'rm -rf "$work"' EXIT

spec="${package_name}@latest"
tarball_url="$(npm view "$spec" dist.tarball)"
[[ -n "$tarball_url" ]] || die "npm returned no tarball for $spec"

tarball_file="$work/package.tgz"
curl -fsSL --retry 3 --proto '=https' --proto-redir '=https' "$tarball_url" -o "$tarball_file"

mkdir -p "$work/extracted"
tar --no-same-owner --no-same-permissions -xzf "$tarball_file" -C "$work/extracted"
package_dir="$work/extracted/package"
[[ -f "$package_dir/package.json" ]] || die "downloaded tarball has no package.json: $spec"

mkdir -p "$destination"
for filename in "${native_files[@]}"; do
  [[ -f "$package_dir/$filename" ]] || die "downloaded package is missing $filename"
  cp "$package_dir/$filename" "$destination/$filename"
done

echo "Installed latest official $package_name for $target"
