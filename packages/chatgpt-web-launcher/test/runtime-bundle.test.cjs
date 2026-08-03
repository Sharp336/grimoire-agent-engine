"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const ompRoot = path.resolve(launcherRoot, "../..");
const providerRoot = path.join(ompRoot, "packages", "chatgpt-web");
const buildSource = fs.readFileSync(path.join(launcherRoot, "scripts", "build-runtime-bundle.ts"), "utf8");
const providerLoaderEntry = path.join(launcherRoot, "scripts", "provider-runtime-entry.ts");
const providerLoaderSource = fs.readFileSync(providerLoaderEntry, "utf8");
const runtimeRoot = path.join(launcherRoot, "build", "runtime");
const forbiddenDependency = "@oh-my-pi/pi-" + "coding-agent";

function importedSpecifiers(source) {
	const values = [];
	const pattern = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
	for (const match of source.matchAll(pattern)) values.push(match[1] || match[2]);
	return values;
}

function resolveRelative(fromFile, specifier) {
	if (!specifier.startsWith(".")) return null;
	const base = path.resolve(path.dirname(fromFile), specifier);
	for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, "index.ts")]) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
	}
	throw new Error("unresolved_provider_import");
}

function assertReachableGraph(entrypoints) {
	const pending = [...entrypoints];
	const visited = new Set();
	while (pending.length > 0) {
		const file = pending.pop();
		if (visited.has(file)) continue;
		assert.ok(file.startsWith(`${providerRoot}${path.sep}`));
		visited.add(file);
		const source = fs.readFileSync(file, "utf8");
		assert.ok(!source.includes(forbiddenDependency));
		for (const specifier of importedSpecifiers(source)) {
			assert.notEqual(specifier, forbiddenDependency);
			const resolved = resolveRelative(file, specifier);
			if (resolved) pending.push(resolved);
		}
	}
	return visited;
}

function sha256(filePath) {
	return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

test("runtime roots and entrypoints are explicit", () => {
	assert.match(buildSource, /const launcherRoot = resolve\(scriptDirectory, "\.\."\)/);
	assert.match(buildSource, /const ompRoot = resolve\(launcherRoot, "\.\.\/\.\."\)/);
	assert.match(buildSource, /const providerRoot = join\(ompRoot, "packages", "chatgpt-web"\)/);
	assert.match(buildSource, /join\(providerRoot, "src", "cli\.ts"\)/);
	assert.match(buildSource, /join\(providerRoot, "src", "mcp", "main\.ts"\)/);
	assert.ok(buildSource.includes('"cli.js"'));
	assert.ok(buildSource.includes('"mcp-main.js"'));
	assert.match(buildSource, /join\(launcherRoot, "scripts", "provider-runtime-entry\.ts"\)/);
	assert.match(buildSource, /naming:\s*"provider-runtime\.cjs"/);
});

test("Bun bundles provider code with only fixed externals", () => {
	assert.match(buildSource, /packages:\s*"bundle"/);
	assert.doesNotMatch(buildSource, /packages:\s*"external"/);
	const block = buildSource.match(/export const RUNTIME_EXTERNALS = Object\.freeze\(\[([\s\S]*?)\]\s+as const\);/);
	assert.ok(block);
	assert.deepEqual([...block[1].matchAll(/"([^"]+)"/g)].map(match => match[1]), [
		"playwright-core", "@modelcontextprotocol/sdk", "@oh-my-pi/pi-natives",
	]);
});

test("CLI, MCP, and packaged epoch-factory graphs never import coding-agent", () => {
	const entries = [
		path.join(providerRoot, "src", "cli.ts"),
		path.join(providerRoot, "src", "mcp", "main.ts"),
		path.join(providerRoot, "src", "mcp", "tunnel.ts"),
	];
	const visited = assertReachableGraph(entries);
	assert.ok(entries.every(entry => visited.has(entry)));
	const manifest = JSON.parse(fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"));
	assert.equal(manifest.dependencies[forbiddenDependency], undefined);
	assert.match(providerLoaderSource, /createNativeFullRuntimeEpochFactory as createChatGptWebLauncherEpochFactory/);
	assert.doesNotMatch(providerLoaderSource, new RegExp(forbiddenDependency));
});

test("native layout is target-specific and fail-closed", () => {
	for (const tag of ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]) assert.ok(buildSource.includes(`"${tag}"`));
	for (const file of ["native/index.js", "native/loader-state.js", "native/embedded-addon.js"]) assert.ok(buildSource.includes(`"${file}"`));
	for (const guard of ["native_target_package_unavailable", "native_target_checksum_mismatch", "linked_native_target_package", "info.nlink !== 1"]) assert.ok(buildSource.includes(guard));
	assert.match(buildSource, /addon: `app\/node_modules\/@oh-my-pi\/pi-natives-\$\{target\.tag\}\/\$\{selectedAddon\}`/);
	assert.match(buildSource, /sha256: addonHashes\[selectedAddon\]/);
	assert.match(buildSource, /external-lock\.json/);
});

test("generated bundle checksums and notices are attributable", { skip: !fs.existsSync(runtimeRoot) }, () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "manifest.json"), "utf8"));
	const checksums = JSON.parse(fs.readFileSync(path.join(runtimeRoot, "checksums.json"), "utf8"));
	assert.deepEqual(manifest.entrypoints, { cli: "app/cli.js", mcp: "app/mcp-main.js" });
	assert.equal(typeof manifest.native.addon, "string");
	assert.match(manifest.native.addon, new RegExp(`^app/node_modules/@oh-my-pi/pi-natives-${manifest.platform}-${manifest.arch}/`));
	assert.equal(checksums.files[manifest.native.addon], manifest.native.sha256);
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
