/**
 * Update CLI command handler.
 *
 * Handles `omp update` to check for and install updates.
 * Uses the installer that owns the active omp executable when it can be detected.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { $which, APP_NAME, getLastInstalledVersionPath, isEnoent, logger, VERSION } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import chalk from "chalk";
import { theme } from "../modes/theme/theme";
import {
	formatChangelogMarkdown,
	getEntriesInVersionRange,
	parseChangelogContent,
	writeLastChangelogVersion,
} from "../utils/changelog";

const REPO = "can1357/oh-my-pi";
const PACKAGE = "@oh-my-pi/pi-coding-agent";
const HOMEBREW_FORMULA = "can1357/tap/omp";
const MISE_TOOL = "github:can1357/oh-my-pi";
/**
 * Official npm registry origin.
 *
 * Pinned across both the version check and the bun install step so the two
 * agree on which catalog they are talking to. A user's bun may be pointed at
 * an unofficial mirror (corporate proxy, Taobao, etc.) that lags the upstream
 * registry by minutes-to-hours, in which case `getLatestRelease` would resolve
 * a version the mirror has not yet replicated and the install would fail with
 * `No version matching "X" found for specifier "<pkg>" (but package exists)`.
 * See #1686.
 */
const NPM_REGISTRY = "https://registry.npmjs.org/";

/**
 * Core native addon package. Bumped in lock-step with {@link PACKAGE} so the
 * version sentinel the loader looks up at runtime matches the `.node` on
 * disk; see {@link buildBunInstallArgs} for why this must be installed
 * explicitly rather than inherited as a transitive dependency.
 */
const NATIVES_PACKAGE = "@oh-my-pi/pi-natives";

/**
 * Platform tags the release pipeline publishes as
 * `@oh-my-pi/pi-natives-<tag>` leaves. Mirrors `SUPPORTED_PLATFORMS` in
 * `packages/natives/native/loader-state.js` and `LEAF_TARGETS` in
 * `packages/natives/scripts/gen-npm-packages.ts`; kept here as the local
 * source of truth so the update path stays free of cross-package imports.
 */
const SUPPORTED_NATIVE_TAGS: ReadonlySet<string> = new Set([
	"linux-x64",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
	"win32-x64",
]);

function currentNativeTag(): string {
	return `${process.platform}-${process.arch}`;
}

export interface ReleaseInfo {
	tag: string;
	version: string;
	tarball?: string;
}

/** Result from running the installed binary and parsing its reported version. */
export interface InstalledVersionVerification {
	ok: boolean;
	actual?: string;
	path?: string;
}

/** Paths and verifier used while replacing a downloaded binary update. */
export interface BinaryReplacementOptions {
	targetPath: string;
	tempPath: string;
	backupPath: string;
	expectedVersion: string;
	verifyInstalledVersion: (expectedVersion: string) => Promise<InstalledVersionVerification>;
}

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

async function getBunGlobalBinDir(): Promise<string | undefined> {
	if (!$which("bun")) return undefined;
	try {
		const result = await $`bun pm bin -g`.quiet().nothrow();
		if (result.exitCode !== 0) return undefined;
		const output = result.text().trim();
		return output.length > 0 ? output : undefined;
	} catch {
		return undefined;
	}
}

async function getHomebrewFormulaPrefix(): Promise<string | undefined> {
	if (!$which("brew")) return undefined;
	for (const formula of [HOMEBREW_FORMULA, APP_NAME]) {
		try {
			const result = await $`brew --prefix ${formula}`.quiet().nothrow();
			if (result.exitCode !== 0) continue;
			const output = result.text().trim();
			if (output.length > 0) return output;
		} catch {}
	}
	return undefined;
}

async function getMiseBinDirs(): Promise<string[]> {
	if (!$which("mise")) return [];
	try {
		const result = await $`mise bin-paths ${MISE_TOOL}`.quiet().nothrow();
		if (result.exitCode !== 0) return [];
		return result
			.text()
			.split(/\r?\n/)
			.map(line => line.trim())
			.filter(line => line.length > 0);
	} catch {
		return [];
	}
}

