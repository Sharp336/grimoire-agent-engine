"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"));
const runtimeRoot = path.join(launcherRoot, "build", "runtime");
const outputRoot = path.join(launcherRoot, manifest.build.directories.output);
const builderCli = require.resolve("electron-builder/out/cli/cli.js", { paths: [launcherRoot] });

const TARGETS = Object.freeze({
	darwin: Object.freeze({ flag: "--mac", os: "mac", extensions: Object.freeze(["dmg", "zip"]) }),
	linux: Object.freeze({ flag: "--linux", os: "linux", extensions: Object.freeze(["AppImage"]) }),
	win32: Object.freeze({ flag: "--win", os: "win", extensions: Object.freeze(["exe"]) }),
});
const ARCHES = Object.freeze(new Set(["x64", "arm64"]));

function assertPlainTree(root) {
	const rootInfo = fs.lstatSync(root);
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("unsafe_packaging_resource");
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error("unsafe_packaging_resource");
		const value = path.join(root, entry.name);
		if (entry.isDirectory()) assertPlainTree(value);
		else if (fs.lstatSync(value).nlink !== 1) throw new Error("unsafe_packaging_resource");
	}
}

function sanitizedBuildEnvironment(source = process.env) {
	const allowed = ["HOME", "PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR", "WINDIR", "XDG_CACHE_HOME"];
	const env = Object.create(null);
	for (const name of allowed) {
		if (typeof source[name] === "string" && source[name].length > 0) env[name] = source[name];
	}
	env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
	env.ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES = "false";
	return env;
}

function expectedArtifactNames(platform = process.platform, arch = process.arch) {
	const target = TARGETS[platform];
	if (!target || !ARCHES.has(arch)) throw new Error("unsupported_package_tuple");
	return target.extensions.map(extension => `omp-chatgpt-web-${manifest.version}-${target.os}-${arch}.${extension}`);
}

function createBuilderArguments(platform, arch, staging) {
	const target = TARGETS[platform];
	if (!target || !ARCHES.has(arch)) throw new Error("unsupported_package_tuple");
	const artifactTemplate = `omp-chatgpt-web-${manifest.version}-${target.os}-${arch}.\${ext}`;
	return Object.freeze([
		builderCli,
		target.flag,
		`--${arch}`,
		"--publish",
		"never",
		`--config.directories.output=${staging}`,
		`--config.artifactName=${artifactTemplate}`,
		...(target.flag === "--mac" ? ["--config.mac.identity=-"] : []),
	]);
}

function validateInputs() {
	if (manifest.name !== "@oh-my-pi/pi-chatgpt-web-launcher" || manifest.version !== "17.2.7" || manifest.private !== true) {
		throw new Error("launcher_package_identity_mismatch");
	}
	if (manifest.build.appId !== "sh.omp.chatgpt-web" || manifest.build.productName !== "OMP ChatGPT Web") {
		throw new Error("launcher_application_identity_mismatch");
	}
	for (const file of ["manifest.json", "checksums.json", "LICENSES/NOTICE.md", "LICENSES/OpenCodex-MIT.txt", "LICENSES/Bun-runtime.md"]) {
		const value = path.join(runtimeRoot, ...file.split("/"));
		const info = fs.lstatSync(value);
		if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("runtime_packaging_resource_missing");
	}
	for (const icon of ["assets/icon.png", "assets/icon.ico"]) {
		const value = path.join(launcherRoot, ...icon.split("/"));
		const info = fs.lstatSync(value);
		if (!info.isFile() || info.isSymbolicLink()) throw new Error("launcher_icon_missing");
	}
	assertPlainTree(runtimeRoot);
}

function packageLauncher(requestedFlag = process.argv[2]) {
	const target = TARGETS[process.platform];
	if (!target || !ARCHES.has(process.arch)) throw new Error("unsupported_package_tuple");
	if (requestedFlag !== undefined && requestedFlag !== target.flag) throw new Error("cross_packaging_forbidden");
	validateInputs();
	const staging = fs.mkdtempSync(path.join(os.tmpdir(), "omp-chatgpt-web-package-"));
	try {
		const builderArguments = createBuilderArguments(process.platform, process.arch, staging);
		const result = spawnSync(process.execPath, builderArguments, {
			cwd: launcherRoot,
			env: sanitizedBuildEnvironment(),
			stdio: "ignore",
			windowsHide: true,
			shell: false,
		});
		if (result.error || result.signal || result.status !== 0) throw new Error("electron_packaging_failed");
		const expected = expectedArtifactNames();
		const produced = fs.readdirSync(staging, { withFileTypes: true })
			.filter(entry => entry.isFile())
			.map(entry => entry.name)
			.sort();
		for (const name of expected) {
			if (!produced.includes(name)) throw new Error("deterministic_package_artifact_missing");
		}
		fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
		for (const entry of fs.readdirSync(outputRoot, { withFileTypes: true })) {
			if (entry.isFile() && /^omp-chatgpt-web-.*\.(?:AppImage|dmg|exe|zip|blockmap)$/i.test(entry.name)) {
				fs.rmSync(path.join(outputRoot, entry.name), { force: true });
			}
		}
		for (const name of expected) fs.copyFileSync(path.join(staging, name), path.join(outputRoot, name));
		for (const name of produced.filter(name => expected.some(base => name === `${base}.blockmap`))) {
			fs.copyFileSync(path.join(staging, name), path.join(outputRoot, name));
		}
		return expected.map(name => path.join(outputRoot, name));
	} finally {
		fs.rmSync(staging, { recursive: true, force: true });
	}
}

module.exports = {
	TARGETS,
	sanitizedBuildEnvironment,
	createBuilderArguments,
	expectedArtifactNames,
	packageLauncher,
};

if (require.main === module) packageLauncher();
