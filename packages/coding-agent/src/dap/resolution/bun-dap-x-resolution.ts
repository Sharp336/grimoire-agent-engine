import * as fs from "node:fs";
import * as path from "node:path";
import { $which, getAgentDir, logger } from "@oh-my-pi/pi-utils";

export interface ResolvedBunDapXCommand {
	resolvedCommand: string;
	args: string[];
}

const PACKAGE_NAME = "bun-dap-x";
const PACKAGE_VERSION = "0.2.1";
const COMMAND_ENV = "OMP_BUN_DAP_COMMAND";
const AUTO_INSTALL_ENV = "OMP_BUN_DAP_AUTO_INSTALL";
const MAX_PROJECT_ANCESTORS = 8;
const WINDOWS_COMMAND_EXTENSIONS = ["", ".cmd", ".bat", ".exe"] as const;

function commandCandidates(basePath: string): string[] {
	if (process.platform !== "win32") return [basePath];
	return WINDOWS_COMMAND_EXTENSIONS.map(extension => `${basePath}${extension}`);
}

function existingFile(filePath: string): string | null {
	try {
		const stat = fs.statSync(filePath);
		return stat.isFile() || stat.isSymbolicLink() ? filePath : null;
	} catch {
		return null;
	}
}

function firstExistingFile(paths: readonly string[]): string | null {
	for (const filePath of paths) {
		const existing = existingFile(filePath);
		if (existing) return existing;
	}
	return null;
}

function packageBinFromInstallRoot(root: string): string | null {
	return firstExistingFile([
		...commandCandidates(path.join(root, "node_modules", ".bin", PACKAGE_NAME)),
		path.join(root, "node_modules", PACKAGE_NAME, "bin", PACKAGE_NAME),
	]);
}

function packageBinFromPackageRoot(root: string): string | null {
	return firstExistingFile([path.join(root, "bin", PACKAGE_NAME)]);
}

function resolveEnvCommand(): string | null {
	const configured = process.env[COMMAND_ENV]?.trim();
	if (!configured) return null;
	const packageRootBin = packageBinFromPackageRoot(configured) ?? packageBinFromInstallRoot(configured);
	if (packageRootBin) return packageRootBin;
	if (path.isAbsolute(configured)) return firstExistingFile(commandCandidates(configured));
	return $which(configured) ?? firstExistingFile(commandCandidates(path.resolve(configured)));
}

function resolveProjectLocalCommand(cwd: string): string | null {
	let current = path.resolve(cwd);
	for (let depth = 0; depth < MAX_PROJECT_ANCESTORS; depth++) {
		const candidate = packageBinFromInstallRoot(current);
		if (candidate) return candidate;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return null;
}

function autoInstallDisabled(): boolean {
	const value = process.env[AUTO_INSTALL_ENV]?.trim().toLowerCase();
	return value === "0" || value === "false" || value === "off" || value === "no";
}

function managedInstallRoot(): string {
	return path.join(getAgentDir(), "dap-adapters", PACKAGE_NAME, PACKAGE_VERSION);
}

function ensureManagedCommand(): string | null {
	if (autoInstallDisabled()) return null;
	const root = managedInstallRoot();
	const existing = packageBinFromInstallRoot(root);
	if (existing) return existing;
	const bun = $which("bun");
	if (!bun) return null;
	try {
		fs.mkdirSync(root, { recursive: true });
		const manifestPath = path.join(root, "package.json");
		if (!fs.existsSync(manifestPath)) {
			fs.writeFileSync(manifestPath, `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`);
		}
		const result = Bun.spawnSync({
			cmd: [bun, "add", "--exact", `${PACKAGE_NAME}@${PACKAGE_VERSION}`],
			cwd: root,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...Bun.env, FORCE_COLOR: "0" },
		});
		if (result.exitCode !== 0) {
			logger.warn("Failed to install Bun DAP adapter", {
				packageName: PACKAGE_NAME,
				version: PACKAGE_VERSION,
				exitCode: result.exitCode,
				stderr: result.stderr.toString("utf8").trim(),
			});
			return null;
		}
	} catch (err) {
		logger.warn("Failed to prepare Bun DAP adapter cache", { err });
		return null;
	}
	return packageBinFromInstallRoot(root);
}

export function resolveBunDapXAdapterCommand(cwd: string): ResolvedBunDapXCommand | null {
	const command =
		resolveEnvCommand() ?? resolveProjectLocalCommand(cwd) ?? $which(PACKAGE_NAME) ?? ensureManagedCommand();
	return command ? { resolvedCommand: command, args: [] } : null;
}