function getMiseDataDir(): string {
	const override = process.env.MISE_DATA_DIR;
	if (override && override.length > 0) return override;
	if (process.platform === "win32") {
		const localAppData = process.env.LOCALAPPDATA;
		if (localAppData && localAppData.length > 0) return path.join(localAppData, "mise");
	}
	const xdgDataHome = process.env.XDG_DATA_HOME;
	if (xdgDataHome && xdgDataHome.length > 0) return path.join(xdgDataHome, "mise");
	return path.join(os.homedir(), ".local", "share", "mise");
}

function normalizePathForComparison(filePath: string): string {
	const normalized = path.normalize(filePath);
	if (process.platform === "win32") return normalized.toLowerCase();
	return normalized;
}

function tryRealpath(p: string): string | undefined {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return undefined;
	}
}

function isPathInDirectoryLexical(filePath: string, directoryPath: string): boolean {
	const normalizedPath = normalizePathForComparison(path.resolve(filePath));
	const normalizedDirectory = normalizePathForComparison(path.resolve(directoryPath));
	const relativePath = path.relative(normalizedDirectory, normalizedPath);
	return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function isPathInDirectory(filePath: string, directoryPath: string): boolean {
	if (isPathInDirectoryLexical(filePath, directoryPath)) return true;
	// Layer realpath resolution on top of the lexical guard. On Windows, ~/.bun
	// is a junction when Bun is installed via Scoop, so `bun pm bin -g` and the
	// PATH-resolved omp path can refer to the same directory through different
	// strings. path.resolve does not traverse junctions/symlinks; realpath does.
	// Resolve both the file and its parent directory: the file catches manager
	// links like Homebrew's `bin/omp -> Cellar/.../bin/omp`; the parent fallback
	// still tolerates fresh install paths where the file does not exist yet.
	const dirReal = tryRealpath(path.resolve(directoryPath));
	if (!dirReal) return false;
	const fileReal = tryRealpath(path.resolve(filePath));
	if (fileReal && isPathInDirectoryLexical(fileReal, dirReal)) return true;
	const fileDir = tryRealpath(path.dirname(path.resolve(filePath)));
	if (!fileDir) return false;
	const resolvedFile = path.join(fileDir, path.basename(filePath));
	return isPathInDirectoryLexical(resolvedFile, dirReal);
}

type UpdateMethod = "brew" | "mise" | "bun" | "binary";

interface UpdateMethodResolutionOptions {
	homebrewPrefix?: string;
	miseBinDirs?: readonly string[];
	miseDataDir?: string;
}

export type UpdateTarget =
	| { method: "brew" }
	| { method: "mise" }
	| { method: "bun" }
	| { method: "binary"; path: string };

export interface UpdateFlowOptions {
	force: boolean;
	check: boolean;
	showChangelog: boolean;
	currentVersion?: string;
}

export interface UpdateFlowOutput {
	log(message: string): void | Promise<void>;
	error(message: string): void | Promise<void>;
}

export type UpdateFlowResult =
	| { kind: "no-update"; currentVersion: string; latestVersion: string }
	| { kind: "update-available"; currentVersion: string; latestVersion: string; checkOnly: true }
	| { kind: "updated"; previousVersion: string; version: string; forced: boolean; changelogPrinted: boolean };

export interface UpdateFlowDependencies {
	getLatestRelease?: () => Promise<ReleaseInfo>;
	resolveUpdateTarget?: () => Promise<UpdateTarget>;
	installUpdate?: (
		target: UpdateTarget,
		expectedVersion: string,
		force: boolean,
		output: UpdateFlowOutput,
	) => Promise<void>;
	loadReleaseChangelog?: (release: ReleaseInfo) => Promise<string | undefined>;
	writeInstalledVersion?: (version: string) => Promise<void>;
	writeSeenChangelogVersion?: (version: string) => Promise<void>;
}

function resolveUpdateMethod(
	ompPath: string,
	bunBinDir: string | undefined,
	options: UpdateMethodResolutionOptions = {},
): UpdateMethod {
	const { homebrewPrefix, miseBinDirs = [], miseDataDir } = options;
	if (homebrewPrefix && isPathInDirectory(ompPath, path.join(homebrewPrefix, "bin"))) return "brew";
	if (miseBinDirs.some(dir => isPathInDirectory(ompPath, dir))) return "mise";
	if (miseDataDir && isPathInDirectory(ompPath, path.join(miseDataDir, "shims"))) return "mise";
	if (bunBinDir && isPathInDirectory(ompPath, bunBinDir)) return "bun";
	return "binary";
}

export function resolveUpdateMethodForTest(
	ompPath: string,
	bunBinDir: string | undefined,
	options: UpdateMethodResolutionOptions = {},
): UpdateMethod {
	return resolveUpdateMethod(ompPath, bunBinDir, options);
}
async function resolveUpdateTarget(): Promise<UpdateTarget> {
	const bunBinDir = await getBunGlobalBinDir();
	const homebrewPrefix = await getHomebrewFormulaPrefix();
	const miseAvailable = $which("mise") !== undefined;
	const miseBinDirs = miseAvailable ? await getMiseBinDirs() : [];
	const miseDataDir = miseAvailable ? getMiseDataDir() : undefined;
	const ompPath = resolveOmpPath();

	if (ompPath) {
		const method = resolveUpdateMethod(ompPath, bunBinDir, { homebrewPrefix, miseBinDirs, miseDataDir });
		if (method === "binary") return { method, path: ompPath };
		return { method };
	}

	if (bunBinDir) return { method: "bun" };

	throw new Error(`Could not resolve ${APP_NAME} binary path in PATH`);
}

/**
 * Get the latest release info from the npm registry.
 * Uses npm instead of GitHub API to avoid unauthenticated rate limiting.
 */
async function getLatestRelease(): Promise<ReleaseInfo> {
	const response = await fetch(`${NPM_REGISTRY}${PACKAGE}/latest`);
	if (!response.ok) {
		throw new Error(`Failed to fetch release info: ${response.statusText}`);
	}

	const data = (await response.json()) as { version: string; dist?: { tarball?: string } };
	const version = data.version;
	const tag = `v${version}`;

	return {
		tag,
		version,
		tarball: data.dist?.tarball,
	};
}

/**
 * Compare semver versions. Returns:
 * - negative if a < b
 * - 0 if a == b
 * - positive if a > b
 */
export function compareSemver(a: string, b: string): number {
	try {
		return Bun.semver.order(a, b);
	} catch {
		const pa = a.split(".").map(Number);
		const pb = b.split(".").map(Number);

		for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
			const na = pa[i] || 0;
			const nb = pb[i] || 0;
			if (na !== nb) return na - nb;
		}
		return 0;
	}
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
 * Resolve the path that `omp` maps to in the user's PATH.
 */
function resolveOmpPath(): string | undefined {
	return $which(APP_NAME) ?? undefined;
}

/**
 * Run the resolved omp binary and check if it reports the expected version.
 */
async function verifyInstalledVersion(expectedVersion: string): Promise<InstalledVersionVerification> {
	const ompPath = resolveOmpPath();
	if (!ompPath) return { ok: false };
	try {
		const result = await $`${ompPath} --version`.quiet().nothrow();
		if (result.exitCode !== 0) return { ok: false, path: ompPath };
		const output = result.text().trim();
		// Output format: "omp/X.Y.Z"
		const match = output.match(/\/(\d+\.\d+\.\d+)/);
		const actual = match?.[1];
		return { ok: actual === expectedVersion, actual, path: ompPath };
	} catch {
		return { ok: false, path: ompPath };
	}
}

async function printVerifiedVersion(expectedVersion: string, output: UpdateFlowOutput): Promise<void> {
	await output.log(chalk.green(`\n${theme.status.success} Updated to ${expectedVersion}`));
}

function formatVerificationFailure(result: InstalledVersionVerification, expectedVersion: string): string {
	if (result.actual) {
		return `${APP_NAME} at ${result.path} still reports ${result.actual} (expected ${expectedVersion})`;
	}
	return `could not verify updated version${result.path ? ` at ${result.path}` : ""}`;
}

/**
 * Print post-update verification result.
 */
async function printVerification(expectedVersion: string, output: UpdateFlowOutput): Promise<void> {
	const result = await verifyInstalledVersion(expectedVersion);
	if (result.ok) {
		await printVerifiedVersion(expectedVersion, output);
		return;
	}
	const failure = formatVerificationFailure(result, expectedVersion);
	await output.error(chalk.yellow(`\nWarning: ${failure}`));
	await output.error(chalk.yellow(`You may need to reinstall: curl -fsSL https://omp.sh/install | sh`));
	throw new Error(failure);
}

async function unlinkIfExists(filePath: string): Promise<void> {
	try {
		await fs.promises.unlink(filePath);
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
}

/**
 * Atomically replace the installed binary and roll back if version verification fails.
 */
export async function replaceBinaryForUpdate(options: BinaryReplacementOptions): Promise<InstalledVersionVerification> {
	let backupReady = false;
	try {
		await unlinkIfExists(options.backupPath);
		await fs.promises.rename(options.targetPath, options.backupPath);
		backupReady = true;
		await fs.promises.rename(options.tempPath, options.targetPath);

		const verification = await options.verifyInstalledVersion(options.expectedVersion);
		if (!verification.ok) {
			throw new Error(
				`${formatVerificationFailure(verification, options.expectedVersion)}; restored previous ${APP_NAME} binary`,
			);
		}

		backupReady = false;
		await unlinkIfExists(options.backupPath);
		return verification;
	} catch (err) {
		if (backupReady) {
			await unlinkIfExists(options.targetPath);
			await fs.promises.rename(options.backupPath, options.targetPath);
		}
		await unlinkIfExists(options.tempPath);
		throw err;
	}
}

/**
 * Build the bun argv used to globally install a specific omp version.
 *
 * The version is selected by hitting {@link NPM_REGISTRY} directly in
 * {@link getLatestRelease}, so the install MUST observe the same catalog:
 *
 * - `--registry=${NPM_REGISTRY}` pins the install to the official registry
 *   regardless of the user's bunfig/`.npmrc`. A mirror (corporate proxy,
 *   Taobao, …) that hasn't yet replicated the release would otherwise reject
 *   a version the upstream registry already advertises.
 * - `--no-cache` tells bun to ignore its on-disk manifest snapshot so it
 *   re-fetches metadata from that registry on every invocation.
 *
 * Together these two flags make `omp update` produce exactly the registry
 * lookup the version check just performed. See #1686.
 *
 * Also pins {@link NATIVES_PACKAGE} and the platform-specific
 * `@oh-my-pi/pi-natives-<tag>` leaf to `expectedVersion`. `bun install -g`
 * does not reliably refresh transitive `optionalDependencies` when the
 * top-level package is the only one bumped, so the native addon and its
 * version sentinel can drift out of sync with the freshly installed
 * `@oh-my-pi/pi-coding-agent` and the loader aborts at
 * `validateLoadedBindings` on the next launch
 * (`The .node file on disk is from a different release than this loader`).
 * Listing the natives explicitly forces bun to replace them in lock-step.
 * The leaf is added only on tags the release pipeline actually publishes
 * ({@link SUPPORTED_NATIVE_TAGS}) so unsupported platforms still fail with
 * the original "no matching version" message instead of `EBADPLATFORM`.
 * See #1824.
 */
export function buildBunInstallArgs(expectedVersion: string, nativeTag: string = currentNativeTag()): string[] {
	const args = [
		"install",
		"-g",
		"--no-cache",
		`--registry=${NPM_REGISTRY}`,
		`${PACKAGE}@${expectedVersion}`,
		`${NATIVES_PACKAGE}@${expectedVersion}`,
	];
	if (SUPPORTED_NATIVE_TAGS.has(nativeTag)) {
		args.push(`${NATIVES_PACKAGE}-${nativeTag}@${expectedVersion}`);
	}
	return args;
}

export function buildHomebrewUpdateArgs(force: boolean): string[] {
	return [force ? "reinstall" : "upgrade", HOMEBREW_FORMULA];
}

export function buildMiseUpgradeArgs(): string[] {
	return ["upgrade", MISE_TOOL, "--bump"];
}

export function buildMiseForceInstallArgs(expectedVersion: string): string[] {
	return ["install", "--force", `${MISE_TOOL}@${expectedVersion}`];
}

/**
 * Update via bun package manager.
 */
async function updateViaBun(expectedVersion: string, output: UpdateFlowOutput): Promise<void> {
	await output.log(chalk.dim("Updating via bun..."));
	const args = buildBunInstallArgs(expectedVersion);
	const result = await $`bun ${args}`.quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`bun install failed with exit code ${result.exitCode}`);
	}

	await printVerification(expectedVersion, output);
}

