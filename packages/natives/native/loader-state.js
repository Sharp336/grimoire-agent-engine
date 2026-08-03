import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";
import packageJson from "../package.json" with { type: "json" };
import { embeddedAddon } from "./embedded-addon.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
/**
 * Native addon loader for `@oh-my-pi/pi-natives`.
 *
 * Owns every step between "Node imports `native/index.js`" and "the right
 * `pi_natives.<platform>-<arch>*.node` is required, validated, and returned":
 * platform/variant detection, candidate-path resolution, on-disk staging from
 * `node_modules` (Windows update safety), embedded-addon extraction (Bun
 * standalone binaries), version-sentinel validation, and the aggregated error
 * surface for diagnostic-friendly failures.
 *
 * `native/index.js` is reduced to one `loadNative()` call plus the generated
 * surface-area exports between `MARKER_START`/`MARKER_END` (rewritten by
 * `scripts/gen-enums.ts`); everything else lives here so the pure helpers stay
 * unit-testable without triggering the side-effectful module-load path.
 *
 * Background (issue #823): `bun build --compile --define PI_COMPILED=true`
 * substitutes the bare identifier `PI_COMPILED`, NOT `process.env.PI_COMPILED`,
 * so a runtime read of the env var returns `undefined`. Older CommonJS loader
 * code also saw the original build-host absolute path in `__filename`; ESM
 * `import.meta.url` is rewritten to the bunfs URL. The embedded-addon
 * presence (true iff the build pipeline ran `embed:native`, false in the
 * post-build `--reset` stub) is the authoritative compiled-mode signal.
 */

const SUPPORTED_PLATFORMS = [
	"linux-x64",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
	"win32-x64",
	"win32-arm64",
];
const EXPECTED_NAPI_ABI = packageJson.ompNative.napiAbi;
const EXPECTED_PLATFORM_TAGS = packageJson.ompNative.platformTags;

/**
 * Streaming startup marker, enabled by `PI_DEBUG_STARTUP`. Local copy of the
 * pi-utils helper (this loader cannot depend on pi-utils). Synchronous on
 * purpose: extraction/dlopen hangs must still leave the `:start` marker.
 * @param {string} text
 */
function startupMarker(text) {
	if (!process.env.PI_DEBUG_STARTUP) return;
	try {
		fs.writeSync(2, `[startup] ${text}\n`);
	} catch {
		// stderr unavailable; markers are best-effort
	}
}

function getNativesDir() {
	const xdgDataHome = process.env.XDG_DATA_HOME;
	if (xdgDataHome && fs.existsSync(path.join(xdgDataHome, "omp"))) {
		return path.join(xdgDataHome, "omp", "natives");
	}
	return path.join(os.homedir(), ".omp", "natives");
}

function resolveLeafPackage(platformTag) {
	const require_ = createRequire(import.meta.url);
	let manifestPath;
	try {
		manifestPath = require_.resolve(`@oh-my-pi/pi-natives-${platformTag}/package.json`);
	} catch (err) {
		if (err && err.code === "MODULE_NOT_FOUND") return null;
		throw err;
	}
	const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	return { dir: path.dirname(manifestPath), manifest };
}

// =========================================================================
// Pure helpers — re-exported for unit tests in `packages/natives/test/`.
// =========================================================================
/**
 * @param {string} platform
 * @param {string} arch
 * @returns {string}
 */
export function selectNativePlatformTag(platform, arch) {
	const platformTag = `${platform}-${arch}`;
	if (!SUPPORTED_PLATFORMS.includes(platformTag) || !EXPECTED_PLATFORM_TAGS.includes(platformTag)) {
		throw new Error(
			`Unsupported platform: ${platformTag}\n` +
				`Supported platforms: ${SUPPORTED_PLATFORMS.join(", ")}\n` +
				"If you need support for this platform, please open an issue.",
		);
	}
	return platformTag;
}

/**
 * @param {{
 *   metadata: unknown;
 *   platformTag: string;
 *   runtimeNapiAbi?: string | number;
 *   packageNapiAbi?: number;
 * }} input
 */
