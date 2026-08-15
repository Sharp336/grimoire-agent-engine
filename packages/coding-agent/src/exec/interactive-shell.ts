import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { filterChildShellEnv } from "@oh-my-pi/pi-utils/env";
import { getShellArgs, isExecutable, isSafeShellEnvValue, type ShellConfig } from "@oh-my-pi/pi-utils/procmgr";

const MAX_CWD_RECORD_BYTES = 4096;
const TERMINAL_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const ZSH_CWD_RECORD_NAME = "cwd";
const ZSH_BOOTSTRAP_NAME = ".zshenv";
const ORIGINAL_ZDOTDIR_ENV = "OMP_INTERACTIVE_SHELL_ORIGINAL_ZDOTDIR";
const HAS_ORIGINAL_ZDOTDIR_ENV = "OMP_INTERACTIVE_SHELL_HAS_ORIGINAL_ZDOTDIR";
const INTERACTIVE_SHELL_LAUNCH_CWD = process.cwd();
const CWD_RECORD_ENV = "OMP_INTERACTIVE_SHELL_CWD_RECORD";

interface InteractiveShellSettings {
	get(path: "shellPath"): string | undefined;
	getShellConfig(env?: Record<string, string | undefined>): ShellConfig;
}

interface InteractiveShellSpawnOptions {
	cwd: string;
	env: Record<string, string | undefined>;
	stdin: "inherit";
	stdout: "inherit";
	stderr: "inherit";
}

interface InteractiveShellProcess {
	exited: Promise<number>;
}

type InteractiveShellSpawn = (command: string[], options: InteractiveShellSpawnOptions) => InteractiveShellProcess;

export interface InteractiveShellOptions {
	shellPath: string;
	cwd: string;
	env: Record<string, string | undefined>;
	/** Test seam for the inherited-stdio process launch. */
	spawn?: InteractiveShellSpawn;
}

export interface InteractiveShellResult {
	exitCode: number;
	/** A validated final cwd. Only zsh supports cwd synchronization. */
	workingDir?: string;
}

interface ZshBootstrap {
	temporaryZdotdir: string;
	recordPath: string;
	env: Record<string, string | undefined>;
}

const defaultSpawn: InteractiveShellSpawn = (command, options) => Bun.spawn(command, options);

function shellBasename(shellPath: string): string {
	return shellPath.replaceAll("\\", "/").split("/").pop()?.toLowerCase() ?? "";
}

function interactiveShellArgs(shellPath: string, env: Record<string, string | undefined>): string[] {
	const basename = shellBasename(shellPath);
	if (basename.includes("zsh")) return ["-il"];
	if (basename.includes("fish")) return ["-i"];

	return getShellArgs(shellPath, env).filter(
		arg => arg !== "-c" && arg !== "--command" && arg !== "-Command" && arg.toLowerCase() !== "/c",
	);
}

function buildZshBootstrap(token: string): string {
	const recordVariable = `_omp_cwd_record_${token}`;
	const originalZshenvVariable = `_omp_original_zshenv_${token}`;
	const chpwdHook = `_omp_chpwd_${token}`;
	const zshexitHook = `_omp_zshexit_${token}`;
	const setupFunction = `_omp_setup_${token}`;
	return `function ${setupFunction} {
emulate -L zsh
setopt no_aliases
typeset -g ${recordVariable}="$${CWD_RECORD_ENV}"
if [[ "$${HAS_ORIGINAL_ZDOTDIR_ENV}" == "1" ]]; then
	ZDOTDIR="$${ORIGINAL_ZDOTDIR_ENV}"
	export ZDOTDIR
else
	unset ZDOTDIR
fi
unset ${CWD_RECORD_ENV} ${HAS_ORIGINAL_ZDOTDIR_ENV} ${ORIGINAL_ZDOTDIR_ENV}
}
${setupFunction}
unfunction ${setupFunction}
typeset ${originalZshenvVariable}
if (( \${+ZDOTDIR} )); then
	${originalZshenvVariable}="\${ZDOTDIR}/.zshenv"
else
	${originalZshenvVariable}="\${HOME}/.zshenv"
fi
if [[ -r "$${originalZshenvVariable}" ]]; then
	builtin source -- "$${originalZshenvVariable}"
fi
unset ${originalZshenvVariable}
builtin autoload -Uz add-zsh-hook
function ${chpwdHook} {
	builtin print -rn -- "$PWD" >| "$${recordVariable}" 2>/dev/null
	return 0
}
function ${zshexitHook} {
	builtin print -rn -- "$PWD" >| "$${recordVariable}" 2>/dev/null
	return 0
}
add-zsh-hook chpwd ${chpwdHook}
add-zsh-hook zshexit ${zshexitHook}
\${chpwdHook}
`;
}

