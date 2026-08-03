"use strict";

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const READY_MARKER = "OMP_CHATGPT_WEB_SMOKE_READY";
const launcherRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"));
const artifactsRoot = path.join(launcherRoot, manifest.build.directories.output);
const MAX_OUTPUT_BYTES = 64 * 1024;
const SMOKE_TIMEOUT_MS = 120_000;
const EXPECTED_MARKER_KEYS = Object.freeze(["arch", "marker", "packaged", "platform", "ready", "runtimeVerified", "version"]);

function assertAbsoluteNormalized(value) {
	if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value) throw new Error("invalid_smoke_path");
	return value;
}

function expectedArtifactName(platform = process.platform, arch = process.arch) {
	if (!new Set(["x64", "arm64"]).has(arch)) throw new Error("unsupported_smoke_tuple");
	if (platform === "darwin") return `omp-chatgpt-web-${manifest.version}-mac-${arch}.zip`;
	if (platform === "linux") return `omp-chatgpt-web-${manifest.version}-linux-${arch}.AppImage`;
	if (platform === "win32") return `omp-chatgpt-web-${manifest.version}-win-${arch}.exe`;
	throw new Error("unsupported_smoke_tuple");
}

function locateArtifact(platform = process.platform, arch = process.arch) {
	const expected = expectedArtifactName(platform, arch);
	const matches = fs.readdirSync(artifactsRoot, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name === expected);
	if (matches.length !== 1) throw new Error("package_artifact_not_unique");
	const artifact = path.join(artifactsRoot, expected);
	const info = fs.lstatSync(artifact);
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("unsafe_package_artifact");
	return artifact;
}

function smokeEnvironment(appDir, markerPath, source = process.env) {
	assertAbsoluteNormalized(appDir);
	assertAbsoluteNormalized(markerPath);
	const env = Object.create(null);
	for (const name of ["HOME", "PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR", "WINDIR"]) {
		if (typeof source[name] === "string" && source[name].length > 0) env[name] = source[name];
	}
	env.HOME = appDir;
	env.OMP_CHATGPT_WEB_APP_DIR = appDir;
	env.OMP_CHATGPT_WEB_SMOKE_MARKER = markerPath;
	env.OMP_CHATGPT_WEB_SMOKE = "1";
	return env;
}

function runOwnedCommand(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: "ignore",
		timeout: options.timeout ?? SMOKE_TIMEOUT_MS,
		windowsHide: true,
		shell: false,
	});
	if (result.error || result.signal || result.status !== 0) throw new Error("package_smoke_platform_step_failed");
}

function prepareExecutable(artifact, scratch, env) {
	if (process.platform === "darwin") {
		const stage = path.join(scratch, "application");
		fs.mkdirSync(stage, { mode: 0o700 });
		runOwnedCommand("/usr/bin/ditto", ["-x", "-k", artifact, stage], { cwd: scratch, env });
		const executable = path.join(stage, `${manifest.build.productName}.app`, "Contents", "MacOS", manifest.build.productName);
		const info = fs.lstatSync(executable);
		if (!info.isFile() || info.isSymbolicLink()) throw new Error("packaged_executable_missing");
		return { command: executable, prefix: [] };
	}
	if (process.platform === "linux") {
		fs.chmodSync(artifact, 0o700);
		if (!fs.existsSync("/usr/bin/xvfb-run")) throw new Error("headless_display_runner_missing");
		env.APPIMAGE_EXTRACT_AND_RUN = "1";
		return { command: "/usr/bin/xvfb-run", prefix: ["-a", artifact] };
	}
	if (process.platform === "win32") {
		const installRoot = path.join(scratch, "application");
		fs.mkdirSync(installRoot, { mode: 0o700 });
		runOwnedCommand(artifact, ["/S", `/D=${installRoot}`], { cwd: scratch, env, timeout: 120_000 });
		const executable = path.join(installRoot, `${manifest.build.productName}.exe`);
		const info = fs.lstatSync(executable);
		if (!info.isFile() || info.isSymbolicLink()) throw new Error("packaged_executable_missing");
		return { command: executable, prefix: [] };
	}
	throw new Error("unsupported_smoke_tuple");
}

function appendBounded(current, chunk) {
	const next = current + chunk.toString("utf8");
	if (Buffer.byteLength(next, "utf8") > MAX_OUTPUT_BYTES) throw new Error("package_smoke_output_limit");
	return next;
}

function assertSafeOutput(stdout, stderr, forbiddenValues) {
	const output = `${stdout}\n${stderr}`;
	for (const value of forbiddenValues) if (value && output.includes(value)) throw new Error("package_smoke_output_leak");
	const forbidden = [
		/https?:\/\//i,
		/\b(?:authorization|bearer|cookie|token|secret|prompt|profile)\b/i,
		/[A-Za-z]:\\[^\r\n]*/,
		/(?:^|\s)\/(?:Users|home|tmp|var)\/[^\s]*/,
		/\b[A-Za-z0-9_-]{40,}\b/,
	];
	if (forbidden.some(pattern => pattern.test(output))) throw new Error("package_smoke_output_leak");
	const stdoutLines = stdout.split(/\r?\n/).filter(Boolean);
	const stderrLines = stderr.split(/\r?\n/).filter(Boolean);
	if (stderrLines.length !== 0 || stdoutLines.length !== 1 || stdoutLines[0] !== READY_MARKER) throw new Error("package_smoke_output_not_allowlisted");
}

