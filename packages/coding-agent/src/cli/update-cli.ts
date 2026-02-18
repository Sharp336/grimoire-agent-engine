/**
 * Update CLI command handler.
 *
 * Handles `omp update` to check for and install updates.
 * Uses bun if available, otherwise downloads binary from GitHub releases.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { APP_NAME, getAgentDir, VERSION } from "@oh-my-pi/pi-utils/dirs";
import { $ } from "bun";
import chalk from "chalk";
import { withFileLock } from "../config/file-lock";
import { theme } from "../modes/theme/theme";

/**
 * Detect if we're running as a Bun compiled binary.
 */
const isBunBinary =
	Bun.env.PI_COMPILED ||
	import.meta.url.includes("$bunfs") ||
	import.meta.url.includes("~BUN") ||
	import.meta.url.includes("%7EBUN");

const REPO = "can1357/oh-my-pi";
const PACKAGE = "@oh-my-pi/pi-coding-agent";

const UPDATE_LOCK_NAME = "update";
const UPDATE_LOCK_STALE_MS = 15 * 60 * 1000;
const AUTO_UPDATE_LOCK_RETRIES = 2;
const MANUAL_UPDATE_LOCK_RETRIES = 50;
const LOCK_RETRY_DELAY_MS = 100;

const REGISTRY_FETCH_TIMEOUT_MS = 5000;
const REGISTRY_FETCH_RETRIES = 2;
const ASSET_FETCH_TIMEOUT_MS = 120000;
const ASSET_FETCH_RETRIES = 2;
const FETCH_RETRY_BASE_DELAY_MS = 250;

interface ReleaseAsset {
	name: string;
	url: string;
	sha256?: string;
}
interface ReleaseInfo {
	tag: string;
	version: string;
	assets: ReleaseAsset[];
}

export interface AutoUpdateResult {
	status:
		| "disabled"
		| "skipped"
		| "busy"
		| "up-to-date"
		| "update-available"
		| "updated"
		| "check-failed"
		| "update-failed";
	latestVersion?: string;
	error?: string;
}
export interface AutoUpdateOptions {
	enabled: boolean;
	installUpdate: boolean;
	currentVersion: string;
	checkIntervalHours: number;
	lastCheckAt: string | undefined;
	setLastCheckAt: (value: string) => void;
}

const writeStdout = (message: string): void => {
	process.stdout.write(`${message}\n`);
};

const writeStderr = (message: string): void => {
	process.stderr.write(`${message}\n`);
};

/**
 * Parse update subcommand arguments.
 * Returns undefined if not an update command.
 */
export function parseUpdateArgs(args: string[]): { force: boolean; check: boolean } | undefined {
	if (args.length === 0 || args[0] !== "update") {
		return undefined;
	}

	return {
		force: args.includes("--force") || args.includes("-f"),
		check: args.includes("--check") || args.includes("-c"),
	};
}

/**
 * Check if bun is available in PATH.
 */
function hasBun(): boolean {
	return Boolean(Bun.which("bun"));
}

/**
 * Whether an HTTP status should be retried.
 */
function isRetriableStatus(status: number): boolean {
	return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

async function fetchWithRetry(
	url: string,
	init: RequestInit,
	options: { timeoutMs: number; retries: number },
): Promise<Response> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= options.retries; attempt++) {
		let response: Response;
		try {
			response = await fetch(url, {
				...init,
				signal: AbortSignal.timeout(options.timeoutMs),
			});
		} catch (error) {
			lastError = error;
			if (attempt === options.retries) {
				throw error;
			}
			await Bun.sleep(FETCH_RETRY_BASE_DELAY_MS * (attempt + 1));
			continue;
		}
		if (response.ok) {
			return response;
		}
		const httpError = new Error(`Request failed (${response.status} ${response.statusText}) for ${url}`);
		lastError = httpError;
		if (!isRetriableStatus(response.status) || attempt === options.retries) {
			throw httpError;
		}
		await Bun.sleep(FETCH_RETRY_BASE_DELAY_MS * (attempt + 1));
	}
	throw new Error(`Request failed for ${url}`, { cause: lastError });
}

function normalizeSha256Digest(digest: string): string {
	return digest.toLowerCase().replace("sha256:", "");
}

async function getReleaseDigestsForTag(tag: string): Promise<Map<string, string>> {
	const response = await fetchWithRetry(
		`https://api.github.com/repos/${REPO}/releases/tags/${tag}`,
		{ headers: { Accept: "application/vnd.github+json" } },
		{ timeoutMs: REGISTRY_FETCH_TIMEOUT_MS, retries: REGISTRY_FETCH_RETRIES },
	);
	const data = (await response.json()) as {
		assets?: Array<{ name?: string; digest?: string }>;
	};

	const digestByName = new Map<string, string>();
	for (const asset of data.assets ?? []) {
		if (asset.name && asset.digest?.startsWith("sha256:")) {
			digestByName.set(asset.name, normalizeSha256Digest(asset.digest));
		}
	}
	return digestByName;
}

