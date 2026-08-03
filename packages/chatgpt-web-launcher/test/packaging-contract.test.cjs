"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"));
const {
	TARGETS,
	createBuilderArguments,
	expectedArtifactNames,
	packageLauncher,
	sanitizedBuildEnvironment,
} = require("../scripts/package.cjs");
const {
	buildEnvironment,
	copyProviderNotices,
	launcherRoot: preparedLauncherRoot,
	ompRoot,
	providerRoot,
} = require("../scripts/prepare-runtime.cjs");
const {
	READY_MARKER,
	assertAbsoluteNormalized,
	assertSafeOutput,
	readReadyMarker,
	smokeEnvironment,
} = require("../scripts/smoke-package.cjs");
const { SMOKE_READY_MARKER, runSmokeMode } = require("../electron/main.cjs");

function temporaryDirectory(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-launcher-contract-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	return root;
}

function runtimeMetadata() {
	const executable = process.platform === "win32" ? "runtime/bun.exe" : "runtime/bun";
	const addon = `app/node_modules/@oh-my-pi/pi-natives-${process.platform}-${process.arch}/addon.node`;
	const digest = "a".repeat(64);
	return {
		manifest: {
			schemaVersion: 1,
			appVersion: manifest.version,
			platform: process.platform,
			arch: process.arch,
			entrypoints: { cli: "app/cli.js", mcp: "app/mcp-main.js" },
			runtime: { kind: "bun", version: "1.3.14", executable },
			native: {
				package: "@oh-my-pi/pi-natives",
				version: manifest.version,
				platformTag: `${process.platform}-${process.arch}`,
				napiAbi: 10,
				packageRoot: "app/node_modules/@oh-my-pi/pi-natives",
				leafRoot: `app/node_modules/@oh-my-pi/pi-natives-${process.platform}-${process.arch}`,
				addon,
				sha256: digest,
			},
			externals: ["playwright-core", "@modelcontextprotocol/sdk", "@oh-my-pi/pi-natives"],
		},
		checksums: {
			algorithm: "sha256",
			files: { [executable]: digest, "app/cli.js": digest, "app/mcp-main.js": digest, [addon]: digest },
		},
		metadataDigest: "b".repeat(64),
	};
}

test("launcher metadata is private and OMP-owned", () => {
	assert.equal(manifest.name, "@oh-my-pi/pi-chatgpt-web-launcher");
	assert.equal(manifest.version, "17.2.6");
	assert.equal(manifest.private, true);
	assert.equal(manifest.build.appId, "sh.omp.chatgpt-web");
	assert.equal(manifest.build.productName, "OMP ChatGPT Web");
	assert.equal(manifest.build.artifactName, "omp-chatgpt-web-${version}-${os}-${arch}.${ext}");
	assert.equal(manifest.dependencies["@oh-my-pi/pi-chatgpt-web"], "workspace:*");
	assert.equal(manifest.publishConfig, undefined);
});

