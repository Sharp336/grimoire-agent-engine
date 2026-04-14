import * as fs from "node:fs/promises";
import * as path from "node:path";
import { detectHostAvx2Support } from "../../../scripts/host-detect.deno.ts";

const __dirname = import.meta.dirname!;
const repoRoot = path.join(__dirname, "../../..");
const rustDir = path.join(repoRoot, "crates/pi-natives");
const nativeDir = path.join(__dirname, "../native");
const packageJsonPath = path.join(__dirname, "../package.json");

const crossTarget = Deno.env.get("CROSS_TARGET");
const targetPlatform = Deno.env.get("TARGET_PLATFORM") || Deno.build.os;
const targetArch =
	Deno.env.get("TARGET_ARCH") ||
	(Deno.build.arch === "x86_64" ? "x64" : Deno.build.arch === "aarch64" ? "arm64" : Deno.build.arch);
const configuredVariantRaw = Deno.env.get("TARGET_VARIANT");
const isCrossCompile =
	Boolean(crossTarget) ||
	targetPlatform !== (Deno.build.os === "darwin" ? "darwin" : Deno.build.os) ||
	targetArch !== (Deno.build.arch === "x86_64" ? "x64" : Deno.build.arch === "aarch64" ? "arm64" : Deno.build.arch);

type X64Variant = "modern" | "baseline";

interface SafeHostZigBuildConfig {
	wrapperPath: string;
	realZigPath: string;
	target: string;
	cpu: string;
}

let configuredVariant: X64Variant | undefined;
if (configuredVariantRaw) {
	if (targetArch !== "x64") {
		throw new Error(`TARGET_VARIANT is only supported for x64 builds, got ${targetPlatform}-${targetArch}.`);
	}
	if (configuredVariantRaw !== "modern" && configuredVariantRaw !== "baseline") {
		throw new Error(`Unsupported TARGET_VARIANT: ${configuredVariantRaw}. Expected "modern" or "baseline".`);
	}
	configuredVariant = configuredVariantRaw;
}

function resolveEffectiveVariant(): X64Variant | null {
	if (targetArch !== "x64") return null;
	if (configuredVariant) return configuredVariant;
	if (isCrossCompile) {
		throw new Error("x64 cross-builds require TARGET_VARIANT=modern or TARGET_VARIANT=baseline.");
	}
	return detectHostAvx2Support() ? "modern" : "baseline";
}
const effectiveVariant = resolveEffectiveVariant();
const variantSuffix = effectiveVariant ? `-${effectiveVariant}` : "";

function resolveLinuxHostZigTarget(): "x86_64-linux-gnu" | "x86_64-linux-musl" {
	const report = (
		process as unknown as {
			report?: {
				getReport?: () => { header?: { glibcVersionRuntime?: string } };
			};
		}
	).report?.getReport?.();
	return report?.header?.glibcVersionRuntime ? "x86_64-linux-gnu" : "x86_64-linux-musl";
}

async function which(name: string, extraPaths?: string[]): Promise<string | null> {
	const pathEnv = Deno.env.get("PATH") ?? "";
	const sep = Deno.build.os === "windows" ? ";" : ":";
	const dirs = [...(extraPaths ?? []), ...pathEnv.split(sep).filter(Boolean)];
	for (const dir of dirs) {
		const candidate = path.join(dir, name);
		try {
			await fs.access(candidate, fs.constants.X_OK);
			return candidate;
		} catch {
			continue;
		}
	}
	return null;
}

function resolveSafeHostZigBuildConfig(): SafeHostZigBuildConfig | null {
	if (isCrossCompile || targetArch !== "x64" || !effectiveVariant) {
		return null;
	}

	if (targetPlatform !== "linux" && targetPlatform !== "darwin") {
		return null;
	}

	const realZigPath = Deno.env.get("ZIG") ?? null;
	if (!realZigPath) {
		return null;
	}

	return {
		wrapperPath: path.join(__dirname, "zig-safe-wrapper.deno.ts"),
		realZigPath,
		target: targetPlatform === "linux" ? resolveLinuxHostZigTarget() : "x86_64-macos",
		cpu: effectiveVariant === "modern" ? "x86_64_v3" : "x86_64_v2",
	};
}

if (!isCrossCompile && !Deno.env.get("RUSTFLAGS")) {
	if (effectiveVariant === "modern") {
		Deno.env.set("RUSTFLAGS", "-C target-cpu=x86-64-v3");
	} else if (effectiveVariant === "baseline") {
		Deno.env.set("RUSTFLAGS", "-C target-cpu=x86-64-v2");
	} else {
		Deno.env.set("RUSTFLAGS", "-C target-cpu=native");
	}
}