/**
 * Get the latest release info from npm and enrich with GitHub asset digests when available.
 */
async function getLatestRelease(): Promise<ReleaseInfo> {
	const response = await fetchWithRetry(
		`https://registry.npmjs.org/${PACKAGE}/latest`,
		{},
		{ timeoutMs: REGISTRY_FETCH_TIMEOUT_MS, retries: REGISTRY_FETCH_RETRIES },
	);
	const data = (await response.json()) as { version: string };
	const version = data.version;
	const tag = `v${version}`;
	let digestByName = new Map<string, string>();
	try {
		digestByName = await getReleaseDigestsForTag(tag);
	} catch {
		// Digest lookup is best-effort; downloads still proceed without checksum verification.
	}

	const makeAsset = (name: string): ReleaseAsset => ({
		name,
		url: `https://github.com/${REPO}/releases/download/${tag}/${name}`,
		sha256: digestByName.get(name),
	});
	return {
		tag,
		version,
		assets: [makeAsset(getBinaryName()), ...getNativeAddonNames().map(makeAsset)],
	};
}

/**
 * Compare semver versions. Returns:
 * - negative if a < b
 * - 0 if a == b
 * - positive if a > b
 */
function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);

	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const na = pa[i] || 0;
		const nb = pb[i] || 0;
		if (na !== nb) return na - nb;
	}
	return 0;
}

/**
 * Get the appropriate binary name for this platform.
 */
function getBinaryName(): string {
	const platform = process.platform;
	const arch = process.arch;

	let os: string;
	switch (platform) {
		case "linux":
			os = "linux";
			break;
		case "darwin":
			os = "darwin";
			break;
		case "win32":
			os = "windows";
			break;
		default:
			throw new Error(`Unsupported platform: ${platform}`);
	}

	let archName: string;
	switch (arch) {
		case "x64":
			archName = "x64";
			break;
		case "arm64":
			archName = "arm64";
			break;
		default:
			throw new Error(`Unsupported architecture: ${arch}`);
	}

	if (os === "windows") {
		return `${APP_NAME}-${os}-${archName}.exe`;
	}
	return `${APP_NAME}-${os}-${archName}`;
}

/**
 * Get native addon names for this platform, ordered by preference.
 */
function getNativeAddonNames(): string[] {
	const platform = process.platform;
	const arch = process.arch;
	if (!["linux", "darwin", "win32"].includes(platform)) {
		throw new Error(`Unsupported platform: ${platform}`);
	}
	if (!["x64", "arm64"].includes(arch)) {
		throw new Error(`Unsupported architecture: ${arch}`);
	}

	const baseName = `pi_natives.${platform}-${arch}.node`;
	if (arch !== "x64") {
		return [baseName];
	}

	return [`pi_natives.${platform}-${arch}-modern.node`, `pi_natives.${platform}-${arch}-baseline.node`];
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes)
		.map(byte => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function verifyAssetChecksum(destinationPath: string, expectedSha256: string | undefined): Promise<void> {
	if (!expectedSha256) {
		return;
	}

	const fileBuffer = await Bun.file(destinationPath).arrayBuffer();
	const digestBuffer = await crypto.subtle.digest("SHA-256", fileBuffer);
	const actualDigest = bytesToHex(new Uint8Array(digestBuffer));
	if (actualDigest !== normalizeSha256Digest(expectedSha256)) {
		throw new Error(`Checksum mismatch for ${path.basename(destinationPath)}`);
	}
}

async function downloadAsset(asset: ReleaseAsset, destinationPath: string): Promise<void> {
	const response = await fetchWithRetry(
		asset.url,
		{ redirect: "follow" },
		{ timeoutMs: ASSET_FETCH_TIMEOUT_MS, retries: ASSET_FETCH_RETRIES },
	);
	if (!response.body) {
		throw new Error(`Download failed: empty response body for ${asset.url}`);
	}
	const fileStream = fs.createWriteStream(destinationPath, { mode: 0o755 });
	await pipeline(response.body, fileStream);
	await verifyAssetChecksum(destinationPath, asset.sha256);
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.promises.stat(filePath);
		return true;
	} catch (error) {
		if (isEnoent(error)) {
			return false;
		}
		throw error;
	}
}

async function removeIfExists(filePath: string): Promise<void> {
	try {
		await fs.promises.unlink(filePath);
	} catch (error) {
		if (!isEnoent(error)) {
			throw error;
		}
	}
}