export function validateNativeAddonMetadata({
	metadata,
	platformTag,
	runtimeNapiAbi = process.versions.napi ?? "0",
	packageNapiAbi = EXPECTED_NAPI_ABI,
}) {
	if (!metadata || typeof metadata !== "object") {
		throw new Error(`Native addon metadata missing for ${platformTag}`);
	}
	const value = /** @type {Record<string, unknown>} */ (metadata);
	if (value.platformTag !== platformTag) {
		throw new Error(`Native addon architecture mismatch: expected ${platformTag}, got ${String(value.platformTag)}`);
	}
	if (value.napiAbi !== packageNapiAbi) {
		throw new Error(
			`Native addon ABI mismatch for ${platformTag}: expected N-API ${packageNapiAbi}, got ${String(value.napiAbi)}`,
		);
	}
	const runtimeAbi = Number(runtimeNapiAbi);
	if (!Number.isInteger(runtimeAbi) || runtimeAbi < packageNapiAbi) {
		throw new Error(
			`Native addon ABI mismatch for ${platformTag}: runtime provides N-API ${String(runtimeNapiAbi)}, ` +
				`but N-API ${packageNapiAbi} is required`,
		);
	}
	const arch = platformTag.endsWith("-arm64") ? "arm64" : platformTag.endsWith("-x64") ? "x64" : "";
	const allowedFilenames = new Set(
		getAddonFilenames({ tag: platformTag, arch, variant: arch === "x64" ? "modern" : null }),
	);
	if (!value.files || typeof value.files !== "object" || Array.isArray(value.files)) {
		throw new Error(`Native addon file metadata missing for ${platformTag}`);
	}
	const files = /** @type {Record<string, unknown>} */ (value.files);
	if (Object.keys(files).length === 0) throw new Error(`Native addon file metadata missing for ${platformTag}`);
	for (const [filename, fileMetadata] of Object.entries(files)) {
		if (!isSafeEmbeddedAddonFilename(filename) || !allowedFilenames.has(filename)) {
			throw new Error(`Native addon metadata contains an invalid filename for ${platformTag}: ${filename}`);
		}
		const sha256 =
			fileMetadata && typeof fileMetadata === "object"
				? /** @type {Record<string, unknown>} */ (fileMetadata).sha256
				: undefined;
		if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) {
			throw new Error(`Native addon metadata contains an invalid SHA-256 for ${filename}`);
		}
	}
	return /** @type {{ platformTag: string; napiAbi: number; files: Record<string, { sha256: string }> }} */ (value);
}

/**
 * @param {{ filePath: string; sha256: string }} input
 */
export function verifyNativeAddonFile({ filePath, sha256 }) {
	const hash = crypto.createHash("sha256");
	const fd = fs.openSync(filePath, "r");
	const buffer = Buffer.allocUnsafe(64 * 1024);
	try {
		for (;;) {
			const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			hash.update(buffer.subarray(0, bytesRead));
		}
	} finally {
		fs.closeSync(fd);
	}
	const actual = hash.digest("hex");
	if (actual !== sha256) {
		throw new Error(`Native addon checksum mismatch for ${path.basename(filePath)}: expected ${sha256}, got ${actual}`);
	}
}

/**
 * @param {{
 *   embeddedAddon: { platformTag: string; version: string; files: unknown[] } | null | undefined;
 *   env: Record<string, string | undefined>;
 *   importMetaUrl: string | null | undefined;
 * }} input
 * @returns {boolean}
 */
export function detectCompiledBinary({ embeddedAddon, env, importMetaUrl }) {
	if (embeddedAddon) return true;
	if (env && env.PI_COMPILED) return true;
	if (typeof importMetaUrl === "string") {
		if (importMetaUrl.includes("$bunfs")) return true;
		if (importMetaUrl.includes("~BUN")) return true;
		if (importMetaUrl.includes("%7EBUN")) return true;
	}
	return false;
}

/**
 * @param {{ tag: string; arch: string; variant: "modern" | "baseline" | null | undefined }} input
 * @returns {string[]}
 */
export function getAddonFilenames({ tag, arch, variant }) {
	const defaultFilename = `pi_natives.${tag}.node`;
	if (arch !== "x64" || !variant) return [defaultFilename];
	const baselineFilename = `pi_natives.${tag}-baseline.node`;
	const modernFilename = `pi_natives.${tag}-modern.node`;
	if (variant === "modern") {
		return [modernFilename, baselineFilename, defaultFilename];
	}
	return [baselineFilename, defaultFilename];
}

/**
 * Decide whether the loader should mirror the package's `native/<filename>.node`
 * into the per-version cache directory (`~/.omp/natives/<version>/`) before loading.
 *
 * Windows-only safety net for `bun install -g` updates: when a previous `omp`
 * process is running, bun cannot overwrite the locked `.node` inside
 * `node_modules/@oh-my-pi/pi-natives/native/`, leaving an old binary next to a
 * newer `index.js` and producing `<sym> is not a function` crashes on the next
 * launch. Staging into the version-pinned cache:
 *   1. Gives every package version its own filesystem path, so concurrent omp
 *      processes never collide on the same file.
 *   2. Makes the running process keep its handle on the cache copy, freeing bun
 *      to overwrite the `node_modules` copy on subsequent updates.
 * Disabled on non-Windows (no file-lock problem), in workspace dev (`nativeDir`
 * is not inside a `node_modules` segment), and for compiled binaries (handled
 * by `maybeExtractEmbeddedAddon`).
 *
 * @param {{ platform: NodeJS.Platform | string; isCompiledBinary: boolean; nativeDir: string }} input
 * @returns {boolean}
 */
export function shouldStageNodeModulesAddon({ platform, isCompiledBinary, nativeDir }) {
	if (platform !== "win32") return false;
	if (isCompiledBinary) return false;
	// Check both separators independently of the host's `path.sep`: this helper
	// is shared by the loader (running on Windows with `\`) and the test suite
	// (typically running on POSIX hosts when CI executes the regression test).
	const normalizedNativeDir = nativeDir.toLowerCase();
	return normalizedNativeDir.includes("\\node_modules\\") || normalizedNativeDir.includes("/node_modules/");
}

