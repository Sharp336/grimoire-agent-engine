"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { ensurePackagedRuntime, validateRuntimeBundleMetadata } = require("../electron/runtime-install.cjs");

const digest = "a".repeat(64);
function metadata() {
  const addon = "app/node_modules/@oh-my-pi/pi-natives-win32-x64/pi_natives.win32-x64.node";
  return {
    manifest: {
      schemaVersion: 1, appVersion: "17.2.4", platform: "win32", arch: "x64",
      entrypoints: { cli: "app/cli.js", mcp: "app/mcp-main.js" },
      runtime: { kind: "bun", version: "1.3.14", executable: "runtime/bun.exe" },
      native: { package: "@oh-my-pi/pi-natives", version: "0.49.3", platformTag: "win32-x64", napiAbi: 10,
        packageRoot: "app/node_modules/@oh-my-pi/pi-natives", leafRoot: "app/node_modules/@oh-my-pi/pi-natives-win32-x64",
        addon, sha256: digest },
      externals: ["playwright-core", "@modelcontextprotocol/sdk", "@oh-my-pi/pi-natives"],
    },
    checksums: { algorithm: "sha256", files: { "runtime/bun.exe": digest, "app/cli.js": digest, "app/mcp-main.js": digest, [addon]: digest } },
    metadataDigest: "b".repeat(64),
  };
}
function authority(options = {}) {
  const events = [];
  const source = { kind: "source", close: () => events.push("source:close") };
  const installed = { kind: "installed", close: () => events.push("installed:close") };
  return { events, source, installed, native: {
    async openRuntimeBundle(request) { events.push("open"); if (options.openError) throw options.openError; assert.equal(request.expected.version, "17.2.4"); return source; },
    async verifyRuntimeBundle({ bundle }) { events.push(`verify:${bundle.kind}`); if (options.corruptHash && bundle === source) throw new Error("runtime_checksums_invalid"); const value = metadata(); if (options.pathSwap && bundle === installed) value.metadataDigest = "c".repeat(64); return value; },
    async installRuntimeBundleAtomic(request) { events.push("install"); assert.equal(request.source, source); assert.equal(request.ownerPrivate, true); assert.equal(request.replaceAtomically, true); assert.equal(path.basename(request.versionsRoot), "versions"); assert.equal(request.versionKey, "17.2.4-win32-x64"); return installed; },
  } };
}
const app = { isPackaged: true, getVersion: () => "17.2.4" };
const roots = { coreHome: path.resolve("private-app"), resourcesPath: path.resolve("resources") };

test("runtime installation is native-authoritative, private, atomic, and versioned", async () => {
  const fake = authority();
  const result = await ensurePackagedRuntime({ app, ...roots, native: fake.native, platform: "win32", arch: "x64" });
  assert.equal(result.bundle, fake.installed); assert.equal(result.versionKey, "17.2.4-win32-x64");
  assert.equal(result.root, path.join(roots.coreHome, "runtime", "versions", result.versionKey));
  assert.deepEqual(fake.events, ["open", "verify:source", "install", "verify:installed", "source:close"]);
  result.close(); assert.equal(fake.events.at(-1), "installed:close");
});

test("corrupt hashes, path swaps, and broad ACL native rejections fail closed", async () => {
  const corrupt = authority({ corruptHash: true });
  await assert.rejects(ensurePackagedRuntime({ app, ...roots, native: corrupt.native, platform: "win32", arch: "x64" }), /runtime_checksums_invalid/);
  assert.equal(corrupt.events.includes("install"), false);
  const swapped = authority({ pathSwap: true });
  await assert.rejects(ensurePackagedRuntime({ app, ...roots, native: swapped.native, platform: "win32", arch: "x64" }), /runtime_install_identity_changed/);
  assert.equal(swapped.events.includes("installed:close"), true);
  const acl = authority({ openError: Object.assign(new Error("native rejection"), { name: "BroadAclError" }) });
  await assert.rejects(ensurePackagedRuntime({ app, ...roots, native: acl.native, platform: "win32", arch: "x64" }), { name: "BroadAclError" });
  assert.deepEqual(acl.events, ["open"]);
});

test("fixed metadata requires cli.js and mcp-main.js checksums and rejects traversal", () => {
  const value = metadata(); delete value.checksums.files["app/mcp-main.js"];
  assert.throws(() => validateRuntimeBundleMetadata(value.manifest, value.checksums, { version: "17.2.4", platform: "win32", arch: "x64" }), /runtime_required_checksum_missing/);
  value.checksums.files["app/mcp-main.js"] = digest; value.manifest.entrypoints.cli = "../cli.js";
  assert.throws(() => validateRuntimeBundleMetadata(value.manifest, value.checksums, { version: "17.2.4", platform: "win32", arch: "x64" }), /runtime_fixed_entrypoints_invalid/);
});

test("installation fails closed without native authority", async () => {
  await assert.rejects(ensurePackagedRuntime({ app, ...roots, native: {} }), /native_runtime_authority_unavailable/);
});