async function withUpdateLock<T>(retries: number, fn: () => Promise<T>): Promise<T> {
	const agentDir = getAgentDir();
	await fs.promises.mkdir(agentDir, { recursive: true });
	return await withFileLock(path.join(agentDir, UPDATE_LOCK_NAME), fn, {
		staleMs: UPDATE_LOCK_STALE_MS,
		retries,
		retryDelayMs: LOCK_RETRY_DELAY_MS,
	});
}

function shouldUpdateViaBun(): boolean {
	return !isBunBinary && hasBun();
}

function canInstallViaBinaryInCurrentProcess(): boolean {
	return !(process.platform === "win32" && isBunBinary);
}

/**
 * Update via bun package manager.
 */
async function updateViaBun(expectedVersion: string, quiet = false): Promise<void> {
	if (!quiet) {
		writeStdout(chalk.dim("Updating via bun..."));
	}

	const installCommand = $`bun install -g ${PACKAGE}@${expectedVersion}`;
	const installResult = quiet ? await installCommand.quiet().nothrow() : await installCommand.nothrow();
	if (installResult.exitCode !== 0) {
		throw new Error("bun install failed");
	}
	// Verify the update actually took effect
	try {
		const listResult = await $`bun pm ls -g`.quiet().nothrow();
		const output = listResult.text();
		const match = output.match(new RegExp(`${PACKAGE.replace("/", "\\/")}@(\\S+)`));
		if (match) {
			const installedVersion = match[1];
			if (compareVersions(installedVersion, expectedVersion) < 0) {
				if (!quiet) {
					writeStdout(
						chalk.yellow(`\nWarning: bun reports ${installedVersion} installed, expected ${expectedVersion}`),
					);
					writeStdout(chalk.yellow(`Try: bun install -g ${PACKAGE}@latest`));
				}
				return;
			}
		}
	} catch {
		// Verification is best-effort, don't fail the update
	}

	if (!quiet) {
		writeStdout(chalk.green(`\n${theme.status.success} Update complete`));
	}
}

/**
 * Update by downloading binary from GitHub releases.
 */