/**
 * @param {{
 *   addonFilenames: string[];
 *   isCompiledBinary: boolean;
 *   stageFromNodeModules?: boolean;
 *   nativeDir: string;
 *   leafPackageDir?: string | null;
 *   execDir: string;
 *   versionedDir: string;
 *   userDataDir: string;
 * }} input
 * @returns {string[]}
 */
export function resolveLoaderCandidates({
	addonFilenames,
	isCompiledBinary,
	stageFromNodeModules = false,
	nativeDir,
	leafPackageDir = null,
	execDir,
	versionedDir,
	userDataDir,
}) {
	const baseReleaseCandidates = addonFilenames.flatMap(filename => [
		path.join(nativeDir, filename),
		path.join(execDir, filename),
	]);
	const leafCandidates = leafPackageDir ? addonFilenames.map(filename => path.join(leafPackageDir, filename)) : [];
	const compiledCandidates = addonFilenames.flatMap(filename => [
		path.join(versionedDir, filename),
		path.join(userDataDir, filename),
	]);
	const stagedCandidates = stageFromNodeModules ? addonFilenames.map(filename => path.join(versionedDir, filename)) : [];
	let releaseCandidates;
	if (isCompiledBinary) {
		releaseCandidates = [...compiledCandidates, ...baseReleaseCandidates];
	} else if (stageFromNodeModules) {
		releaseCandidates = [...stagedCandidates, ...leafCandidates, ...baseReleaseCandidates];
	} else {
		releaseCandidates = [...leafCandidates, ...baseReleaseCandidates];
	}
	return [...new Set(releaseCandidates)];
}

// =========================================================================

function parseReleaseVersion(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isOlderReleaseVersion(candidate, current) {
	const candidateParts = parseReleaseVersion(candidate);
	const currentParts = parseReleaseVersion(current);
	if (!candidateParts || !currentParts) return false;
	for (let index = 0; index < candidateParts.length; index++) {
		if (candidateParts[index] !== currentParts[index]) {
			return candidateParts[index] < currentParts[index];
		}
	}
	return false;
}

/**
 * Remove version-pinned native cache directories older than the loaded package.
 * Best-effort by design: permission errors and concurrent processes must not
 * abort startup after the native addon has already loaded successfully.
 *
 * @param {{ nativesDir: string; currentVersion: string }} input
 * @returns {string[]}
 */
export function cleanupStaleNativeVersions({ nativesDir, currentVersion }) {
	const removed = [];
	let entries;
	try {
		entries = fs.readdirSync(nativesDir, { withFileTypes: true });
	} catch {
		return removed;
	}

	for (const entry of entries) {
		if (!entry.isDirectory() || !isOlderReleaseVersion(entry.name, currentVersion)) continue;
		const targetPath = path.join(nativesDir, entry.name);
		try {
			fs.rmSync(targetPath, { recursive: true, force: true });
			removed.push(targetPath);
		} catch {
			// Stale caches are opportunistic cleanup only.
		}
	}
	return removed;
}

// Side-effectful loader. Everything below runs only when `loadNative()` is
// called from `native/index.js` — tests that only import the pure helpers
// above pay nothing for variant detection, subprocess spawns, or fs probes.
// =========================================================================

/**
 * Hidden env key for the resolved x64 variant. Once any context (main thread,
 * worker, subprocess) finishes variant detection, the result is written here
 * so every Bun worker and child process spawned afterwards inherits the same
 * verdict and skips re-detection. See `selectCpuVariant` for the lookup order.
 */
const VARIANT_CACHE_ENV_KEY = "__PI_NATIVE_VARIANT_CACHE";

/**
 * Spawn `command` with `args` and capture stdout. Prefers `Bun.spawnSync`
 * because Bun's `child_process.spawnSync` shim has been observed to return
 * non-zero / null in worker threads on macOS even when the same binary works
 * fine from the parent — the failure mode behind issue #3238, where the worker
 * silently falls back to the "baseline" variant. Falls back to the Node shim
 * for non-Bun embeds.
 */
function runCommand(command, args) {
	if (typeof Bun !== "undefined" && typeof Bun.spawnSync === "function") {
		try {
			const result = Bun.spawnSync([command, ...args], { stdout: "pipe", stderr: "pipe" });
			if (result.exitCode === 0) {
				return result.stdout.toString("utf-8").trim();
			}
		} catch {
			// fall through to childProcess
		}
	}
	try {
		const result = childProcess.spawnSync(command, args, { encoding: "utf-8" });
		if (result.error) return null;
		if (result.status !== 0) return null;
		return (result.stdout || "").trim();
	} catch {
		return null;
	}
}

function getVariantOverride() {
	const value = process.env.PI_NATIVE_VARIANT;
	if (!value) return null;
	if (value === "modern" || value === "baseline") return value;
	return null;
}

function detectAvx2Support() {
	if (process.arch !== "x64") {
		return false;
	}

	if (process.platform === "linux") {
		try {
			const cpuInfo = fs.readFileSync("/proc/cpuinfo", "utf8");
			return /\bavx2\b/i.test(cpuInfo);
		} catch {
			return false;
		}
	}

	if (process.platform === "darwin") {
		// Try the absolute path before bare `sysctl`: PATH may not include
		// `/usr/sbin` in worker/embedded spawn contexts (issue #3238).
		for (const sysctlBin of ["/usr/sbin/sysctl", "sysctl"]) {
			const leaf7 = runCommand(sysctlBin, ["-n", "machdep.cpu.leaf7_features"]);
			if (leaf7 && /\bAVX2\b/i.test(leaf7)) return true;
			const features = runCommand(sysctlBin, ["-n", "machdep.cpu.features"]);
			if (features && /\bAVX2\b/i.test(features)) return true;
		}
		return false;
	}

	if (process.platform === "win32") {
		const output = runCommand("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			"[System.Runtime.Intrinsics.X86.Avx2]::IsSupported",
		]);
		return output && output.toLowerCase() === "true";
	}

	return false;
}

