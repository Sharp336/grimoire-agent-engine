"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"));
const prepareSource = fs.readFileSync(path.join(launcherRoot, "scripts", "prepare-runtime.cjs"), "utf8");
const packageSource = fs.readFileSync(path.join(launcherRoot, "scripts", "package.cjs"), "utf8");
const smokeSource = fs.readFileSync(path.join(launcherRoot, "scripts", "smoke-package.cjs"), "utf8");
const mainSource = fs.readFileSync(path.join(launcherRoot, "electron", "main.cjs"), "utf8");

test("launcher metadata is private and OMP-owned", () => {
	assert.equal(manifest.name, "@oh-my-pi/pi-chatgpt-web-launcher");
	assert.equal(manifest.version, "17.2.5");
	assert.equal(manifest.private, true);
	assert.equal(manifest.build.appId, "sh.omp.chatgpt-web");
	assert.equal(manifest.build.productName, "OMP ChatGPT Web");
	assert.equal(manifest.build.artifactName, "omp-chatgpt-web-${version}-${os}-${arch}.${ext}");
	assert.equal(manifest.dependencies["@oh-my-pi/pi-chatgpt-web"], "workspace:*");
	assert.equal(manifest.publishConfig, undefined);
});

test("package scripts prepare deterministic runtime and never publish", () => {
	assert.equal(manifest.scripts["prepare:runtime"], "bun scripts/prepare-runtime.cjs");
	assert.equal(manifest.scripts["build:runtime"], "bun scripts/prepare-runtime.cjs");
	assert.equal(manifest.scripts["smoke:package"], "node scripts/smoke-package.cjs");
	assert.match(manifest.scripts.package, /bun run build:runtime/);
	assert.doesNotMatch(JSON.stringify(manifest.scripts), /npm publish|bun publish|electron-builder.*--publish always/i);
	assert.match(packageSource, /"--publish",\s*\n\s*"never"/);
	assert.match(packageSource, /electron-builder\/out\/cli\/cli\.js/);
	assert.match(packageSource, /cross_packaging_forbidden/);
});

test("Electron targets, icons, AppImage, and ASAR resource paths are fixed", () => {
	assert.equal(manifest.build.asar, true);
	assert.deepEqual(manifest.build.mac.target, ["dmg", "zip"]);
	assert.deepEqual(manifest.build.win.target, ["nsis"]);
	assert.deepEqual(manifest.build.linux.target, ["AppImage"]);
	assert.equal(manifest.build.mac.icon, "assets/icon.png");
	assert.equal(manifest.build.win.icon, "assets/icon.ico");
	assert.equal(manifest.build.linux.icon, "assets/icon.png");
	assert.ok(manifest.build.files.includes("assets/icon.png"));
	assert.ok(manifest.build.files.includes("assets/icon.ico"));
	assert.ok(manifest.build.files.includes("build/provider-runtime.cjs"));
	assert.deepEqual(manifest.build.extraResources, [{ from: "build/runtime", to: "runtime" }]);
	assert.ok(fs.existsSync(path.join(launcherRoot, "assets", "icon.png")));
	assert.ok(fs.existsSync(path.join(launcherRoot, "assets", "icon.ico")));
	assert.equal(manifest.build.nsis.perMachine, false);
	assert.equal(manifest.build.nsis.allowElevation, false);
	assert.equal(manifest.build.nsis.runAfterFinish, false);
});

test("runtime preparation uses explicit roots and exact notices", () => {
	assert.match(prepareSource, /const launcherRoot = path\.resolve\(__dirname, "\.\."\)/);
	assert.match(prepareSource, /const ompRoot = path\.resolve\(launcherRoot, "\.\.\/\.\."\)/);
	assert.match(prepareSource, /const providerRoot = path\.join\(ompRoot, "packages", "chatgpt-web"\)/);
	assert.match(prepareSource, /\["NOTICE\.md", "OpenCodex-MIT\.txt"\]/);
	assert.match(prepareSource, /Bun-runtime\.md/);
	assert.doesNotMatch(prepareSource, /generate-third-party-notices|env:\s*process\.env/);
});

test("package smoke uses an isolated app root and an allowlisted readiness event", () => {
	assert.match(smokeSource, /const READY_MARKER = "OMP_CHATGPT_WEB_SMOKE_READY"/);
	assert.match(smokeSource, /OMP_CHATGPT_WEB_APP_DIR/);
	assert.match(smokeSource, /OMP_CHATGPT_WEB_SMOKE_MARKER/);
	assert.match(smokeSource, /"--smoke"/);
	assert.match(mainSource, /const SMOKE_READY_MARKER = "OMP_CHATGPT_WEB_SMOKE_READY"/);
	assert.match(mainSource, /ensurePackagedRuntime/);
	assert.match(mainSource, /installed\.close\(\)/);
	assert.doesNotMatch(mainSource, /console\.(?:log|error)|process\.stderr/);
	assert.match(smokeSource, /assertAbsoluteNormalized\(appDir\)/);
	assert.match(smokeSource, /runtime", "versions"/);
	assert.match(smokeSource, /packaged_smoke_unclean_shutdown/);
	assert.match(smokeSource, /package_smoke_output_leak/);
	assert.match(smokeSource, /fs\.rmSync\(scratch, \{ recursive: true, force: true \}\)/);
	assert.doesNotMatch(smokeSource, /\.\.\.process\.env/);
	assert.doesNotMatch(smokeSource, /https?:\/\/[A-Za-z0-9]/);
});
