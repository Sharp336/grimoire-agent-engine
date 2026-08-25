import * as fs from "node:fs";
import * as path from "node:path";
import { getTinyModelsCacheDir } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import bundledArm64Identity from "./apple-fm/prebuilt/arm64-apple-macosx26.0/digest.txt" with { type: "text" };
import bundledArm64Sidecar from "./apple-fm/prebuilt/arm64-apple-macosx26.0/omp-apple-fm" with { type: "file" };
import sidecarSource from "./apple-fm/sidecar.swift" with { type: "text" };

/** Override path to a compiled sidecar. Used by tests; also handy for a prebuilt helper. */
export const AFM_CORE_SIDECAR_ENV = "OMP_APPLE_FM_SIDECAR";

export interface AfmStatus {
	available: boolean;
	reason?: string;
	contextSize?: number;
}

interface SidecarPayload {
	available?: boolean;
	reason?: string;
	contextSize?: number;
	text?: string;
	error?: string;
}

function sidecarOverride(): string | undefined {
	const value = process.env[AFM_CORE_SIDECAR_ENV]?.trim();
	return value || undefined;
}

/** Env override disables the platform gate so tests can drive a fake sidecar anywhere. */
export function foundationModelsUnavailableReason(spec: { unsupportedReason?: string }): string | undefined {
	if (sidecarOverride()) return undefined;
	return spec.unsupportedReason;
}

export function isAfmModelNotReady(error: unknown): boolean {
	const text = error instanceof Error ? error.message : String(error);
	return /\bmodelNotReady\b/.test(text);
}

function sidecarCacheDir(): string {
	return path.join(getTinyModelsCacheDir(), "apple-fm");
}

function swiftTargetTriple(): string {
	const arch = process.arch === "x64" ? "x86_64" : process.arch;
	return `${arch}-apple-macosx26.0`;
}

function cacheIdentity(): string {
	return Bun.hash(`${sidecarSource}\0${swiftTargetTriple()}`).toString(16);
}

const BUNDLED_SIDECARS: Record<string, { file: string; identity: string }> = {
	"arm64-apple-macosx26.0": { file: bundledArm64Sidecar, identity: bundledArm64Identity.trim() },
};

/** Resolve a Bun file-loader value without treating a cwd-relative emit as cwd. */
export function resolveBundledSidecarPath(assetPath: string, moduleDir: string = import.meta.dir): string {
	if (path.isAbsolute(assetPath) || path.win32.isAbsolute(assetPath)) return assetPath;
	return path.resolve(moduleDir, assetPath);
}

async function bundledSidecarPath(): Promise<string | undefined> {
	const bundled = BUNDLED_SIDECARS[swiftTargetTriple()];
	if (!bundled || bundled.identity !== cacheIdentity()) return undefined;
	const file = resolveBundledSidecarPath(bundled.file);
	return (await Bun.file(file).exists()) ? file : undefined;
}

async function publishSidecar(srcPath: string, destPath: string): Promise<void> {
	const tmpPath = `${destPath}.${process.pid}.copy`;
	const bytes = Buffer.from(await Bun.file(srcPath).arrayBuffer());
	if (bytes.byteLength === 0) {
		throw new Error(`bundled AFM sidecar is empty: ${srcPath}`);
	}
	fs.writeFileSync(tmpPath, bytes);
	fs.chmodSync(tmpPath, 0o755);
	fs.renameSync(tmpPath, destPath);
}