/**
 * Pure variant-selection helper, exposed for unit tests. Resolution order:
 *
 *   1. `override` (user-facing `PI_NATIVE_VARIANT` env var). Always wins.
 *   2. The private `__PI_NATIVE_VARIANT_CACHE` env var, populated by the first
 *      context that detected at runtime. Lets child workers / subprocesses
 *      inherit the main thread's verdict instead of re-spawning `sysctl` etc.
 *      from a worker context where the spawn may fail (issue #3238).
 *   3. `detectAvx2()` — the slow path, called at most once per process.
 *
 * Non-x64 architectures return `{ variant: null }` and never set the cache.
 * When detection runs, the result is surfaced as `cacheEnvKey`/`cacheEnvValue`
 * so the caller can write `process.env` (the pure helper itself stays
 * side-effect-free, which keeps it easy to test).
 *
 * @param {{
 *   arch: string;
 *   override: "modern" | "baseline" | null | undefined;
 *   env: Record<string, string | undefined>;
 *   detectAvx2: () => boolean;
 * }} input
 * @returns {{
 *   variant: "modern" | "baseline" | null;
 *   source: "non-x64" | "override" | "cache" | "detect";
 *   cacheEnvKey?: string;
 *   cacheEnvValue?: string;
 * }}
 */
export function selectCpuVariant({ arch, override, env, detectAvx2 }) {
	if (arch !== "x64") return { variant: null, source: "non-x64" };
	if (override === "modern" || override === "baseline") {
		return { variant: override, source: "override" };
	}
	const cached = env[VARIANT_CACHE_ENV_KEY];
	if (cached === "modern" || cached === "baseline") {
		return { variant: cached, source: "cache" };
	}
	const variant = detectAvx2() ? "modern" : "baseline";
	return {
		variant,
		source: "detect",
		cacheEnvKey: VARIANT_CACHE_ENV_KEY,
		cacheEnvValue: variant,
	};
}

function resolveCpuVariant(override, arch) {
	const result = selectCpuVariant({
		arch,
		override,
		env: process.env,
		detectAvx2: detectAvx2Support,
	});
	if (result.cacheEnvKey) {
		process.env[result.cacheEnvKey] = result.cacheEnvValue;
	}
	return result.variant;
}

/**
 * @param {{
 *   addon: import("./loader-state.js").EmbeddedAddon;
 *   platformTag: string;
 *   arch: string;
 *   variant: "modern" | "baseline" | null;
 *   runtimeNapiAbi?: string | number;
 * }} input
 */
export function selectEmbeddedAddonFile({ addon, platformTag, arch, variant, runtimeNapiAbi }) {
	const metadata = validateNativeAddonMetadata({
		metadata: {
			platformTag: addon.platformTag,
			napiAbi: addon.napiAbi,
			files: Object.fromEntries(addon.files.map(file => [file.filename, { sha256: file.sha256 }])),
		},
		platformTag,
		runtimeNapiAbi,
	});
	const files = addon.files.filter(file => file.filename in metadata.files);
	const defaultFile = files.find(file => file.variant === "default") || null;
	if (arch !== "x64") return defaultFile;
	if (variant === "modern") {
		return files.find(file => file.variant === "modern") || files.find(file => file.variant === "baseline") || null;
	}
	return files.find(file => file.variant === "baseline") || null;
}

function readTarString(buffer, offset, length) {
	const end = Math.min(offset + length, buffer.length);
	let stringEnd = offset;
	while (stringEnd < end && buffer[stringEnd] !== 0) stringEnd++;
	return buffer.toString("utf8", offset, stringEnd);
}

function readTarOctal(buffer, offset, length) {
	const value = readTarString(buffer, offset, length).trim();
	if (!value) return 0;
	const parsed = Number.parseInt(value, 8);
	if (!Number.isFinite(parsed)) {
		throw new Error(`Invalid tar octal value: ${value}`);
	}
	return parsed;
}

function isZeroTarBlock(buffer, offset) {
	for (let index = 0; index < 512; index++) {
		if (buffer[offset + index] !== 0) return false;
	}
	return true;
}

function getTarEntryName(header) {
	const name = readTarString(header, 0, 100);
	const prefix = readTarString(header, 345, 155);
	return prefix ? `${prefix}/${name}` : name;
}

