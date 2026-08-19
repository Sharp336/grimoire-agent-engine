import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_OUTPUT_BYTES = 256 * 1024;
const KILL_GRACE_MS = 1_500;

export interface MnemonRunOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	readonly?: boolean;
}

export interface MnemonProcessResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

export interface MnemonCli {
	command: string;
	runText(args: string[], options?: MnemonRunOptions): Promise<string>;
	runJson(args: string[], options?: MnemonRunOptions): Promise<unknown>;
}

const COMMON_PATHS = [
	join(homedir(), ".local", "bin", "mnemon"),
	join(homedir(), "go", "bin", "mnemon"),
	"/opt/homebrew/bin/mnemon",
	"/usr/local/bin/mnemon",
];

function findOnPath() {
	for (const dir of String(process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		const candidate = join(dir, "mnemon");
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

export function findMnemonCommand(configured?: string) {
	const explicit = configured?.trim();
	if (explicit && existsSync(explicit)) return explicit;
	const fromEnv = process.env.MNEMON_CLI_PATH?.trim();
	if (fromEnv && existsSync(fromEnv)) return fromEnv;
	return findOnPath() ?? COMMON_PATHS.find(path => existsSync(path)) ?? "mnemon";
}

async function spawnOnce(command: string, args: string[], options: MnemonRunOptions = {}) {
	const { promise, resolve, reject } = Promise.withResolvers<MnemonProcessResult>();
	const child = spawn(command, args, {
		stdio: ["ignore", "pipe", "pipe"],
		shell: false,
		env: process.env,
		windowsHide: true,
	});
	let stdout = "";
	let stderr = "";
	let bytes = 0;
	let settled = false;
	let killTimer: ReturnType<typeof setTimeout> | undefined;

	const finish = (error: Error | null, result?: MnemonProcessResult) => {
		if (settled) return;
		settled = true;
		clearTimeout(timeout);
		clearTimeout(killTimer);
		options.signal?.removeEventListener("abort", onAbort);
		if (error) reject(error);
		else resolve(result!);
	};
	const stop = () => {
		if (child.exitCode !== null || child.signalCode !== null) return;
		child.kill("SIGTERM");
		killTimer = setTimeout(() => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}, KILL_GRACE_MS);
	};
	const onAbort = () => {
		stop();
		finish(new Error(`mnemon aborted: ${String(options.signal?.reason ?? "cancelled")}`));
	};
	const append = (kind: "stdout" | "stderr", chunk: Buffer) => {
		bytes += chunk.byteLength;
		if (bytes > MAX_OUTPUT_BYTES) {
			stop();
			finish(new Error(`mnemon output exceeded ${MAX_OUTPUT_BYTES} bytes`));
			return;
		}
		const text = chunk.toString("utf8");
		if (kind === "stdout") stdout += text;
		else stderr += text;
	};

	child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
	child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
	child.on("error", (error: Error) => {
		finish(new Error(`failed to launch mnemon (${JSON.stringify(command)}): ${error.message}`));
	});
	child.on("close", exitCode => finish(null, { stdout, stderr, exitCode }));

	const timeout = setTimeout(() => {
		stop();
		finish(new Error(`mnemon did not respond within ${options.timeoutMs}ms`));
	}, options.timeoutMs ?? 8_000);

	if (options.signal?.aborted) onAbort();
	else options.signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

export function createMnemonCli(command = findMnemonCommand()): MnemonCli {
	let queue = Promise.resolve();
	const enqueue = <T>(work: () => Promise<T>) => {
		const run = queue.then(work, work);
		queue = run.then(() => undefined, () => undefined);
		return run;
	};

	const runText = (args: string[], options: MnemonRunOptions = {}) =>
		enqueue(async () => {
			if (options.signal?.aborted) {
				throw new Error(`mnemon aborted: ${String(options.signal.reason ?? "cancelled")}`);
			}
			const argv = options.readonly ? ["--readonly", ...args] : [...args];
			const result = await spawnOnce(command, argv, options);
			if (result.exitCode !== 0) {
				const detail = result.stderr.trim() || result.stdout.trim() || "no output";
				throw new Error(`mnemon ${args.join(" ")} exited ${String(result.exitCode)}: ${detail}`);
			}
			return String(result.stdout ?? "").trim();
		});

	const runJson = async (args: string[], options: MnemonRunOptions = {}) => {
		const stdout = await runText(args, options);
		try {
			return JSON.parse(stdout) as unknown;
		} catch {
			throw new Error(`mnemon ${args.join(" ")} returned invalid JSON`);
		}
	};

	return { command, runText, runJson };
}
