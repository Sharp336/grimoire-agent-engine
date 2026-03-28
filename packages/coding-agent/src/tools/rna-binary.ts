/**
 * RNA binary provisioner.
 *
 * Resolves the repo-native-alignment binary, downloading it from GitHub
 * releases on first use. Caches in ~/.oh-omp/bin/.
 *
 * Resolution order:
 *   1. Cached binary at ~/.oh-omp/bin/repo-native-alignment
 *   2. Binary in PATH (for developers who cargo-installed it)
 *   3. Download from GitHub releases → cache
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

const BINARY_NAME = "repo-native-alignment";
const GITHUB_REPO = "open-horizon-labs/repo-native-alignment";
const PINNED_VERSION = "v0.2.0";
const CACHE_DIR = path.join(os.homedir(), ".oh-omp", "bin");

/** Resolved binary path, cached after first successful resolution. */
let resolvedPath: string | null | undefined;

function getPlatformAsset(): string | null {
	const platform = process.platform;
	const arch = process.arch;

	if (platform === "darwin" && arch === "arm64") {
		return `${BINARY_NAME}-darwin-arm64.tar.gz`;
	}
	if (platform === "linux" && arch === "x64") {
		return `${BINARY_NAME}-linux-x86_64.tar.gz`;
	}
	return null;
}

function cachedBinaryPath(): string {
	return path.join(CACHE_DIR, BINARY_NAME);
}

async function binaryExists(binPath: string): Promise<boolean> {
	try {
		await fs.promises.access(binPath, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function findInPath(): Promise<string | null> {
	try {
		const proc = Bun.spawn(["which", BINARY_NAME], { stdout: "pipe", stderr: "ignore" });
		const stdout = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		if (exitCode === 0 && stdout.trim()) return stdout.trim();
	} catch {}
	return null;
}

async function download(): Promise<string | null> {
	const asset = getPlatformAsset();
	if (!asset) {
		logger.warn(`RNA: no pre-built binary for ${process.platform}-${process.arch}`);
		return null;
	}

	const url = `https://github.com/${GITHUB_REPO}/releases/download/${PINNED_VERSION}/${asset}`;
	logger.debug(`RNA: downloading ${PINNED_VERSION} from ${url}`);

	try {
		await fs.promises.mkdir(CACHE_DIR, { recursive: true });

		const response = await fetch(url, { redirect: "follow" });
		if (!response.ok) {
			logger.warn(`RNA: download failed — ${response.status} ${response.statusText}`);
			return null;
		}

		const tarPath = path.join(CACHE_DIR, asset);
		const bytes = new Uint8Array(await response.arrayBuffer());
		await Bun.write(tarPath, bytes);

		// Extract the binary from the tarball
		const proc = Bun.spawn(["tar", "xzf", tarPath, "-C", CACHE_DIR], {
			stdout: "ignore",
			stderr: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			logger.warn(`RNA: tar extraction failed — ${stderr.trim()}`);
			return null;
		}

		// Clean up tarball
		await fs.promises.unlink(tarPath).catch(() => {});

		const binPath = cachedBinaryPath();
		await fs.promises.chmod(binPath, 0o755);

		if (await binaryExists(binPath)) {
			logger.debug(`RNA: installed ${PINNED_VERSION} to ${binPath}`);
			return binPath;
		}

		logger.warn("RNA: binary not found after extraction");
		return null;
	} catch (err) {
		logger.warn("RNA: download failed", { error: err instanceof Error ? err.message : String(err) });
		return null;
	}
}

/**
 * Resolve the RNA binary path. Downloads if not found.
 * Returns null if unavailable (no binary, unsupported platform, download failed).
 * Result is cached for the process lifetime.
 */
export async function resolveRnaBinary(): Promise<string | null> {
	if (resolvedPath !== undefined) return resolvedPath;

	// 1. Check cache
	const cached = cachedBinaryPath();
	if (await binaryExists(cached)) {
		resolvedPath = cached;
		return cached;
	}

	// 2. Check PATH
	const inPath = await findInPath();
	if (inPath) {
		resolvedPath = inPath;
		return inPath;
	}

	// 3. Download
	const downloaded = await download();
	resolvedPath = downloaded;
	return downloaded;
}