function isSafeEmbeddedAddonFilename(filename) {
	return filename.length > 0 && path.basename(filename) === filename && !filename.includes("/") && !filename.includes("\\");
}

function isEmbeddedAddonFileCurrent(targetPath, file) {
	try {
		const stat = fs.lstatSync(targetPath);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size) return false;
		verifyNativeAddonFile({ filePath: targetPath, sha256: file.sha256 });
		return true;
	} catch (err) {
		if (err && (err.code === "ENOENT" || String(err.message).includes("checksum mismatch"))) return false;
		throw err;
	}
}

function canonicalSafeTargetDirectory(targetDir) {
	const resolvedTargetDir = path.resolve(targetDir);
	const { root } = path.parse(resolvedTargetDir);
	let current = root;
	for (const component of resolvedTargetDir.slice(root.length).split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		const stat = fs.lstatSync(current);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error(`Unsafe embedded addon target directory: ${targetDir}`);
		}
	}
	return fs.realpathSync.native(resolvedTargetDir);
}

function writeEmbeddedAddonFile(targetPath, content) {
	const tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
	try {
		fs.writeFileSync(tempPath, content, { mode: 0o755 });
		fs.renameSync(tempPath, targetPath);
	} catch (err) {
		try {
			fs.unlinkSync(tempPath);
		} catch {
			// Best-effort cleanup only.
		}
		throw err;
	}
}

export function extractEmbeddedAddonArchive({ archivePath, archiveSha256, files, targetDir }) {
	const expected = new Map();
	for (const file of files) {
		if (!isSafeEmbeddedAddonFilename(file.filename)) {
			throw new Error(`Unsafe embedded addon filename: ${file.filename}`);
		}
		if (expected.has(file.filename)) throw new Error(`Duplicate embedded addon filename: ${file.filename}`);
		expected.set(file.filename, file);
	}
	const realTargetDir = canonicalSafeTargetDirectory(targetDir);
	if ([...expected].every(([filename, file]) => isEmbeddedAddonFileCurrent(path.join(realTargetDir, filename), file))) {
		return [];
	}

	const archiveGzip = fs.readFileSync(archivePath);
	if (archiveSha256) {
		const actualArchiveSha256 = crypto.createHash("sha256").update(archiveGzip).digest("hex");
		if (actualArchiveSha256 !== archiveSha256) {
			throw new Error(
				`Embedded addon archive checksum mismatch: expected ${archiveSha256}, got ${actualArchiveSha256}`,
			);
		}
	}
	const archive = zlib.gunzipSync(archiveGzip);
	const entries = new Map();
	let offset = 0;

	while (offset + 512 <= archive.length) {
		if (isZeroTarBlock(archive, offset)) break;
		const header = archive.subarray(offset, offset + 512);
		const filename = getTarEntryName(header);
		const size = readTarOctal(header, 124, 12);
		const typeflag = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
		offset += 512;
		if (offset + size > archive.length) {
			throw new Error(`Truncated embedded addon archive entry: ${filename}`);
		}
		if (!isSafeEmbeddedAddonFilename(filename)) {
			throw new Error(`Unsafe embedded addon archive entry: ${filename}`);
		}
		if (typeflag !== "0") {
			throw new Error(`Unsupported embedded addon archive entry type ${typeflag}: ${filename}`);
		}
		if (!expected.has(filename)) throw new Error(`Unexpected embedded addon archive entry: ${filename}`);
		if (entries.has(filename)) throw new Error(`Duplicate embedded addon archive entry: ${filename}`);
		const file = expected.get(filename);
		if (file.size !== size) {
			throw new Error(`Embedded addon size mismatch for ${filename}: expected ${file.size}, got ${size}`);
		}
		const content = archive.subarray(offset, offset + size);
		const actualSha256 = crypto.createHash("sha256").update(content).digest("hex");
		if (actualSha256 !== file.sha256) {
			throw new Error(
				`Embedded addon checksum mismatch for ${filename}: expected ${file.sha256}, got ${actualSha256}`,
			);
		}
		entries.set(filename, content);
		offset += Math.ceil(size / 512) * 512;
	}
	const missing = [...expected.keys()].filter(filename => !entries.has(filename));
	if (missing.length > 0) throw new Error(`Embedded addon archive missing: ${missing.join(", ")}`);

	const writtenPaths = [];
	for (const [filename, file] of expected) {
		const targetPath = path.join(realTargetDir, filename);
		if (isEmbeddedAddonFileCurrent(targetPath, file)) continue;
		writeEmbeddedAddonFile(targetPath, entries.get(filename));
		writtenPaths.push(targetPath);
	}
	return writtenPaths;
}

