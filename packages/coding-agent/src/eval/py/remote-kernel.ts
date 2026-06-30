/**
 * SSH-backed Python runner.
 *
 * Speaks the same NDJSON protocol as the local Python kernel, but runs the
 * embedded runner.py on a configured POSIX SSH host. The SSH process is the
 * transport: stdin/stdout/stderr stay piped, ControlMaster is explicitly
 * disabled for this long-lived kernel, and optional tool-bridge access is
 * exposed through a reverse loopback forward.
 */
import { $flag, Snowflake } from "@oh-my-pi/pi-utils";
import { buildRemoteCommand, type SSHConnectionTarget } from "../../ssh/connection-manager";
import { writeRemoteFile } from "../../ssh/file-transfer";
import { ensureRemotePosixShell } from "../../ssh/remote-posix";
import { quotePosixPath, wrapInPosixShell } from "../../ssh/utils";
import { BaseKernel, getRemainingTimeMs, type KernelExecuteOptions, type KernelStartOptions } from "../kernel-base";
import { PYTHON_PRELUDE } from "./prelude";
import RUNNER_SCRIPT from "./runner.py" with { type: "text" };

const TRACE_IPC = $flag("PI_PYTHON_IPC_TRACE");
const REMOTE_RUNNER_DIR = "/tmp/omp-python-runner";
const SHUTDOWN_GRACE_MS = 1_000;
const STARTUP_TIMEOUT_MS = 10_000;
const INTERRUPT_ESCALATION_MS = 5_000;
const REMOTE_BRIDGE_PORT_MIN = 49_152;
const REMOTE_BRIDGE_PORT_RANGE = 16_384;

export interface RemotePythonBridgeForward {
	localPort: number;
	remotePort: number;
	remoteUrl: string;
}

export interface RemotePythonKernelStartOptions extends KernelStartOptions {
	sshHost: SSHConnectionTarget;
	bridge?: RemotePythonBridgeForward;
}

function assertPort(port: number, label: string): void {
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`${label} must be a TCP port between 1 and 65535`);
	}
}

export function selectRemoteBridgePort(identity: string): number {
	const offset = Number(BigInt(Bun.hash(identity)) % BigInt(REMOTE_BRIDGE_PORT_RANGE));
	return REMOTE_BRIDGE_PORT_MIN + offset;
}

export function buildRemotePythonBridgeForward(localBridgeUrl: string, remotePort: number): RemotePythonBridgeForward {
	assertPort(remotePort, "Remote Python bridge port");
	const url = new URL(localBridgeUrl);
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
		throw new Error(`Python tool bridge must be a 127.0.0.1 HTTP URL, got ${localBridgeUrl}`);
	}
	const localPort = Number(url.port);
	assertPort(localPort, "Local Python bridge port");
	return {
		localPort,
		remotePort,
		remoteUrl: `http://127.0.0.1:${remotePort}`,
	};
}

export function buildRemotePythonSshExtraArgs(bridge?: RemotePythonBridgeForward): string[] {
	const args = ["-T"];
	if (bridge) {
		args.push("-R", `127.0.0.1:${bridge.remotePort}:127.0.0.1:${bridge.localPort}`, "-o", "ExitOnForwardFailure=yes");
	}
	return args;
}

export function buildRemotePythonRunnerPath(script = RUNNER_SCRIPT): string {
	const hash = Bun.hash(script).toString(36);
	return `${REMOTE_RUNNER_DIR}/runner-${hash}.py`;
}

