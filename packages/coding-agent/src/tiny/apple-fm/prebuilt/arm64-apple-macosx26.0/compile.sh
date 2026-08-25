#!/bin/sh
# Rebuild this Mach-O and its cacheIdentity sibling after editing sidecar.swift.
set -euo pipefail
here=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
src="$here/../../sidecar.swift"
out="$here/omp-apple-fm"
xcrun --sdk macosx swiftc -O -parse-as-library -target arm64-apple-macosx26.0 -o "$out" "$src"
cd "$here"
bun --eval 'import { createHash } from "node:crypto";
import sidecarSource from "../../sidecar.swift" with { type: "text" };
const id = createHash("sha256").update(sidecarSource).update("\0").update("arm64-apple-macosx26.0").digest("hex").slice(0, 16);
await Bun.write("digest.txt", id + "\n");
'
