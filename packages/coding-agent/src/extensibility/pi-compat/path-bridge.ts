import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getConfigRootDir, getPluginsDir, isEnoent } from "@oh-my-pi/pi-utils";
import { getPiCompatProfileEnv } from "./profiles";
import type { PiCompatEnvOptions, PiCompatPathBridgeMode, PiCompatSymlinkPlan } from "./types";

export function getPiCompatRootDir(): string {
	return path.join(getConfigRootDir(), "pi-compat");
}

export function getPiCompatBinDir(): string {
	return path.join(getPiCompatRootDir(), "bin");
}

export function getPiCompatHomeDir(): string {
	return path.join(getPiCompatRootDir(), "home");
}

export function getPiCompatPiHomeDir(): string {
	return path.join(getPiCompatHomeDir(), ".pi");
}

function copyEnv(baseEnv: NodeJS.ProcessEnv): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(baseEnv)) {
		if (value !== undefined) env[key] = value;
	}
	return env;
}

function prependPath(existingPath: string | undefined, dir: string): string {
	if (!existingPath) return dir;
	const entries = existingPath.split(path.delimiter).filter(Boolean);
	if (entries.includes(dir)) return existingPath;
	return [dir, ...entries].join(path.delimiter);
}

function parseBridgeMode(value: string | undefined): PiCompatPathBridgeMode | undefined {
	if (value === "none" || value === "env" || value === "child-home" || value === "symlink" || value === "profile") {
		return value;
	}
	return undefined;
}

function assignChildHomeEnv(env: Record<string, string>, homeDir: string): void {
	env.HOME = homeDir;
	env.USERPROFILE = homeDir;

	const normalizedWinHome = path.win32.normalize(homeDir);
	const winRoot = path.win32.parse(normalizedWinHome).root;
	if (/^[a-zA-Z]:\\?$/.test(winRoot)) {
		env.HOMEDRIVE = winRoot.slice(0, 2);
		env.HOMEPATH = normalizedWinHome.slice(2) || "\\";
		return;
	}

	env.HOMEDRIVE = "";
	env.HOMEPATH = homeDir;
}

export function buildPiCompatEnv(options: PiCompatEnvOptions = {}): Record<string, string> {
	const env = copyEnv(options.baseEnv ?? process.env);
	const mode: PiCompatPathBridgeMode = options.bridgeMode ?? parseBridgeMode(env.OMP_PI_COMPAT_BRIDGE) ?? "env";
	const binDir = getPiCompatBinDir();

	env.PATH = prependPath(env.PATH, binDir);
	env.PI_CODING_AGENT = "true";
	env.PI_CODING_AGENT_DIR = getAgentDir();
	env.PI_PACKAGE_DIR = getPluginsDir();
	env.OMP_PI_COMPAT = "1";
	env.OMP_PI_COMPAT_HOME = getPiCompatHomeDir();
	env.OMP_PI_COMPAT_BRIDGE = mode;

	if (mode === "child-home") {
		assignChildHomeEnv(env, getPiCompatHomeDir());
	}

	if (mode === "profile" || options.packageName) {
		Object.assign(env, getPiCompatProfileEnv(options.packageName));
	}

	return env;
}

export async function ensurePiCompatHome(): Promise<void> {
	await fs.promises.mkdir(getPiCompatPiHomeDir(), { recursive: true });
	await fs.promises.mkdir(path.join(getPiCompatPiHomeDir(), "agent"), { recursive: true });
}

export async function planPiHomeSymlinkBridge(homeDir: string = os.homedir()): Promise<PiCompatSymlinkPlan> {
	const linkPath = path.join(homeDir, ".pi");
	const targetPath = getPiCompatPiHomeDir();
	try {
		const stat = await fs.promises.lstat(linkPath);
		if (stat.isSymbolicLink()) {
			const existingTarget = await fs.promises.readlink(linkPath);
			const resolvedExisting = path.resolve(homeDir, existingTarget);
			if (resolvedExisting === targetPath) {
				return {
					mode: "exists-compatible",
					linkPath,
					targetPath,
					message: `${linkPath} already points at the OMP Pi compatibility home`,
				};
			}
		}
		return {
			mode: "refuse-existing",
			linkPath,
			targetPath,
			message: `${linkPath} already exists; refusing to overwrite a possible upstream Pi installation`,
		};
	} catch (err) {
		if (!isEnoent(err)) throw err;
		return {
			mode: "create",
			linkPath,
			targetPath,
			message: `Create ${linkPath} -> ${targetPath}`,
		};
	}
}

export async function ensurePiHomeSymlinkBridge(
	options: { dryRun?: boolean; homeDir?: string } = {},
): Promise<PiCompatSymlinkPlan> {
	const plan = await planPiHomeSymlinkBridge(options.homeDir);
	if (plan.mode !== "create" || options.dryRun) {
		return plan;
	}
	await ensurePiCompatHome();
	await fs.promises.symlink(plan.targetPath, plan.linkPath, "dir");
	return plan;
}
