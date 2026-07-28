import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Tier-2 Secret Broker — exec hardening.
 *
 * Sanitize the subprocess environment so the agent cannot tamper with how secrets
 * are used (F13, F14). The agent cannot control PATH (closed allowlist), cannot
 * inject `LD_PRELOAD` / `BASH_ENV` / `NODE_OPTIONS` / or any other env-override
 * blacklisted variable, and secrets are injected ONLY into the subprocess env —
 * never into the agent's own `process.env`.
 *
 * Always uses array-form `spawn(cmd, [args])` — never `bash -c "..."`, which would
 * re-introduce shell interpolation and PATH lookup.
 */

/** Env vars the agent MUST NOT control when the broker spawns a subprocess. */
export const ENV_OVERRIDE_BLACKLIST: readonly string[] = [
	"LD_PRELOAD",
	"LD_LIBRARY_PATH",
	"LD_AUDIT",
	"LD_DEBUG",
	"DYLD_INSERT_LIBRARIES",
	"DYLD_LIBRARY_PATH",
	"DYLD_FALLBACK_LIBRARY_PATH",
	"BASH_ENV",
	"ENV",
	"SSH_ASKPASS",
	"GIT_SSH_COMMAND",
	"GIT_TERMINAL_PROMPT",
	"PYTHONPATH",
	"NODE_OPTIONS",
	"NODE_PATH",
	"PERL5OPT",
	"RUBYOPT",
	"PERLLIB",
	"CLASSPATH",
	"JAVA_TOOL_OPTIONS",
];

/** A minimal PATH with only known-safe system binaries. */
export const CLOSED_PATH = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");