async function updateViaHomebrew(expectedVersion: string, force: boolean, output: UpdateFlowOutput): Promise<void> {
	await output.log(chalk.dim("Updating Homebrew formulae..."));
	const update = await $`brew update`.quiet().nothrow();
	if (update.exitCode !== 0) {
		throw new Error(`brew update failed with exit code ${update.exitCode}`);
	}

	await output.log(chalk.dim("Updating via Homebrew..."));
	const args = buildHomebrewUpdateArgs(force);
	const result = await $`brew ${args}`.quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`brew ${args[0]} failed with exit code ${result.exitCode}`);
	}

	await printVerification(expectedVersion, output);
}

async function updateViaMise(expectedVersion: string, force: boolean, output: UpdateFlowOutput): Promise<void> {
	await output.log(chalk.dim("Updating via mise..."));
	const args = buildMiseUpgradeArgs();
	const result = await $`mise ${args}`.quiet().nothrow();
	if (result.exitCode !== 0) {
		throw new Error(`mise upgrade failed with exit code ${result.exitCode}`);
	}

	if (force) {
		const forceArgs = buildMiseForceInstallArgs(expectedVersion);
		const forceResult = await $`mise ${forceArgs}`.quiet().nothrow();
		if (forceResult.exitCode !== 0) {
			throw new Error(`mise install --force failed with exit code ${forceResult.exitCode}`);
		}
	}

	await printVerification(expectedVersion, output);
}