function maybeExtractEmbeddedAddon(ctx, errors) {
	if (!ctx.isCompiledBinary || !embeddedAddon) return null;
	const selectedEmbeddedFile = selectEmbeddedAddonFile({
		addon: embeddedAddon,
		platformTag: ctx.platformTag,
		arch: ctx.arch,
		variant: ctx.selectedVariant,
		runtimeNapiAbi: ctx.runtimeNapiAbi,
	});
	if (!selectedEmbeddedFile) return null;
	const targetPath = path.join(ctx.versionedDir, selectedEmbeddedFile.filename);

	startupMarker("native:extractEmbeddedAddon:start");
	try {
		fs.mkdirSync(ctx.versionedDir, { recursive: true });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		errors.push(`embedded addon dir: ${message}`);
		return null;
	}

	if (embeddedAddon.archive) {
		try {
			extractEmbeddedAddonArchive({
				archivePath: embeddedAddon.archive.filePath,
				archiveSha256: embeddedAddon.archive.sha256,
				files: embeddedAddon.files,
				targetDir: ctx.versionedDir,
			});
			if (isEmbeddedAddonFileCurrent(targetPath, selectedEmbeddedFile)) {
				return targetPath;
			}
			errors.push(`embedded addon archive (${embeddedAddon.archive.filename}): missing ${selectedEmbeddedFile.filename}`);
			return null;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`embedded addon archive (${embeddedAddon.archive.filename}): ${message}`);
			return null;
		}
	}

	if (isEmbeddedAddonFileCurrent(targetPath, selectedEmbeddedFile)) {
		return targetPath;
	}
	if (!selectedEmbeddedFile.filePath) {
		errors.push(`embedded addon metadata missing file path for ${selectedEmbeddedFile.filename}`);
		return null;
	}

	try {
		const buffer = fs.readFileSync(selectedEmbeddedFile.filePath);
		const actualSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
		if (actualSha256 !== selectedEmbeddedFile.sha256) {
			throw new Error(
				`Embedded addon checksum mismatch for ${selectedEmbeddedFile.filename}: ` +
					`expected ${selectedEmbeddedFile.sha256}, got ${actualSha256}`,
			);
		}
		writeEmbeddedAddonFile(targetPath, buffer);
		return targetPath;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		errors.push(`embedded addon write (${selectedEmbeddedFile.filename}): ${message}`);
		return null;
	}
}

/**
 * Mirror `leafPackageDir ?? nativeDir` addon binaries to
 * `versionedDir/<filename>.node` on Windows installs so the running process
 * cache path, never on the `node_modules` copy that bun must overwrite on
 * update. No-op on non-Windows, in workspace dev, and for compiled binaries —
 * see `shouldStageNodeModulesAddon` for the gating rules.
 */
function maybeStageNodeModulesAddon(ctx, errors) {
	if (!ctx.stageFromNodeModules) return null;

	let stagedPath = null;
	for (const filename of ctx.addonFilenames) {
		const sourcePath = path.join(ctx.leafPackageDir ?? ctx.nativeDir, filename);
		const targetPath = path.join(ctx.versionedDir, filename);

		if (fs.existsSync(targetPath)) {
			stagedPath = stagedPath || targetPath;
			continue;
		}
		if (!fs.existsSync(sourcePath)) continue;

		try {
			fs.mkdirSync(ctx.versionedDir, { recursive: true });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`staged addon dir: ${message}`);
			continue;
		}

		try {
			// `copyFileSync` is atomic on Windows (CopyFileW) and avoids holding
			// two large buffers in JS for the read/write dance.
			fs.copyFileSync(sourcePath, targetPath);
			stagedPath = stagedPath || targetPath;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`staged addon copy (${filename}): ${message}`);
		}
	}
	return stagedPath;
}

export function validateLoadedBindings(ctx, bindings, candidate) {
	// In workspace dev (running out of `packages/natives/native/` rather than a
	// `node_modules` install or a compiled bundle) the local `.node` only gains
	// the renamed sentinel after `bun --cwd=packages/natives run build`. Skip
	// validation there so a stale post-pull dev tree boots while the rebuild
	// completes; install and compiled-binary paths still validate.
	if (ctx.isWorkspaceLoad) return;
	if (typeof bindings[ctx.versionSentinelExport] === "function") return;

	// The expected sentinel is missing. Distinguish two failure modes by the
	// sentinel the bindings DO carry:
	//   - disk stale: the `.node` on disk predates this loader (its own build);
	//     reinstalling re-syncs the file.
	//   - process stale: an in-place upgrade landed a new release on disk while
	//     this process still holds the previous addon generation resident in the
	//     dynamic-loader's native-module cache. `require` returns those old
	//     exports, which carry the PRIOR sentinel — disk is already consistent,
	//     so reinstall is a no-op and only restarting the process re-syncs.
	const residentSentinel = Object.keys(bindings).find(
		key => key !== ctx.versionSentinelExport && /^__piNativesV[A-Za-z0-9_]+$/.test(key),
	);
	// A prior sentinel alone cannot distinguish a resident old module from an
	// actually stale file: `require` returns the same exports in both cases.
	// The restart diagnosis is valid only when the selected file itself carries
	// the current sentinel; otherwise a restart would simply reload stale disk.
	let diskHasExpectedSentinel = false;
	try {
		diskHasExpectedSentinel = fs.readFileSync(candidate).includes(ctx.versionSentinelExport);
	} catch {
		// The successful require above normally guarantees readability. If the
		// file disappears concurrently, retain the safe reinstall diagnosis.
	}
	if (residentSentinel && diskHasExpectedSentinel) {
		const residentVersion = residentSentinel.slice("__piNativesV".length).replace(/_/g, ".");
		throw new Error(
			`Loaded ${candidate}, which exposes the @oh-my-pi/pi-natives@${residentVersion} version ` +
				`sentinel \`${residentSentinel}\` but not the @${ctx.packageVersion} sentinel ` +
				`\`${ctx.versionSentinelExport}\` this loader expects. omp was upgraded to ` +
				`${ctx.packageVersion} while this session was running; the ${residentVersion} addon is ` +
				"still resident in this process. Disk is already consistent — restart omp to pick up " +
				`${ctx.packageVersion} (reinstalling changes nothing).`,
		);
	}
	throw new Error(
		`Loaded ${candidate} but it does not expose the @oh-my-pi/pi-natives@${ctx.packageVersion} ` +
			`version sentinel \`${ctx.versionSentinelExport}\`. The .node file on disk is from a different ` +
			"release than this loader — reinstall to re-sync.",
	);
}