async function updateViaBinary(release: ReleaseInfo, quiet = false): Promise<void> {
	const binaryName = getBinaryName();
	const nativeAddonNames = getNativeAddonNames();
	const asset = release.assets.find(a => a.name === binaryName);
	if (!asset) {
		throw new Error(`No binary found for ${binaryName}`);
	}
	const execPath = process.execPath;
	const execDir = path.dirname(execPath);
	const tempPath = `${execPath}.new`;
	const backupPath = `${execPath}.bak`;
	const nativeDownloads: Array<{ name: string; tempPath: string; finalPath: string; backupPath: string }> = [];

	if (!quiet) {
		writeStdout(chalk.dim(`Downloading ${binaryName}…`));
	}
	await downloadAsset(asset, tempPath);
	for (const nativeAddonName of nativeAddonNames) {
		const nativeAsset = release.assets.find(a => a.name === nativeAddonName);
		if (!nativeAsset) {
			throw new Error(`No native addon found for ${nativeAddonName}`);
		}

		if (!quiet) {
			writeStdout(chalk.dim(`Downloading ${nativeAddonName}…`));
		}

		const finalPath = path.join(execDir, nativeAddonName);
		const tempNativePath = `${finalPath}.new`;
		const backupNativePath = `${finalPath}.bak`;
		await downloadAsset(nativeAsset, tempNativePath);
		nativeDownloads.push({
			name: nativeAddonName,
			tempPath: tempNativePath,
			finalPath,
			backupPath: backupNativePath,
		});
	}

	if (!quiet) {
		writeStdout(chalk.dim("Installing update..."));
	}

	await removeIfExists(backupPath);
	for (const nativeDownload of nativeDownloads) {
		await removeIfExists(nativeDownload.backupPath);
	}

	try {
		await fs.promises.rename(execPath, backupPath);
		await fs.promises.rename(tempPath, execPath);
		for (const nativeDownload of nativeDownloads) {
			if (await pathExists(nativeDownload.finalPath)) {
				await fs.promises.rename(nativeDownload.finalPath, nativeDownload.backupPath);
			}
			await fs.promises.rename(nativeDownload.tempPath, nativeDownload.finalPath);
		}
	} catch (error) {
		if (await pathExists(backupPath)) {
			await removeIfExists(execPath);
			await fs.promises.rename(backupPath, execPath);
		}

		for (const nativeDownload of nativeDownloads) {
			if (await pathExists(nativeDownload.backupPath)) {
				await removeIfExists(nativeDownload.finalPath);
				await fs.promises.rename(nativeDownload.backupPath, nativeDownload.finalPath);
			}
		}
		await removeIfExists(tempPath);
		for (const nativeDownload of nativeDownloads) {
			await removeIfExists(nativeDownload.tempPath);
		}
		throw error;
	}

	await removeIfExists(backupPath);
	for (const nativeDownload of nativeDownloads) {
		await removeIfExists(nativeDownload.backupPath);
	}

	if (!quiet) {
		writeStdout(chalk.green(`\n${theme.status.success} Updated to ${release.version}`));
		writeStdout(chalk.dim(`Installed ${nativeDownloads.length} native addon file(s)`));
		writeStdout(chalk.dim(`Restart ${APP_NAME} to use the new version`));
	}
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function isLockAcquisitionError(error: unknown): boolean {
	return error instanceof Error && error.message.includes("Failed to acquire lock");
}

/**
 * Run startup auto-update check/install with throttling.
 */
export async function runAutoUpdate(options: AutoUpdateOptions): Promise<AutoUpdateResult> {
	if (!options.enabled) {
		return { status: "disabled" };
	}
	const intervalMs = Math.max(1, options.checkIntervalHours) * 60 * 60 * 1000;
	const lastCheckMs = options.lastCheckAt ? Date.parse(options.lastCheckAt) : Number.NaN;
	if (Number.isFinite(lastCheckMs) && Date.now() - lastCheckMs < intervalMs) {
		return { status: "skipped" };
	}

	try {
		return await withUpdateLock(AUTO_UPDATE_LOCK_RETRIES, async () => {
			options.setLastCheckAt(new Date().toISOString());
			let release: ReleaseInfo;
			try {
				release = await getLatestRelease();
			} catch (error) {
				return { status: "check-failed", error: getErrorMessage(error) };
			}
			if (compareVersions(release.version, options.currentVersion) <= 0) {
				return { status: "up-to-date", latestVersion: release.version };
			}
			if (!options.installUpdate) {
				return { status: "update-available", latestVersion: release.version };
			}

			try {
				if (shouldUpdateViaBun()) {
					await updateViaBun(release.version, true);
				} else if (!canInstallViaBinaryInCurrentProcess()) {
					return { status: "update-available", latestVersion: release.version };
				} else {
					await updateViaBinary(release, true);
				}
				return { status: "updated", latestVersion: release.version };
			} catch (error) {
				return { status: "update-failed", latestVersion: release.version, error: getErrorMessage(error) };
			}
		});
	} catch (error) {
		if (isLockAcquisitionError(error)) {
			return { status: "busy" };
		}
		return { status: "check-failed", error: getErrorMessage(error) };
	}
}

/**
 * Run the update command.
 */
export async function runUpdateCommand(opts: { force: boolean; check: boolean }): Promise<void> {
	writeStdout(chalk.dim(`Current version: ${VERSION}`));
	try {
		await withUpdateLock(MANUAL_UPDATE_LOCK_RETRIES, async () => {
			// Check for updates
			let release: ReleaseInfo;
			try {
				release = await getLatestRelease();
			} catch (error) {
				throw new Error(`Failed to check for updates: ${getErrorMessage(error)}`);
			}
			const comparison = compareVersions(release.version, VERSION);
			if (comparison <= 0 && !opts.force) {
				writeStdout(chalk.green(`${theme.status.success} Already up to date`));
				return;
			}
			if (comparison > 0) {
				writeStdout(chalk.cyan(`New version available: ${release.version}`));
			} else {
				writeStdout(chalk.yellow(`Forcing reinstall of ${release.version}`));
			}
			if (opts.check) {
				// Just check, don't install
				return;
			}
			// Choose update method
			try {
				if (shouldUpdateViaBun()) {
					await updateViaBun(release.version);
				} else if (!canInstallViaBinaryInCurrentProcess()) {
					throw new Error(
						`In-place updates are not supported on Windows compiled binaries due to file locking. Run "${APP_NAME} update --check" and reinstall manually.`,
					);
				} else {
					await updateViaBinary(release);
				}
			} catch (error) {
				throw new Error(`Update failed: ${getErrorMessage(error)}`);
			}
		});
	} catch (error) {
		if (isLockAcquisitionError(error)) {
			writeStderr(chalk.yellow("Another update is already in progress. Try again shortly."));
		} else {
			writeStderr(chalk.red(getErrorMessage(error)));
		}
		process.exit(1);
	}
}

/**
 * Print update command help.
 */
export function printUpdateHelp(): void {
	writeStdout(`${chalk.bold(`${APP_NAME} update`)} - Check for and install updates

${chalk.bold("Usage:")}
  ${APP_NAME} update [options]

${chalk.bold("Options:")}
  -c, --check   Check for updates without installing
  -f, --force   Force reinstall even if up to date

${chalk.bold("Examples:")}
  ${APP_NAME} update           Update to latest version
  ${APP_NAME} update --check   Check if updates are available
  ${APP_NAME} update --force   Force reinstall
`);
}