/**
 * Download a release binary to a target path, replacing an existing file.
 */
async function updateViaBinaryAt(targetPath: string, expectedVersion: string, output: UpdateFlowOutput): Promise<void> {
	const binaryName = getBinaryName();
	const tag = `v${expectedVersion}`;
	const url = `https://github.com/${REPO}/releases/download/${tag}/${binaryName}`;

	const tempPath = `${targetPath}.new`;
	const backupPath = `${targetPath}.bak`;
	await output.log(chalk.dim(`Downloading ${binaryName}…`));

	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(`Download failed: ${response.statusText}`);
	}
	const fileStream = fs.createWriteStream(tempPath, { mode: 0o755 });
	await pipeline(response.body, fileStream);

	await output.log(chalk.dim("Installing update..."));
	await replaceBinaryForUpdate({
		targetPath,
		tempPath,
		backupPath,
		expectedVersion,
		verifyInstalledVersion,
	});
	await printVerifiedVersion(expectedVersion, output);
	await output.log(chalk.dim(`Restart ${APP_NAME} to use the new version`));
}

async function loadReleaseChangelog(release: ReleaseInfo): Promise<string | undefined> {
	if (!release.tarball) return undefined;

	try {
		const response = await fetch(release.tarball, { signal: AbortSignal.timeout(15_000) });
		if (!response.ok || !response.body) return undefined;

		const archive = new Bun.Archive(new Uint8Array(await response.arrayBuffer()));
		const files = await archive.files();
		return (await files.get("package/CHANGELOG.md")?.text()) ?? (await files.get("CHANGELOG.md")?.text());
	} catch {
		return undefined;
	}
}