test("package scripts prepare deterministic runtime and never publish", t => {
	const staging = path.join(temporaryDirectory(t), "staging");
	assert.equal(manifest.scripts["prepare:runtime"], "bun scripts/prepare-runtime.cjs");
	assert.equal(manifest.scripts["build:runtime"], "bun scripts/prepare-runtime.cjs");
	assert.equal(manifest.scripts["smoke:package"], "node scripts/smoke-package.cjs");
	assert.equal(manifest.scripts.package, "bun run build && bun run build:runtime && node scripts/package.cjs");
	for (const [platform, target] of Object.entries(TARGETS)) {
		const args = createBuilderArguments(platform, "x64", staging);
		assert.equal(args[0], require.resolve("electron-builder/out/cli/cli.js", { paths: [launcherRoot] }));
		assert.equal(args[1], target.flag);
		assert.ok(args.includes("--x64"));
		assert.deepEqual(args.slice(args.indexOf("--publish"), args.indexOf("--publish") + 2), ["--publish", "never"]);
		assert.ok(args.includes(`--config.directories.output=${staging}`));
		for (const name of expectedArtifactNames(platform, "x64")) assert.match(name, /^omp-chatgpt-web-17\.2\.6-/);
	}
	const forbiddenFlag = Object.values(TARGETS).find(target => target.flag !== TARGETS[process.platform].flag).flag;
	assert.throws(() => packageLauncher(forbiddenFlag), /cross_packaging_forbidden/);
	assert.deepEqual({ ...sanitizedBuildEnvironment({ PATH: "safe", SECRET: "canary", NODE_OPTIONS: "--require=evil" }) }, {
		PATH: "safe",
		CSC_IDENTITY_AUTO_DISCOVERY: "false",
		ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES: "false",
	});
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

test("runtime preparation uses fixed roots, a minimal environment, and exact notices", t => {
	assert.equal(preparedLauncherRoot, launcherRoot);
	assert.equal(ompRoot, path.resolve(launcherRoot, "../.."));
	assert.equal(providerRoot, path.join(ompRoot, "packages", "chatgpt-web"));
	assert.deepEqual(buildEnvironment(), {
		OMP_CHATGPT_WEB_BUILD: "1",
		PATH: path.dirname(process.execPath),
	});
	const output = path.join(temporaryDirectory(t), "runtime");
	fs.mkdirSync(output, { recursive: true });
	fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify({ runtime: { kind: "external" } }));
	copyProviderNotices(output);
	assert.deepEqual(fs.readdirSync(path.join(output, "LICENSES")).sort(), ["NOTICE.md", "OpenCodex-MIT.txt"]);
	for (const name of ["NOTICE.md", "OpenCodex-MIT.txt"]) {
		assert.deepEqual(
			fs.readFileSync(path.join(output, "LICENSES", name)),
			fs.readFileSync(path.join(providerRoot, "LICENSES", name)),
		);
	}
});

test("package smoke isolates state, allowlists output, and closes verified runtime ownership", async t => {
	const root = temporaryDirectory(t);
	const appDir = path.join(root, "app-data");
	const markerPath = path.join(appDir, "ready.json");
	const resourcesPath = path.join(root, "resources");
	fs.mkdirSync(appDir, { recursive: true });
	fs.mkdirSync(resourcesPath, { recursive: true });
	assert.equal(READY_MARKER, "OMP_CHATGPT_WEB_SMOKE_READY");
	assert.equal(SMOKE_READY_MARKER, READY_MARKER);
	assert.equal(assertAbsoluteNormalized(appDir), appDir);
	assert.throws(() => assertAbsoluteNormalized("relative"), /invalid_smoke_path/);
	const env = smokeEnvironment(appDir, markerPath, { PATH: "safe", SECRET: "canary", NODE_OPTIONS: "--require=evil" });
	assert.deepEqual({ ...env }, {
		PATH: "safe",
		HOME: appDir,
		OMP_CHATGPT_WEB_APP_DIR: appDir,
		OMP_CHATGPT_WEB_SMOKE_MARKER: markerPath,
		OMP_CHATGPT_WEB_SMOKE: "1",
	});
	assert.doesNotThrow(() => assertSafeOutput(`${READY_MARKER}\n`, "", [root]));
	assert.throws(() => assertSafeOutput(`${READY_MARKER}\nhttps://example.invalid\n`, "", []), /package_smoke_output_leak/);

	let sourceClosed = 0;
	let installedClosed = 0;
	const source = { close() { sourceClosed += 1; } };
	const installed = { close() { installedClosed += 1; } };
	const output = [];
	await runSmokeMode({
		app: { isPackaged: true, getVersion: () => manifest.version },
		native: {
			async openRuntimeBundle() { return source; },
			async verifyRuntimeBundle() { return runtimeMetadata(); },
			async installRuntimeBundleAtomic() { return installed; },
		},
		appDir,
		markerPath,
		resourcesPath,
		writeOutput(line) { output.push(line); },
	});
	assert.deepEqual(output, [`${READY_MARKER}\n`]);
	assert.equal(sourceClosed, 1);
	assert.equal(installedClosed, 1);
	assert.deepEqual(readReadyMarker(markerPath), {
		marker: READY_MARKER,
		ready: true,
		packaged: true,
		runtimeVerified: true,
		version: manifest.version,
		platform: process.platform,
		arch: process.arch,
	});
});