/**
 * Install the addon's bounded Tokio runtime now that `dlopen` has returned and
 * the dynamic-loader lock is released. The Rust `#[module_init]` deliberately
 * does NOT build the runtime — spawning worker threads under the loader lock
 * deadlocks on some hosts — so it exposes `__ompInstallTokioRuntime` for the
 * loader to call once, before any async native runs. Best-effort: older addons
 * predating this export simply fall back to napi-rs's default runtime.
 */
function installNativeTokioRuntime(bindings) {
	const install = bindings.__ompInstallTokioRuntime;
	if (typeof install !== "function") return;
	try {
		install();
		startupMarker("native:tokioRuntime:installed");
	} catch (err) {
		startupMarker(`native:tokioRuntime:failed:${err instanceof Error ? err.message : String(err)}`);
	}
}


function buildHelpMessage(ctx) {
	if (ctx.isCompiledBinary) {
		const expectedPaths = ctx.addonFilenames.map(filename => `  ${path.join(ctx.versionedDir, filename)}`).join("\n");
		const downloadHints = ctx.addonFilenames
			.map(filename => {
				const downloadUrl = `https://github.com/can1357/oh-my-pi/releases/latest/download/${filename}`;
				const targetPath = path.join(ctx.versionedDir, filename);
				return `  curl -fsSL "${downloadUrl}" -o "${targetPath}"`;
			})
			.join("\n");
		return (
			`The compiled binary should extract one of:\n${expectedPaths}\n\n` +
			`If missing, delete ${ctx.versionedDir} and re-run, or download manually:\n${downloadHints}`
		);
	}
	return (
		"If installed via npm/bun, try reinstalling: bun install @oh-my-pi/pi-natives\n" +
		"If developing locally, build with: bun --cwd=packages/natives run build\n" +
		"Explicit targets: bun scripts/bazel-natives.ts <target> --dest packages/natives/native"
	);
}

/**
 * Initialize the loader context: resolves every path, variant, and policy
 * decision once so the inner load loop stays a pure require/validate pipeline.
 * Called from `loadNative()` rather than at module scope so importing pure
 * helpers from this file doesn't trigger AVX2 detection or filesystem probes.
 */
/**
 * @param {{
 *   nativeDir?: string;
 *   platform?: NodeJS.Platform | string;
 *   arch?: string;
 *   runtimeNapiAbi?: string | number;
 *   isCompiledBinary?: boolean;
 *   leafPackageDir?: string | null;
 *   leafPackageManifest?: Record<string, unknown> | null;
 * }} [overrides]
 */
