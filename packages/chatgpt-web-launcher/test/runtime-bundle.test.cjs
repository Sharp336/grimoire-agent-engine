"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const launcherRoot = path.resolve(__dirname, "..");
const ompRoot = path.resolve(launcherRoot, "../..");
const providerRoot = path.join(ompRoot, "packages", "chatgpt-web");
const runtimeRoot = path.join(launcherRoot, "build", "runtime");
const forbiddenDependency = "@oh-my-pi/pi-" + "coding-agent";
const buildModule = import(pathToFileURL(path.join(launcherRoot, "scripts", "build-runtime-bundle.ts")).href);

function sha256(filePath) {
	return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

test("runtime roots and entrypoints resolve from the launcher package", async () => {
	const { resolveBundleRoots, resolveRuntimeEntrypoints } = await buildModule;
	const scriptDirectory = path.join(launcherRoot, "scripts");
	assert.deepEqual(resolveBundleRoots(scriptDirectory), { launcherRoot, ompRoot, providerRoot });
	assert.deepEqual(resolveRuntimeEntrypoints(scriptDirectory), {
		cli: path.join(providerRoot, "src", "cli.ts"),
		mcp: path.join(providerRoot, "src", "mcp", "main.ts"),
		providerLoader: path.join(launcherRoot, "scripts", "provider-runtime-entry.ts"),
	});
});

test("Bun build options bundle provider code with only fixed externals", async () => {
	const { RUNTIME_EXTERNALS, createBunBuildOptions, resolveRuntimeEntrypoints } = await buildModule;
	assert.deepEqual([...RUNTIME_EXTERNALS], [
		"playwright-core",
		"@modelcontextprotocol/sdk",
		"@oh-my-pi/pi-natives",
	]);
	const entries = resolveRuntimeEntrypoints(path.join(launcherRoot, "scripts"));
	assert.deepEqual(createBunBuildOptions(entries.cli, "runtime-app", "cli.js", "bun", "esm"), {
		entrypoints: [entries.cli],
		target: "bun",
		format: "esm",
		minify: true,
		sourcemap: "none",
		splitting: false,
		packages: "bundle",
		external: [...RUNTIME_EXTERNALS],
		outdir: "runtime-app",
		naming: "cli.js",
	});
	assert.deepEqual(createBunBuildOptions(entries.providerLoader, "launcher-build", "provider-runtime.cjs", "node", "cjs"), {
		entrypoints: [entries.providerLoader],
		target: "node",
		format: "cjs",
		minify: true,
		sourcemap: "none",
		splitting: false,
		packages: "bundle",
		external: [...RUNTIME_EXTERNALS],
		outdir: "launcher-build",
		naming: "provider-runtime.cjs",
	});
});

test("launcher and provider runtime manifests do not declare coding-agent", () => {
	const launcherManifest = JSON.parse(fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"));
	const providerManifest = JSON.parse(fs.readFileSync(path.join(providerRoot, "package.json"), "utf8"));
	assert.equal(launcherManifest.dependencies?.[forbiddenDependency], undefined);
	assert.equal(launcherManifest.optionalDependencies?.[forbiddenDependency], undefined);
	assert.equal(providerManifest.dependencies?.[forbiddenDependency], undefined);
	assert.equal(providerManifest.optionalDependencies?.[forbiddenDependency], undefined);
});

test("native target selection and output paths fail closed", async () => {
	const { NATIVE_TARGETS, safeRelativePath, selectNativeTarget } = await buildModule;
	assert.deepEqual(Object.keys(NATIVE_TARGETS).sort(), [
		"darwin-arm64",
		"darwin-x64",
		"linux-arm64",
		"linux-x64",
		"win32-arm64",
		"win32-x64",
	]);
	for (const [tag, target] of Object.entries(NATIVE_TARGETS)) {
		assert.deepEqual(selectNativeTarget(target.platform, target.arch), { tag, ...target });
	}
	assert.throws(() => selectNativeTarget("freebsd", "x64"), /unsupported_runtime_tuple/);
	const root = path.join(launcherRoot, "build");
	assert.equal(safeRelativePath(root, path.join(root, "runtime")), "runtime");
	assert.throws(() => safeRelativePath(root, launcherRoot), /unsafe_runtime_path/);
});

test("generated bundle checksums, entrypoints, native layout, and notices are attributable", { skip: !fs.existsSync(runtimeRoot) }, () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "manifest.json"), "utf8"));
	const checksums = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "checksums.json"), "utf8"));
	assert.deepEqual(manifest.entrypoints, { cli: "app/cli.js", mcp: "app/mcp-main.js" });
	assert.deepEqual(manifest.externals, ["playwright-core", "@modelcontextprotocol/sdk", "@oh-my-pi/pi-natives"]);
	assert.equal(typeof manifest.native.addon, "string");
	assert.match(manifest.native.addon, new RegExp(`^app/node_modules/@oh-my-pi/pi-natives-${manifest.platform}-${manifest.arch}/`));
	assert.equal(checksums.files[manifest.native.addon], manifest.native.sha256);
	assert.ok(fs.existsSync(path.join(runtimeRoot, "app", "external-lock.json")));
	for (const name of ["app/cli.js", "app/mcp-main.js", "manifest.json", "LICENSES/NOTICE.md", "LICENSES/OpenCodex-MIT.txt"]) {
		assert.equal(checksums.files[name], sha256(path.join(runtimeRoot, ...name.split("/"))));
	}
	for (const name of ["NOTICE.md", "OpenCodex-MIT.txt"]) {
		assert.deepEqual(fs.readFileSync(path.join(runtimeRoot, "LICENSES", name)), fs.readFileSync(path.join(providerRoot, "LICENSES", name)));
	}
	assert.equal(fs.existsSync(path.join(runtimeRoot, "LICENSES", "Bun-runtime.md")), manifest.runtime.kind === "bun");
	assert.ok(!fs.readFileSync(path.join(runtimeRoot, "app", "cli.js"), "utf8").includes(forbiddenDependency));
	assert.ok(!fs.readFileSync(path.join(runtimeRoot, "app", "mcp-main.js"), "utf8").includes(forbiddenDependency));
});