export function buildRemotePythonCommand(options: {
	cwd: string;
	interpreter?: string;
	runnerPath: string;
	env?: Record<string, string | undefined>;
}): string {
	const env: Record<string, string> = {
		PYTHONUNBUFFERED: "1",
		PYTHONIOENCODING: "utf-8",
	};
	for (const [key, value] of Object.entries(options.env ?? {})) {
		if (typeof value === "string") env[key] = value;
	}
	// PI_TOOL_BRIDGE_* values live in the remote process environment; eval.md documents
	// the trusted SSH account requirement for same-UID remote processes.
	const envArgs = Object.entries(env).map(([key, value]) => `${key}=${quotePosixPath(value)}`);
	const envPrefix = envArgs.length > 0 ? `env ${envArgs.join(" ")} ` : "";
	const runnerPath = quotePosixPath(options.runnerPath);
	const interpreter = options.interpreter ? quotePosixPath(options.interpreter) : `"$__omp_python"`;
	const resolveInterpreter = options.interpreter
		? ""
		: "if command -v python3 >/dev/null 2>&1; then __omp_python=python3; elif command -v python >/dev/null 2>&1; then __omp_python=python; else echo 'Remote Python eval requires python3 or python on PATH' >&2; exit 127; fi; ";
	return `${resolveInterpreter}exec ${envPrefix}${interpreter} -u ${runnerPath}`;
}

export function buildRemotePythonInitScript(cwd: string, env?: Record<string, string | undefined>): string {
	const envEntries = Object.entries(env ?? {}).filter(([, value]) => value !== undefined);
	const envPayload = Object.fromEntries(envEntries);
	return [
		"import os, sys",
		`__omp_cwd = ${JSON.stringify(cwd)}`,
		"os.chdir(__omp_cwd)",
		"__omp_cwd = os.getcwd()",
		`__omp_env = ${JSON.stringify(envPayload)}`,
		"for __omp_key, __omp_val in __omp_env.items():\n    os.environ[__omp_key] = __omp_val",
		"if __omp_cwd not in sys.path:\n    sys.path.insert(0, __omp_cwd)",
	].join("\n");
}

async function stageRemoteRunner(host: SSHConnectionTarget, signal: AbortSignal | undefined): Promise<string> {
	const runnerPath = buildRemotePythonRunnerPath();
	await writeRemoteFile(host, runnerPath, new TextEncoder().encode(RUNNER_SCRIPT), { signal });
	return runnerPath;
}

export class RemotePythonKernel extends BaseKernel<KernelExecuteOptions> {
	constructor(id: string) {
		super(id, {
			languageName: "Python",
			traceIpc: TRACE_IPC,
			exitPayload: JSON.stringify({ type: "exit" }),
			interruptEscalationMs: INTERRUPT_ESCALATION_MS,
			shutdownGraceMs: SHUTDOWN_GRACE_MS,
			buildPayload: (code, msgId, opts) =>
				JSON.stringify({
					id: msgId,
					code,
					cwd: opts?.cwd,
					env: opts?.env,
					silent: opts?.silent ?? false,
					storeHistory: opts?.storeHistory ?? !(opts?.silent ?? false),
				}),
		});
	}

	static async start(options: RemotePythonKernelStartOptions): Promise<RemotePythonKernel> {
		const shell = await ensureRemotePosixShell(options.sshHost);
		const runnerPath = await stageRemoteRunner(options.sshHost, options.signal);
		const remoteCommand = buildRemotePythonCommand({
			cwd: options.cwd,
			interpreter: options.interpreter,
			runnerPath,
			env: options.env,
		});
		const args = await buildRemoteCommand(options.sshHost, wrapInPosixShell(shell, remoteCommand), {
			allowStdin: true,
			controlMaster: false,
			extraArgs: buildRemotePythonSshExtraArgs(options.bridge),
		});
		const kernel = new RemotePythonKernel(Snowflake.next());
		const proc = Bun.spawn(["ssh", ...args], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		kernel.setProcess(proc);

		const startup = { signal: options.signal, deadlineMs: options.deadlineMs };
		const startupBudget = Math.min(getRemainingTimeMs(startup.deadlineMs) ?? STARTUP_TIMEOUT_MS, STARTUP_TIMEOUT_MS);

		try {
			await kernel.executeWithBudget(
				buildRemotePythonInitScript(options.cwd, options.env),
				startup.signal,
				startupBudget,
				"Python kernel init",
			);
			await kernel.executeWithBudget(PYTHON_PRELUDE, startup.signal, startupBudget, "Python kernel prelude");
			return kernel;
		} catch (err) {
			await kernel.shutdown({ timeoutMs: SHUTDOWN_GRACE_MS }).catch(() => {});
			throw err;
		}
	}
}