function compileSidecar(srcPath: string, binPath: string): void {
	const target = swiftTargetTriple();
	const result = Bun.spawnSync({
		cmd: ["xcrun", "--sdk", "macosx", "swiftc", "-O", "-parse-as-library", "-target", target, "-o", binPath, srcPath],
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		const stderr = new TextDecoder().decode(result.stderr).trim();
		throw new Error(
			stderr
				? `failed to compile Apple Foundation Models sidecar: ${stderr}`
				: "failed to compile Apple Foundation Models sidecar (xcrun swiftc)",
		);
	}
	fs.chmodSync(binPath, 0o755);
}

/**
 * Resolve a runnable sidecar. Env override wins (tests / prebuilt). Otherwise
 * compile the bundled Swift into the tiny-models cache on first use.
 * Compile is locked and published by rename so two omp processes cannot
 * stamp a half-linked binary.
 */
export async function ensureAfmSidecar(): Promise<string> {
	const override = sidecarOverride();
	if (override) {
		if (!fs.existsSync(override)) {
			throw new Error(`OMP_APPLE_FM_SIDECAR does not exist: ${override}`);
		}
		return override;
	}
	if (process.platform !== "darwin") {
		throw new Error("Apple Foundation Models is macOS-only");
	}

	const dir = sidecarCacheDir();
	fs.mkdirSync(dir, { recursive: true });
	const hash = cacheIdentity();
	const srcPath = path.join(dir, "sidecar.swift");
	const binPath = path.join(dir, "omp-apple-fm");
	const stampPath = path.join(dir, `omp-apple-fm.${hash}`);
	if (fs.existsSync(binPath) && fs.existsSync(stampPath)) return binPath;

	return await withFileLock(
		binPath,
		async () => {
			if (fs.existsSync(binPath) && fs.existsSync(stampPath)) return binPath;
			const bundled = await bundledSidecarPath();
			const tmpPath = path.join(dir, `omp-apple-fm.${process.pid}.${hash}.tmp`);
			try {
				if (bundled) {
					await publishSidecar(bundled, binPath);
				} else {
					fs.writeFileSync(srcPath, sidecarSource);
					compileSidecar(srcPath, tmpPath);
					fs.renameSync(tmpPath, binPath);
				}
			} catch (error) {
				fs.rmSync(tmpPath, { force: true });
				if (!bundled) {
					throw new Error(
						`${error instanceof Error ? error.message : String(error)}. afm-core needs the bundled Apple Silicon sidecar or Xcode/CLT to compile one.`,
					);
				}
				throw error;
			}
			try {
				for (const entry of new Bun.Glob("omp-apple-fm.*").scanSync({ cwd: dir, onlyFiles: true })) {
					if (entry !== `omp-apple-fm.${hash}` && !entry.endsWith(".tmp") && !entry.endsWith(".lock")) {
						fs.rmSync(path.join(dir, entry), { force: true });
					}
				}
			} catch {
				// Cache cleanup is best-effort.
			}
			fs.writeFileSync(stampPath, `${hash}\n`);
			return binPath;
		},
		{ retries: 120, retryDelayMs: 250 },
	);
}

async function runSidecar(args: string[], stdin?: string): Promise<SidecarPayload> {
	const bin = await ensureAfmSidecar();
	const proc = Bun.spawn({
		cmd: [bin, ...args],
		stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const line = stdout
		.split(/\r?\n/)
		.map(entry => entry.trim())
		.find(entry => entry.startsWith("{"));
	if (!line) {
		const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`;
		throw new Error(`Apple Foundation Models sidecar returned no JSON: ${detail}`);
	}
	let payload: SidecarPayload;
	try {
		payload = JSON.parse(line) as SidecarPayload;
	} catch {
		throw new Error(`Apple Foundation Models sidecar returned invalid JSON: ${line}`);
	}
	if (payload.error) {
		throw new Error(payload.reason ? `${payload.error}: ${payload.reason}` : payload.error);
	}
	if (exitCode !== 0) {
		throw new Error(stderr.trim() || `Apple Foundation Models sidecar exited ${exitCode}`);
	}
	return payload;
}

export async function probeAfmCore(): Promise<AfmStatus> {
	const payload = await runSidecar(["status"]);
	return {
		available: payload.available === true,
		reason: payload.reason,
		contextSize: typeof payload.contextSize === "number" ? payload.contextSize : undefined,
	};
}

export async function completeAfmCore(input: { instructions?: string; prompt: string }): Promise<string> {
	const payload = await runSidecar(
		["complete"],
		JSON.stringify({
			instructions: input.instructions ?? "",
			prompt: input.prompt,
		}),
	);
	const text = payload.text?.trim() ?? "";
	if (!text) throw new Error("Apple Foundation Models sidecar returned empty text");
	return text;
}