function readReadyMarker(markerPath) {
	const info = fs.lstatSync(markerPath);
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096) throw new Error("unsafe_smoke_marker");
	const value = JSON.parse(fs.readFileSync(markerPath, "utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_smoke_marker");
	if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(EXPECTED_MARKER_KEYS)) throw new Error("invalid_smoke_marker");
	if (
		value.marker !== READY_MARKER || value.ready !== true || value.packaged !== true || value.runtimeVerified !== true
		|| value.version !== manifest.version || value.platform !== process.platform || value.arch !== process.arch
	) throw new Error("invalid_smoke_marker");
	return value;
}

function verifyPersistedRuntime(appDir) {
	const versionRoot = path.join(appDir, "runtime", "versions", `${manifest.version}-${process.platform}-${process.arch}`);
	assertAbsoluteNormalized(versionRoot);
	const rootInfo = fs.lstatSync(versionRoot);
	if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("runtime_persistence_missing");
	for (const name of ["manifest.json", "checksums.json", "LICENSES/NOTICE.md", "LICENSES/OpenCodex-MIT.txt", "LICENSES/Bun-runtime.md"]) {
		const filePath = path.join(versionRoot, ...name.split("/"));
		const info = fs.lstatSync(filePath);
		if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("runtime_persistence_missing");
	}
	const runtimeManifest = JSON.parse(fs.readFileSync(path.join(versionRoot, "manifest.json"), "utf8"));
	if (runtimeManifest.appVersion !== manifest.version || runtimeManifest.platform !== process.platform || runtimeManifest.arch !== process.arch) throw new Error("runtime_persistence_identity_mismatch");
}

function runPackagedSmoke(command, args, options) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
		let stdout = "";
		let stderr = "";
		let markerObserved = false;
		let settled = false;
		let markerTimer;
		let timeout;
		const fail = error => {
			if (settled) return;
			settled = true;
			clearInterval(markerTimer);
			clearTimeout(timeout);
			if (child.exitCode === null && child.signalCode === null) child.kill();
			reject(error);
		};
		child.stdout.on("data", chunk => { try { stdout = appendBounded(stdout, chunk); } catch (error) { fail(error); } });
		child.stderr.on("data", chunk => { try { stderr = appendBounded(stderr, chunk); } catch (error) { fail(error); } });
		child.once("error", () => fail(new Error("packaged_smoke_launch_failed")));
		markerTimer = setInterval(() => {
			if (!markerObserved && fs.existsSync(options.markerPath)) {
				try { readReadyMarker(options.markerPath); markerObserved = true; } catch (error) { fail(error); }
			}
		}, 20);
		timeout = setTimeout(() => fail(new Error("packaged_smoke_timeout")), SMOKE_TIMEOUT_MS);
		child.once("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearInterval(markerTimer);
			clearTimeout(timeout);
			try {
				if (!markerObserved) readReadyMarker(options.markerPath);
				if (code !== 0 || signal !== null) throw new Error("packaged_smoke_unclean_shutdown");
				assertSafeOutput(stdout, stderr, options.forbiddenValues);
				resolve();
			} catch (error) { reject(error); }
		});
	});
}

async function smokePackage() {
	const scratch = assertAbsoluteNormalized(fs.mkdtempSync(path.join(os.tmpdir(), "omp-chatgpt-web-smoke-")));
	const appDir = assertAbsoluteNormalized(path.join(scratch, "app-data"));
	const markerPath = assertAbsoluteNormalized(path.join(appDir, "ready.json"));
	fs.mkdirSync(appDir, { recursive: true, mode: 0o700 });
	try {
		const artifact = locateArtifact();
		const env = smokeEnvironment(appDir, markerPath);
		const prepared = prepareExecutable(artifact, scratch, env);
		await runPackagedSmoke(prepared.command, [...prepared.prefix, "--smoke", `--user-data-dir=${appDir}`], {
			cwd: scratch,
			env,
			markerPath,
			forbiddenValues: [scratch, appDir, markerPath],
		});
		verifyPersistedRuntime(appDir);
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

module.exports = {
	READY_MARKER,
	assertAbsoluteNormalized,
	expectedArtifactName,
	locateArtifact,
	smokeEnvironment,
	assertSafeOutput,
	readReadyMarker,
	verifyPersistedRuntime,
	smokePackage,
};

if (require.main === module) {
	smokePackage().catch(() => {
		process.stderr.write("package_smoke_failed\n");
		process.exitCode = 1;
	});
}