export async function readLastInstalledVersion(agentDir?: string): Promise<string | undefined> {
	try {
		const value = (await Bun.file(getLastInstalledVersionPath(agentDir)).text()).trim();
		return value || undefined;
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Failed to read last-installed-version marker", { error: String(error) });
		}
		return undefined;
	}
}

export async function writeLastInstalledVersion(version: string, agentDir?: string): Promise<void> {
	try {
		await Bun.write(getLastInstalledVersionPath(agentDir), version);
	} catch (error) {
		logger.warn("Failed to persist last-installed-version marker", { error: String(error) });
	}
}

export async function getOutdatedProcessInfo(
	currentVersion: string = VERSION,
	agentDir?: string,
): Promise<{ currentVersion: string; installedVersion: string } | undefined> {
	const installedVersion = await readLastInstalledVersion(agentDir);
	if (installedVersion && compareSemver(installedVersion, currentVersion) > 0) {
		return { currentVersion, installedVersion };
	}
	return undefined;
}

/**
 * Run the update command.
 */
async function installUpdateForTarget(
	target: UpdateTarget,
	expectedVersion: string,
	force: boolean,
	output: UpdateFlowOutput,
): Promise<void> {
	if (target.method === "brew") {
		await updateViaHomebrew(expectedVersion, force, output);
	} else if (target.method === "mise") {
		await updateViaMise(expectedVersion, force, output);
	} else if (target.method === "bun") {
		await updateViaBun(expectedVersion, output);
	} else {
		await updateViaBinaryAt(target.path, expectedVersion, output);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function runUpdateFlow(
	options: UpdateFlowOptions,
	output: UpdateFlowOutput,
	deps: UpdateFlowDependencies = {},
): Promise<UpdateFlowResult> {
	const currentVersion = options.currentVersion ?? VERSION;
	await output.log(chalk.dim(`Current version: ${currentVersion}`));

	let release: ReleaseInfo;
	try {
		release = await (deps.getLatestRelease ?? getLatestRelease)();
	} catch (err) {
		throw new Error(`Failed to check for updates: ${errorMessage(err)}`);
	}

	const comparison = compareSemver(release.version, currentVersion);

	if (comparison <= 0 && !options.force) {
		await output.log(chalk.green(`${theme.status.success} Already up to date`));
		return { kind: "no-update", currentVersion, latestVersion: release.version };
	}

	if (comparison > 0) {
		await output.log(chalk.cyan(`New version available: ${release.version}`));
		if (options.check) {
			return { kind: "update-available", currentVersion, latestVersion: release.version, checkOnly: true };
		}
	} else if (options.check) {
		return { kind: "no-update", currentVersion, latestVersion: release.version };
	} else {
		await output.log(chalk.yellow(`Forcing reinstall of ${release.version}`));
	}

	try {
		const target = await (deps.resolveUpdateTarget ?? resolveUpdateTarget)();
		await (deps.installUpdate ?? installUpdateForTarget)(target, release.version, options.force, output);
		await (deps.writeInstalledVersion ?? writeLastInstalledVersion)(release.version);
	} catch (err) {
		throw new Error(`Update failed: ${errorMessage(err)}`);
	}

	let changelogPrinted = false;
	if (options.showChangelog && comparison > 0) {
		try {
			const changelogContent = await (deps.loadReleaseChangelog ?? loadReleaseChangelog)(release);
			if (changelogContent) {
				const entries = parseChangelogContent(changelogContent);
				const entriesToShow = getEntriesInVersionRange(entries, currentVersion, release.version);
				const changelogMarkdown = formatChangelogMarkdown(entriesToShow, { reverse: true });
				if (changelogMarkdown) {
					await output.log(`\nWhat's new:\n\n${changelogMarkdown}`);
					changelogPrinted = true;
					await (deps.writeSeenChangelogVersion ?? writeLastChangelogVersion)(release.version);
				}
			}
		} catch {
			// Changelog loading is best-effort and must never fail an update.
		}
	}

	return {
		kind: "updated",
		previousVersion: currentVersion,
		version: release.version,
		forced: options.force,
		changelogPrinted,
	};
}

/**
 * Run the update command.
 */
export async function runUpdateCommand(opts: { force: boolean; check: boolean }): Promise<void> {
	const consoleOutput: UpdateFlowOutput = {
		log: message => console.log(message),
		error: message => console.log(message),
	};
	try {
		await runUpdateFlow({ force: opts.force, check: opts.check, showChangelog: true }, consoleOutput);
	} catch (err) {
		console.error(chalk.red(errorMessage(err)));
		process.exit(1);
	}
}

/**
 * Print update command help.
 */
export function printUpdateHelp(): void {
	console.log(`${chalk.bold(`${APP_NAME} update`)} - Check for and install updates

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
