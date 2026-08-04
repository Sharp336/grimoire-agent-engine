"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const ompRoot = path.resolve(launcherRoot, "../..");
const providerRoot = path.join(ompRoot, "packages", "chatgpt-web");
const outputRoot = path.join(launcherRoot, "build", "runtime");
const bundleScript = path.join(launcherRoot, "scripts", "build-runtime-bundle.ts");

function assertAbsoluteNormalized(value) {
	if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value) {
		throw new Error("invalid_runtime_build_path");
	}
	return value;
}

function assertPlainFile(filePath) {
	const info = fs.lstatSync(filePath);
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("unsafe_runtime_notice");
}

function copyProviderNotices(output = outputRoot) {
	assertAbsoluteNormalized(output);
	const destination = path.join(output, "LICENSES");
	fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
	for (const name of ["NOTICE.md", "OpenCodex-MIT.txt"]) {
		const source = path.join(providerRoot, "LICENSES", name);
		assertPlainFile(source);
		fs.copyFileSync(source, path.join(destination, name));
	}
	const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8"));
	const bunNotice = path.join(destination, "Bun-runtime.md");
	if (manifest.runtime?.kind === "bun") {
		assertPlainFile(bunNotice);
		const notice = fs.readFileSync(bunNotice, "utf8");
		if (typeof manifest.runtime.version !== "string" || !notice.includes(`Bun ${manifest.runtime.version}`)) {
			throw new Error("bun_runtime_notice_mismatch");
		}
	} else if (fs.existsSync(bunNotice)) {
		throw new Error("unexpected_bun_runtime_notice");
	}
}

function buildEnvironment() {
	return Object.freeze({
		OMP_CHATGPT_WEB_BUILD: "1",
		PATH: path.dirname(process.execPath),
	});
}

function prepareRuntime() {
	assertAbsoluteNormalized(launcherRoot);
	assertAbsoluteNormalized(ompRoot);
	assertAbsoluteNormalized(providerRoot);
	assertAbsoluteNormalized(outputRoot);
	if (!process.versions.bun) throw new Error("bun_runtime_required");
	const result = spawnSync(process.execPath, [
		bundleScript,
		`--output=${outputRoot}`,
		`--platform=${process.platform}`,
		`--arch=${process.arch}`,
		"--redistribute-bun",
	], {
		cwd: ompRoot,
		env: buildEnvironment(),
		stdio: "ignore",
		windowsHide: true,
		shell: false,
	});
	if (result.error || result.signal || result.status !== 0) throw new Error("runtime_bundle_preparation_failed");
	copyProviderNotices(outputRoot);
	return outputRoot;
}

module.exports = {
	launcherRoot,
	ompRoot,
	providerRoot,
	outputRoot,
	buildEnvironment,
	copyProviderNotices,
	prepareRuntime,
};

if (require.main === module) prepareRuntime();