const SHELL_COMMANDS = new Set(["ash", "bash", "dash", "fish", "ksh", "sh", "zsh"]);
const PROC_ENVIRONMENT_PATH = /\/proc\/(?:self|thread-self|[0-9]+)\/(?:[^/\s"'`]+\/)*environ(?:$|[\s"'`])/;
const FILE_REDIRECTION = /(?:^|[^>])(?:[0-9]*)>>?\s*(?!&[0-9]\b)/;
const SHELL_WRITER = /(?:^|[\s;&|])(?:[^\s/]+\/)*(?:base64|cp|dd|tee)(?:$|[\s;&|])/;

export interface HardenedSpawnOptions {
	command: string;
	args: string[];
	/** Secrets to inject into the subprocess env (key → value). */
	envSecrets?: Record<string, string>;
	/**
	 * Additional non-secret env vars to pass through from `process.env`. When
	 * omitted, all non-blacklisted `process.env` keys pass through. When
	 * provided, ONLY the listed keys pass through (whitelist mode — stricter).
	 */
	envPassthrough?: string[];
	/**
	 * Restricted SSH agent socket for broker children (S4). When set, the
	 * subprocess gets THIS agent's socket as `SSH_AUTH_SOCK` instead of the
	 * user's full SSH agent. The broker-owned agent holds only scoped keys —
	 * the user's personal keys are unreachable from the subprocess.
	 */
	sshAuthSock?: string;
	/**
	 * Landlock fs-write sandbox (D6). When set, the child can WRITE only
	 * inside the listed dirs (+ an auto-created ephemeral scratch dir).
	 * Reads and execution stay open. Opt-in; when present and Landlock or
	 * the wrapper is unavailable, the spawn FAILS CLOSED rather than
	 * running unsandboxed (R2).
	 */
	landlockPolicy?: { writableDirs: string[] };
	/** Working directory. */
	cwd?: string;
	/** Timeout in ms. */
	timeoutMs?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Landlock wrapper management (D6)
// ═══════════════════════════════════════════════════════════════════════════

const LANDLOCK_WRAPPER_SOURCE = fileURLToPath(new URL("./landlock-wrapper.c", import.meta.url));

function landlockWrapperBinDir(): string {
	return join(process.env.OMP_SECRET_HOME ?? join(process.env.HOME ?? "/tmp", ".oh-my-pi-secret", "agent"), "bin");
}

function landlockWrapperBin(): string {
	return join(landlockWrapperBinDir(), "landlock-wrapper");
}

/** Compile the wrapper on first use or when the source is newer. Throws on failure (fail-closed). */
function ensureLandlockWrapper(): void {
	const bin = landlockWrapperBin();
	const sourceMtime = statSync(LANDLOCK_WRAPPER_SOURCE).mtimeMs;
	if (existsSync(bin) && statSync(bin).mtimeMs >= sourceMtime) return;
	mkdirSync(landlockWrapperBinDir(), { recursive: true, mode: 0o700 });
	const result = spawnSync("cc", ["-O2", "-o", bin, LANDLOCK_WRAPPER_SOURCE], { stdio: "pipe" });
	if (result.error || result.status !== 0) {
		throw new Error(
			`landlock wrapper build failed (cc exit ${result.status}): ${result.stderr?.toString().slice(0, 200) ?? result.error?.message}`,
		);
	}
}

function defaultLandlockProbe(): boolean {
	try {
		ensureLandlockWrapper();
	} catch {
		return false;
	}
	// Run the wrapper with an empty policy over `true` — proves create_ruleset,
	// no_new_privs, restrict_self, and exec all work on this kernel.
	const result = spawnSync(landlockWrapperBin(), ["--", "true"], { stdio: "ignore" });
	return !result.error && result.status === 0;
}

let landlockProbe: () => boolean = defaultLandlockProbe;

/** Test hook: override the Landlock availability probe; pass undefined to restore the default. */
export function setLandlockProbeForTests(fn: (() => boolean) | undefined): void {
	landlockProbe = fn ?? defaultLandlockProbe;
}

export interface HardenedSpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Spawn a subprocess with hardened env after rejecting known filesystem-write
 * exfiltration patterns. The agent cannot control PATH, `LD_PRELOAD`,
 * `BASH_ENV`, or any env-override blacklisted variable. Secrets are injected
 * ONLY into the subprocess env, not the agent's env. Uses array-form argv.
 */
function commandBasename(command: string): string {
	const separatorIndex = Math.max(command.lastIndexOf("/"), command.lastIndexOf("\\"));
	return command.slice(separatorIndex + 1);
}

function referencesProcEnvironment(args: readonly string[]): boolean {
	return args.some(arg => PROC_ENVIRONMENT_PATH.test(arg));
}

/**
 * Pre-spawn guard for S3. This intentionally fails closed for `tee` and shell
 * file redirection. It is a cooperative command audit, not an OS sandbox;
 * arbitrary trusted binaries still require Landlock for hostile-code isolation.
 */
function hasBlockedFilesystemWrite(command: string, args: readonly string[]): boolean {
	const executable = commandBasename(command);
	const readsProcEnvironment = referencesProcEnvironment(args);

	if (executable === "tee") return true;
	if (executable === "cp") return readsProcEnvironment;
	if (executable === "dd") return readsProcEnvironment && args.some(arg => arg.startsWith("of="));
	if (executable === "base64") {
		const writesOutputFile = args.some(
			arg => arg === "-o" || arg.startsWith("-o") || arg === "--output" || arg.startsWith("--output="),
		);
		return readsProcEnvironment && writesOutputFile;
	}
	if (SHELL_COMMANDS.has(executable)) {
		const script = args.join(" ");
		return FILE_REDIRECTION.test(script) || (PROC_ENVIRONMENT_PATH.test(script) && SHELL_WRITER.test(script));
	}

	return false;
}
export function hardenedSpawn(options: HardenedSpawnOptions): Promise<HardenedSpawnResult> {
	if (hasBlockedFilesystemWrite(options.command, options.args)) {
		return Promise.resolve({
			exitCode: -1,
			stdout: "",
			stderr: "[BROKER] Refusing subprocess: filesystem write pattern blocked",
		});
	}
	// Build sanitized env: start from process.env, strip blacklisted, set closed PATH.
	const env: Record<string, string> = {};
	const passthrough = options.envPassthrough;
	for (const [key, value] of Object.entries(process.env)) {
		if (ENV_OVERRIDE_BLACKLIST.includes(key)) continue;
		if (passthrough !== undefined && !passthrough.includes(key)) continue;
		if (value !== undefined) env[key] = value;
	}
	env.PATH = CLOSED_PATH;

	// S4: broker children NEVER inherit the user's SSH agent. The env-copy
	// loop above carries SSH_AUTH_SOCK/SSH_AGENT_PID through from process.env
	// (they are not on the override blacklist — that list targets env-override
	// attacks, not capability leaks). Strip them unconditionally: the ONLY way
	// a broker child gets an agent is an explicit restricted socket below.
	delete env.SSH_AUTH_SOCK;
	delete env.SSH_AGENT_PID;

	// S4: broker children get a restricted SSH agent socket (if configured),
	// never the user's full SSH agent. This prevents the subprocess from
	// reaching hosts the user's personal keys authorize (e.g., reading
	// /srv/infrastructure/secrets/* on the VPS).
	if (options.sshAuthSock) {
		env.SSH_AUTH_SOCK = options.sshAuthSock;
	}

	// Inject secrets into the subprocess env only — never into process.env.
	if (options.envSecrets) {
		for (const [key, value] of Object.entries(options.envSecrets)) {
			env[key] = value;
		}
	}

	// D6: Landlock fs-write sandbox — spawn the wrapper instead of the
	// command directly. The ephemeral scratch dir is always writable and
	// cleaned up when the child exits.
	let ephemeralDir: string | undefined;
	let spawnCommand = options.command;
	let spawnArgs = options.args;
	if (options.landlockPolicy) {
		if (!landlockProbe()) {
			return Promise.resolve({
				exitCode: -1,
				stdout: "",
				stderr: "[BROKER] Landlock unavailable on this kernel — refusing to spawn unsandboxed",
			});
		}
		try {
			ensureLandlockWrapper();
		} catch (err) {
			return Promise.resolve({
				exitCode: -1,
				stdout: "",
				stderr: `[BROKER] ${err instanceof Error ? err.message : String(err)}`,
			});
		}
		ephemeralDir = mkdtempSync(join(tmpdir(), "omp-secret-ephemeral-"));
		spawnCommand = landlockWrapperBin();
		spawnArgs = [...options.landlockPolicy.writableDirs, ephemeralDir, "--", options.command, ...options.args];
	}

	// Array-form argv — never `bash -c "..."`.
	const { promise, resolve } = Promise.withResolvers<HardenedSpawnResult>();
	const child = spawn(spawnCommand, spawnArgs, {
		stdio: ["ignore", "pipe", "pipe"],
		env,
		cwd: options.cwd,
		timeout: options.timeoutMs,
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", d => {
		stdout += d;
	});
	child.stderr?.on("data", d => {
		stderr += d;
	});
	child.on("close", exitCode => {
		if (ephemeralDir) rmSync(ephemeralDir, { recursive: true, force: true });
		resolve({ exitCode: exitCode ?? -1, stdout, stderr });
	});
	child.on("error", err => {
		if (ephemeralDir) rmSync(ephemeralDir, { recursive: true, force: true });
		resolve({ exitCode: -1, stdout, stderr: err.message });
	});
	return promise;
}