async function cleanupStaleTemps(dir: string): Promise<void> {
	try {
		const entries = await fs.readdir(dir);
		for (const entry of entries) {
			if (entry.includes(".tmp.") || entry.includes(".old.") || entry.includes(".new.")) {
				await fs.unlink(path.join(dir, entry)).catch(() => {});
			}
		}
	} catch {}
}

async function installBinary(src: string, dest: string): Promise<void> {
	const tempPath = `${dest}.tmp.${Deno.pid}`;

	await fs.copyFile(src, tempPath);

	try {
		await fs.rename(tempPath, dest);
	} catch {
		try {
			await fs.unlink(dest);
		} catch (unlinkErr) {
			if ((unlinkErr as NodeJS.ErrnoException).code !== "ENOENT") {
				await fs.unlink(tempPath).catch(() => {});
				const isWindows = Deno.build.os === "windows";
				throw new Error(
					`Cannot replace ${path.basename(dest)}${isWindows ? " (file may be in use - close any running processes)" : ""}: ${(unlinkErr as Error).message}`,
				);
			}
		}
		try {
			await fs.rename(tempPath, dest);
		} catch (finalErr) {
			await fs.unlink(tempPath).catch(() => {});
			throw new Error(`Failed to install ${path.basename(dest)}: ${(finalErr as Error).message}`);
		}
	}
}

async function patchGeneratedIndexLoader(): Promise<void> {
	const indexPath = path.join(nativeDir, "index.js");
	let content = await Deno.readTextFile(indexPath);
	const embeddedLoadPatch = "let embeddedAddon = null;\n";
	if (!content.includes(embeddedLoadPatch)) {
		content = content.replace(/const \{ embeddedAddon \} = require\("\.\/embedded-addon"\);\n/, embeddedLoadPatch);
	}
	const lazyLoadPatch = [
		"if (isCompiledBinary) {",
		"\ttry {",
		'\t\t({ embeddedAddon } = require("./embedded-addon"));',
		"\t} catch {",
		"\t\tembeddedAddon = null;",
		"\t}",
		"}",
		"",
	].join("\n");
	if (!content.includes(lazyLoadPatch)) {
		content = content.replace(
			/(const isCompiledBinary =[\s\S]*?__filename\.includes\("%7EBUN"\);\n)/,
			`$1\n${lazyLoadPatch}`,
		);
	}
	await Deno.writeTextFile(indexPath, content);
}

async function resolveBuiltAddonPath(outputDir: string, canonicalFilename: string): Promise<string> {
	const entries = await fs.readdir(outputDir);

	if (entries.includes(canonicalFilename)) {
		return path.join(outputDir, canonicalFilename);
	}

	const generatedCandidates = entries.filter(entry => {
		if (!entry.startsWith(`pi_natives.${targetPlatform}-${targetArch}`) || !entry.endsWith(".node")) {
			return false;
		}
		return true;
	});

	if (generatedCandidates.length === 1) {
		return path.join(outputDir, generatedCandidates[0]);
	}

	if (generatedCandidates.length === 0) {
		throw new Error(
			`napi build succeeded but did not emit a native addon for ${targetPlatform}-${targetArch}. Expected ${canonicalFilename} or an environment-tagged variant in ${outputDir}. Directory contents: ${entries.join(", ") || "(empty)"}.`,
		);
	}

	const formattedCandidates = generatedCandidates.map(candidate => `  - ${candidate}`).join("\n");
	throw new Error(
		`napi build emitted multiple unrecognized native addons for ${targetPlatform}-${targetArch}:\n${formattedCandidates}`,
	);
}

function resolveBuildOutputDirPrefix(profileLabel: string): string {
	const buildTarget = crossTarget ?? `${targetPlatform}-${targetArch}`;
	const variantLabel = effectiveVariant ?? "default";
	return path.join(nativeDir, ".build", `${buildTarget}-${variantLabel}-${profileLabel}-`);
}