export function initLoaderContext(overrides = {}) {
	const platform = overrides.platform ?? process.platform;
	const arch = overrides.arch ?? process.arch;
	const platformTag = selectNativePlatformTag(platform, arch);
	const runtimeNapiAbi = overrides.runtimeNapiAbi ?? process.versions.napi ?? "0";
	const packageVersion = packageJson.version;
	const nativeDir = overrides.nativeDir ?? path.join(moduleDir, "..", "native");
	const execDir = path.dirname(process.execPath);
	const nativesDir = getNativesDir();
	const versionedDir = path.join(nativesDir, packageVersion);
	const userDataDir =
		platform === "win32"
			? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "omp")
			: path.join(os.homedir(), ".local", "bin");

	const isCompiledBinary =
		overrides.isCompiledBinary ??
		detectCompiledBinary({
			embeddedAddon,
			env: process.env,
			importMetaUrl: import.meta.url,
		});
	const normalizedNativeDir = platform === "win32" ? nativeDir.toLowerCase() : nativeDir;
	const isWorkspaceLoad =
		!isCompiledBinary &&
		!normalizedNativeDir.includes("\\node_modules\\") &&
		!normalizedNativeDir.includes("/node_modules/");

	let leafPackageDir = null;
	let leafMetadata = null;
	if (!isCompiledBinary && !isWorkspaceLoad) {
		let leafPackage;
		if (overrides.leafPackageDir === undefined) {
			leafPackage = resolveLeafPackage(platformTag);
		} else if (overrides.leafPackageDir === null) {
			leafPackage = null;
		} else {
			leafPackage = { dir: overrides.leafPackageDir, manifest: overrides.leafPackageManifest };
		}
		if (!leafPackage) {
			throw new Error(`Missing native leaf package @oh-my-pi/pi-natives-${platformTag} for ${platformTag}`);
		}
		leafPackageDir = leafPackage.dir;
		if (leafPackage.manifest) {
			const manifest = leafPackage.manifest;
			if (
				manifest.name !== `@oh-my-pi/pi-natives-${platformTag}` ||
				manifest.version !== packageVersion ||
				!Array.isArray(manifest.os) ||
				manifest.os.length !== 1 ||
				manifest.os[0] !== platform ||
				!Array.isArray(manifest.cpu) ||
				manifest.cpu.length !== 1 ||
				manifest.cpu[0] !== arch
			) {
				throw new Error(`Native leaf package metadata mismatch for ${platformTag}`);
			}
			leafMetadata = validateNativeAddonMetadata({
				metadata: manifest.ompNative,
				platformTag,
				runtimeNapiAbi,
			});
		}
	}

	let embeddedMetadata = null;
	if (isCompiledBinary) {
		if (!embeddedAddon) throw new Error(`Missing embedded native addon metadata for ${platformTag}`);
		if (embeddedAddon.version !== packageVersion) {
			throw new Error(
				`Embedded native addon version mismatch for ${platformTag}: expected ${packageVersion}, got ${embeddedAddon.version}`,
			);
		}
		embeddedMetadata = validateNativeAddonMetadata({
			metadata: {
				platformTag: embeddedAddon.platformTag,
				napiAbi: embeddedAddon.napiAbi,
				files: Object.fromEntries(embeddedAddon.files.map(file => [file.filename, { sha256: file.sha256 }])),
			},
			platformTag,
			runtimeNapiAbi,
		});
	}

	const stageFromNodeModules = shouldStageNodeModulesAddon({
		platform,
		isCompiledBinary,
		nativeDir: normalizedNativeDir,
	});
	const selectedVariant = resolveCpuVariant(getVariantOverride(), arch);
	const addonFilenames = getAddonFilenames({ tag: platformTag, arch, variant: selectedVariant });
	const addonLabel = selectedVariant ? `${platformTag} (${selectedVariant})` : platformTag;
	const candidates = resolveLoaderCandidates({
		addonFilenames,
		isCompiledBinary,
		stageFromNodeModules,
		nativeDir,
		leafPackageDir,
		execDir,
		versionedDir,
		userDataDir,
	});
	const fileMetadata = leafMetadata?.files ?? embeddedMetadata?.files ?? null;
	if (fileMetadata && !addonFilenames.some(filename => filename in fileMetadata)) {
		throw new Error(`Native addon metadata has no loadable file for ${addonLabel}`);
	}

	const versionSentinelExport = `__piNativesV${packageVersion.replace(/[^A-Za-z0-9]/g, "_")}`;
	return {
		platformTag,
		platform,
		arch,
		runtimeNapiAbi,
		packageVersion,
		nativeDir,
		leafPackageDir,
		versionedDir,
		isCompiledBinary,
		stageFromNodeModules,
		selectedVariant,
		addonFilenames,
		addonLabel,
		candidates,
		fileMetadata,
		requireCandidateMetadata: !isWorkspaceLoad,
		versionSentinelExport,
		isWorkspaceLoad,
		nativesDir,
	};
}

export function loadNative() {
	startupMarker("native:loadNative:start");
	const ctx = initLoaderContext();
	const require_ = createRequire(import.meta.url);

	const errors = [];
	const embeddedCandidate = maybeExtractEmbeddedAddon(ctx, errors);
	const stagedCandidate = embeddedCandidate ? null : maybeStageNodeModulesAddon(ctx, errors);
	const prepended = [embeddedCandidate, stagedCandidate].filter(c => typeof c === "string");
	const runtimeCandidates = prepended.length > 0 ? [...prepended, ...ctx.candidates] : ctx.candidates;

	for (const candidate of runtimeCandidates) {
		if (!fs.existsSync(candidate)) {
			errors.push(`${candidate}: file not found`);
			continue;
		}
		try {
			const file = ctx.fileMetadata?.[path.basename(candidate)];
			if (ctx.requireCandidateMetadata && !file) {
				throw new Error(`Native addon metadata missing for ${path.basename(candidate)}`);
			}
			if (file) verifyNativeAddonFile({ filePath: candidate, sha256: file.sha256 });
			startupMarker(`native:require:${path.basename(candidate)}`);
			const bindings = require_(candidate);
			validateLoadedBindings(ctx, bindings, candidate);
			installNativeTokioRuntime(bindings);
			cleanupStaleNativeVersions({ nativesDir: ctx.nativesDir, currentVersion: ctx.packageVersion });
			startupMarker("native:loadNative:done");
			return bindings;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push(`${candidate}: ${message}`);
		}
	}


	const details = errors.map(error => `- ${error}`).join("\n");
	throw new Error(
		`Failed to load pi_natives native addon for ${ctx.addonLabel}.\n\nTried:\n${details}\n\n${buildHelpMessage(ctx)}`,
	);
}
