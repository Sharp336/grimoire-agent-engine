#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
manifest="${FORK_RELEASE_NATIVE_MANIFEST:-$repo_root/.github/fork-release-native-manifest.json}"

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
[[ -f "$manifest" ]] || die "native manifest not found: $manifest"

work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/fork-native.XXXXXX")"
trap 'rm -rf "$work"' EXIT

node - "$manifest" "$target" "$work/metadata" <<'NODE'
const fs = require("node:fs");
const [manifestPath, target, outputPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const entry = manifest.targets?.[target];
if (!entry) {
  throw new Error(`unknown native target ${JSON.stringify(target)}`);
}
if (entry.version !== manifest.source?.version) {
  throw new Error(`${target} version ${entry.version} does not match source ${manifest.source?.version}`);
}
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(entry.version)) {
  throw new Error(`native version is not exact: ${entry.version}`);
}
const files = Object.entries(entry.files ?? {}).sort(([a], [b]) => a.localeCompare(b));
if (files.length === 0) {
  throw new Error(`${target} has no locked .node files`);
}
for (const [filename, digest] of files) {
  if (!/^pi_natives\.[A-Za-z0-9.-]+\.node$/.test(filename)) {
    throw new Error(`unsafe native filename: ${filename}`);
  }
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`invalid SHA-256 for ${filename}`);
  }
}
const lines = [entry.package, entry.version, entry.distIntegrity, ...files.map(([name, hash]) => `${hash}\t${name}`)];
fs.writeFileSync(outputPath, `${lines.join("\n")}\n`);
NODE

mapfile -t metadata < "$work/metadata"
package_name="${metadata[0]:-}"
version="${metadata[1]:-}"
locked_integrity="${metadata[2]:-}"
[[ "$package_name" == @oh-my-pi/pi-natives-* ]] || die "unexpected native package: $package_name"
[[ -n "$locked_integrity" ]] || die "missing locked npm integrity for $target"

spec="${package_name}@${version}"
tarball="$(npm view "$spec" dist.tarball)"
registry_integrity="$(npm view "$spec" dist.integrity)"
[[ -n "$tarball" ]] || die "npm returned no tarball for $spec"
[[ "$registry_integrity" == "$locked_integrity" ]] || die "npm integrity changed for $spec"

mkdir -p "$work/extracted"
curl -fsSL --retry 3 "$tarball" | tar -xz -C "$work/extracted"
package_dir="$work/extracted/package"
[[ -f "$package_dir/package.json" ]] || die "downloaded tarball has no package.json: $spec"

node - "$package_dir/package.json" "$package_name" "$version" <<'NODE'
const fs = require("node:fs");
const [manifestPath, expectedName, expectedVersion] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.name !== expectedName || manifest.version !== expectedVersion) {
  throw new Error(`downloaded ${manifest.name}@${manifest.version}; expected ${expectedName}@${expectedVersion}`);
}
NODE

expected_files="$work/expected-files.txt"
expected_sums="$work/SHA256SUMS.txt"
: > "$expected_files"
: > "$expected_sums"
for line in "${metadata[@]:3}"; do
  digest="${line%%$'\t'*}"
  filename="${line#*$'\t'}"
  printf '%s\n' "$filename" >> "$expected_files"
  printf '%s  %s\n' "$digest" "$filename" >> "$expected_sums"
done
sort -o "$expected_files" "$expected_files"

find "$package_dir" -maxdepth 1 -type f -name '*.node' -printf '%f\n' | sort > "$work/actual-files.txt"
if ! diff -u "$expected_files" "$work/actual-files.txt"; then
  die "native file set changed for $spec"
fi

(
  cd "$package_dir"
  sha256sum -c "$expected_sums"
)

mkdir -p "$destination"
while IFS= read -r filename; do
  cp "$package_dir/$filename" "$destination/$filename"
done < "$expected_files"

echo "Verified and installed $spec for $target"
