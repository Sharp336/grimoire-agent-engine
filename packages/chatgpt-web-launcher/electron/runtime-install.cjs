"use strict";

const path = require("node:path");

const MANIFEST_SCHEMA_VERSION = 1;
const MAX_METADATA_BYTES = 1024 * 1024;
const REQUIRED_EXTERNALS = Object.freeze([
  "@modelcontextprotocol/sdk",
  "@oh-my-pi/pi-natives",
  "playwright-core",
]);

function isSafeRelativePath(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && !value.includes("\0")
    && !value.includes("\\")
    && !path.posix.isAbsolute(value)
    && path.posix.normalize(value) === value
    && !value.split("/").includes("..");
}

function validateRuntimeBundleMetadata(manifest, checksums, expected) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
    || !checksums || typeof checksums !== "object" || Array.isArray(checksums)) {
    throw new Error("runtime_metadata_invalid");
  }
  if (Buffer.byteLength(JSON.stringify({ manifest, checksums })) > MAX_METADATA_BYTES) {
    throw new Error("runtime_metadata_oversized");
  }
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION
    || manifest.appVersion !== expected.version
    || manifest.platform !== expected.platform
    || manifest.arch !== expected.arch) {
    throw new Error("runtime_identity_mismatch");
  }
  const executable = expected.platform === "win32" ? "runtime/bun.exe" : "runtime/bun";
  if (manifest.entrypoints?.cli !== "app/cli.js"
    || manifest.entrypoints?.mcp !== "app/mcp-main.js"
    || manifest.runtime?.kind !== "bun"
    || manifest.runtime?.executable !== executable
    || typeof manifest.runtime?.version !== "string"
    || manifest.runtime.version.length === 0) {
    throw new Error("runtime_fixed_entrypoints_invalid");
  }
  const native = manifest.native;
  if (!native || typeof native !== "object"
    || native.package !== "@oh-my-pi/pi-natives"
    || typeof native.version !== "string"
    || typeof native.platformTag !== "string"
    || !Number.isInteger(native.napiAbi)
    || !isSafeRelativePath(native.packageRoot)
    || !isSafeRelativePath(native.leafRoot)
    || !isSafeRelativePath(native.addon)
    || !/^[0-9a-f]{64}$/.test(native.sha256)) {
    throw new Error("runtime_native_metadata_invalid");
  }
  if (!Array.isArray(manifest.externals)
    || manifest.externals.length !== REQUIRED_EXTERNALS.length
    || [...manifest.externals].sort().some((value, index) => value !== REQUIRED_EXTERNALS[index])) {
    throw new Error("runtime_externals_invalid");
  }
  if (checksums.algorithm !== "sha256"
    || !checksums.files
    || typeof checksums.files !== "object"
    || Array.isArray(checksums.files)) throw new Error("runtime_checksums_invalid");
  for (const [relativePath, digest] of Object.entries(checksums.files)) {
    if (!isSafeRelativePath(relativePath) || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error("runtime_checksums_invalid");
    }
  }
  for (const required of [executable, "app/cli.js", "app/mcp-main.js", native.addon]) {
    if (!Object.hasOwn(checksums.files, required)) throw new Error("runtime_required_checksum_missing");
  }
  return Object.freeze({
    version: expected.version,
    platform: expected.platform,
    arch: expected.arch,
    executable,
    cli: "app/cli.js",
    mcp: "app/mcp-main.js",
  });
}

function expectedRuntimeIdentity(app, options = {}) {
  const version = app.getVersion();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("runtime_version_invalid");
  }
  if (!["darwin", "linux", "win32"].includes(platform) || !["arm64", "x64"].includes(arch)) {
    throw new Error("runtime_target_unsupported");
  }
  return Object.freeze({ version, platform, arch });
}

function closeCapability(capability) {
  if (capability && typeof capability.close === "function") capability.close();
}

async function validateRuntimeBundle(bundle, expected, native) {
  if (!native || typeof native.verifyRuntimeBundle !== "function") throw new Error("native_runtime_authority_unavailable");
  const inspected = await native.verifyRuntimeBundle({ bundle, expected });
  if (!inspected || typeof inspected !== "object") throw new Error("native_runtime_verification_invalid");
  const summary = validateRuntimeBundleMetadata(inspected.manifest, inspected.checksums, expected);
  if (typeof inspected.metadataDigest !== "string" || !/^[0-9a-f]{64}$/.test(inspected.metadataDigest)) {
    throw new Error("runtime_metadata_digest_invalid");
  }
  return Object.freeze({ ...summary, metadataDigest: inspected.metadataDigest });
}

async function ensurePackagedRuntime({ app, coreHome, resourcesPath, native, platform, arch }) {
  if (!app.isPackaged) return null;
  if (!native
    || typeof native.openRuntimeBundle !== "function"
    || typeof native.verifyRuntimeBundle !== "function"
    || typeof native.installRuntimeBundleAtomic !== "function") {
    throw new Error("native_runtime_authority_unavailable");
  }
  if (typeof coreHome !== "string" || !path.isAbsolute(coreHome)
    || typeof resourcesPath !== "string" || !path.isAbsolute(resourcesPath)) {
    throw new Error("runtime_install_root_invalid");
  }
  const expected = expectedRuntimeIdentity(app, { platform, arch });
  const versionKey = `${expected.version}-${expected.platform}-${expected.arch}`;
  const sourceRoot = path.join(resourcesPath, "runtime");
  const versionsRoot = path.join(coreHome, "runtime", "versions");
  const installedRoot = path.join(versionsRoot, versionKey);
  let source;
  let installed;
  try {
    source = await native.openRuntimeBundle({ root: sourceRoot, expected });
    const sourceSummary = await validateRuntimeBundle(source, expected, native);
    installed = await native.installRuntimeBundleAtomic({
      source,
      versionsRoot,
      versionKey,
      ownerPrivate: true,
      replaceAtomically: true,
    });
    const installedSummary = await validateRuntimeBundle(installed, expected, native);
    if (sourceSummary.metadataDigest !== installedSummary.metadataDigest) throw new Error("runtime_install_identity_changed");
    const capability = installed;
    installed = null;
    return Object.freeze({
      bundle: capability,
      version: expected.version,
      platform: expected.platform,
      arch: expected.arch,
      versionKey,
      root: installedRoot,
      metadataDigest: installedSummary.metadataDigest,
      close: () => closeCapability(capability),
    });
  } finally {
    closeCapability(source);
    closeCapability(installed);
  }
}

module.exports = {
  MANIFEST_SCHEMA_VERSION,
  REQUIRED_EXTERNALS,
  ensurePackagedRuntime,
  expectedRuntimeIdentity,
  isSafeRelativePath,
  validateRuntimeBundle,
  validateRuntimeBundleMetadata,
};