async function installGeneratedBindings(outputDir: string): Promise<void> {
	for (const filename of ["index.d.ts"]) {
		const sourcePath = path.join(outputDir, filename);
		const destPath = path.join(nativeDir, filename);
		try {
			await fs.copyFile(sourcePath, destPath);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to install generated ${filename}: ${message}`);
		}
	}
}

function resolveManagedCargoTargetDir(profileLabel: string): string | null {
	if (Deno.env.get("CARGO_TARGET_DIR")) {
		return null;
	}

	const buildTarget = crossTarget ?? `${targetPlatform}-${targetArch}`;
	const variantLabel = effectiveVariant ?? "default";
	return path.join(repoRoot, "target", "napi-build", `${buildTarget}-${variantLabel}-${profileLabel}`);
}

const isCI = Boolean(Deno.env.get("CI"));
const useLocalProfile = !isCI && !isCrossCompile;
const profileLabel = useLocalProfile ? "local" : "release";
const profileSuffix = useLocalProfile ? " (local)" : "";

const buildOutputDirPrefix = resolveBuildOutputDirPrefix(profileLabel);

const napiArgs = [
	"build",
	"--manifest-path",
	path.join(rustDir, "Cargo.toml"),
	"--package-json-path",
	packageJsonPath,
	"--platform",
	"--no-js",
	"--dts",
	"index.d.ts",
	"-o",
	"",
];

if (useLocalProfile) {
	napiArgs.push("--profile", "local");
} else {
	napiArgs.push("--release");
}

if (crossTarget) napiArgs.push("--target", crossTarget);

const canonicalAddonFilename = `pi_natives.${targetPlatform}-${targetArch}${variantSuffix}.node`;
const canonicalAddonPath = path.join(nativeDir, canonicalAddonFilename);

console.log(`Building pi-natives for ${targetPlatform}-${targetArch}${variantSuffix}${profileSuffix}…`);

await fs.mkdir(nativeDir, { recursive: true });
await cleanupStaleTemps(nativeDir);
await fs.mkdir(path.join(nativeDir, ".build"), { recursive: true });
const buildOutputDir = await fs.mkdtemp(buildOutputDirPrefix);
napiArgs[10] = buildOutputDir;

const napiBin = await which("napi", [
	path.join(__dirname, "..", "node_modules", ".bin"),
	path.join(repoRoot, "node_modules", ".bin"),
]);
if (!napiBin) {
	throw new Error("Could not locate @napi-rs/cli `napi` binary in node_modules/.bin");
}

const managedCargoTargetDir = resolveManagedCargoTargetDir(profileLabel);
if (managedCargoTargetDir) {
	Deno.env.set("CARGO_TARGET_DIR", managedCargoTargetDir);
	console.log(`Using isolated CARGO_TARGET_DIR: ${managedCargoTargetDir}`);
}

const safeHostZigBuildConfig = resolveSafeHostZigBuildConfig();
if (safeHostZigBuildConfig) {
	Deno.env.set("ZIG", safeHostZigBuildConfig.wrapperPath);
	Deno.env.set("PI_NATIVE_REAL_ZIG", safeHostZigBuildConfig.realZigPath);
	Deno.env.set("PI_NATIVE_ZIG_TARGET", safeHostZigBuildConfig.target);
	Deno.env.set("PI_NATIVE_ZIG_CPU", safeHostZigBuildConfig.cpu);
	console.log(
		`Pinning host Zig CPU contract: ${safeHostZigBuildConfig.target} ${safeHostZigBuildConfig.cpu} (${effectiveVariant})`,
	);
}

try {
	const cmd = new Deno.Command(napiBin, {
		args: napiArgs,
		stderr: "piped",
		stdout: "inherit",
	});
	const buildResult = await cmd.output();
	if (!buildResult.success) {
		const stderr = new TextDecoder().decode(buildResult.stderr);
		throw new Error(`napi build failed${stderr ? `:\n${stderr}` : ""}`);
	}

	const builtAddonPath = await resolveBuiltAddonPath(buildOutputDir, canonicalAddonFilename);
	if (builtAddonPath !== canonicalAddonPath) {
		console.log(`Normalizing native addon filename: ${path.basename(builtAddonPath)} → ${canonicalAddonFilename}`);
		await installBinary(builtAddonPath, canonicalAddonPath);
	}

	await installGeneratedBindings(buildOutputDir);

	const genEnumsPath = path.join(__dirname, "gen-enums.deno.ts");
	const genCmd = new Deno.Command("deno", {
		args: ["run", "--allow-read", "--allow-write", genEnumsPath],
		stderr: "inherit",
		stdout: "inherit",
	});
	const genResult = await genCmd.output();
	if (!genResult.success) {
		throw new Error("gen-enums failed");
	}

	await patchGeneratedIndexLoader();

	console.log("Build complete.");
} finally {
	await fs.rm(buildOutputDir, { recursive: true, force: true });
}