async function createZshBootstrap(env: Record<string, string | undefined>): Promise<ZshBootstrap> {
	let temporaryZdotdir: string | undefined;
	try {
		temporaryZdotdir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-zsh-"));
		await fs.chmod(temporaryZdotdir, 0o700);
		const recordPath = path.join(temporaryZdotdir, ZSH_CWD_RECORD_NAME);
		const recordHandle = await fs.open(recordPath, "wx", 0o600);
		await recordHandle.close();
		await fs.chmod(recordPath, 0o600);

		const token = crypto.randomUUID().replaceAll("-", "");
		const bootstrapPath = path.join(temporaryZdotdir, ZSH_BOOTSTRAP_NAME);
		const bootstrapHandle = await fs.open(bootstrapPath, "wx", 0o600);
		try {
			await bootstrapHandle.writeFile(buildZshBootstrap(token), "utf8");
		} finally {
			await bootstrapHandle.close();
		}
		await fs.chmod(bootstrapPath, 0o600);

		const originalZdotdir = env.ZDOTDIR;
		return {
			temporaryZdotdir,
			recordPath,
			env: {
				...env,
				ZDOTDIR: temporaryZdotdir,
				[ORIGINAL_ZDOTDIR_ENV]: originalZdotdir ?? "",
				[HAS_ORIGINAL_ZDOTDIR_ENV]: originalZdotdir === undefined ? "0" : "1",
				[CWD_RECORD_ENV]: recordPath,
			},
		};
	} catch (error) {
		if (temporaryZdotdir) await fs.rm(temporaryZdotdir, { recursive: true, force: true });
		throw error;
	}
}

async function readValidatedWorkingDir(recordPath: string): Promise<string | undefined> {
	let recordHandle: fs.FileHandle | undefined;
	try {
		recordHandle = await fs.open(recordPath, "r");
		const recordStat = await recordHandle.stat();
		if (!recordStat.isFile() || recordStat.size === 0 || recordStat.size > MAX_CWD_RECORD_BYTES) return undefined;

		const bytes = Buffer.allocUnsafe(MAX_CWD_RECORD_BYTES + 1);
		const { bytesRead } = await recordHandle.read(bytes, 0, bytes.byteLength, 0);
		if (bytesRead === 0 || bytesRead > MAX_CWD_RECORD_BYTES) return undefined;
		const encodedPath = bytes.subarray(0, bytesRead);
		const workingDir = encodedPath.toString("utf8");
		if (
			!Buffer.from(workingDir).equals(encodedPath) ||
			!path.isAbsolute(workingDir) ||
			TERMINAL_CONTROL_CHARACTER_PATTERN.test(workingDir)
		) {
			return undefined;
		}

		const workingDirStat = await fs.stat(workingDir);
		return workingDirStat.isDirectory() ? workingDir : undefined;
	} catch {
		return undefined;
	} finally {
		await recordHandle?.close();
	}
}

export function resolveInteractiveShellPath(
	settings: InteractiveShellSettings,
	env: Record<string, string | undefined> = Bun.env,
): string {
	const trustedEnv = filterChildShellEnv(env, INTERACTIVE_SHELL_LAUNCH_CWD);
	const envShell = trustedEnv.SHELL;
	if (!settings.get("shellPath") && isSafeShellEnvValue(envShell) && path.isAbsolute(envShell)) {
		const shellName = path.basename(envShell).toLowerCase();
		if (["bash", "zsh", "fish"].some(name => shellName.includes(name)) && isExecutable(envShell)) {
			return envShell;
		}
	}
	return settings.getShellConfig(trustedEnv).shell;
}

export async function runInteractiveShell(options: InteractiveShellOptions): Promise<InteractiveShellResult> {
	const spawn = options.spawn ?? defaultSpawn;
	const baseEnv = {
		...filterChildShellEnv(filterChildShellEnv(options.env, INTERACTIVE_SHELL_LAUNCH_CWD), options.cwd),
		SHELL: options.shellPath,
	};
	const command = [options.shellPath, ...interactiveShellArgs(options.shellPath, baseEnv)];
	const spawnOptions: InteractiveShellSpawnOptions = {
		cwd: options.cwd,
		env: baseEnv,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	};

	if (!shellBasename(options.shellPath).includes("zsh")) {
		const child = spawn(command, spawnOptions);
		return { exitCode: await child.exited };
	}

	const bootstrap = await createZshBootstrap(baseEnv);
	try {
		const child = spawn(command, { ...spawnOptions, env: bootstrap.env });
		const exitCode = await child.exited;
		const workingDir = await readValidatedWorkingDir(bootstrap.recordPath);
		return workingDir === undefined ? { exitCode } : { exitCode, workingDir };
	} finally {
		await fs.rm(bootstrap.temporaryZdotdir, { recursive: true, force: true });
	}
}
