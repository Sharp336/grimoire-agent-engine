/**
 * Shared task executor for the scheduler.
 *
 * Supports both shell execution (sh -c) and agent execution (omp --print).
 * All executions are bounded by a configurable timeout.
 */
import { logger } from "@oh-my-pi/pi-utils";

export interface ExecutionResult {
	exitCode: number;
	output: string;
	stderr: string;
	timedOut: boolean;
}

export interface ExecutionOptions {
	taskType?: "shell" | "agent";
	timeoutMs?: number;
	ompBinary?: string;
}

/**
 * Run a scheduled task command.
 *
 * - shell: executes via `sh -c <command>`
 * - agent: executes via `omp --print <command>` (requires ompBinary)
 *
 * Returns the full stdout, stderr, exit code, and whether a timeout occurred.
 */
export async function executeScheduledCommand(
	command: string,
	options: ExecutionOptions = {},
): Promise<ExecutionResult> {
	const taskType = options.taskType ?? "shell";
	const timeoutMs = options.timeoutMs ?? (taskType === "agent" ? 120_000 : 30_000);

	let proc: ReturnType<typeof Bun.spawn>;

	if (taskType === "agent") {
		const ompBinary = options.ompBinary ?? "omp";
		proc = Bun.spawn([ompBinary, "--print", command], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
	} else {
		proc = Bun.spawn(["sh", "-c", command], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
	}

	let output = "";
	let stderr = "";
	let _timedOut = false;

	const timeoutPromise = Bun.sleep(timeoutMs).then(() => {
		_timedOut = true;
		try {
			proc.kill();
		} catch {
			// process may already be gone
		}
		return { exitCode: 124, output, stderr, timedOut: true };
	});

	const execPromise = (async () => {
		try {
			const [outText, errText] = await Promise.all([
				new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
				new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
			]);
			output = outText;
			stderr = errText;
		} catch (error) {
			logger.error("Failed to capture process output", { error: String(error) });
			stderr = error instanceof Error ? error.message : String(error);
		}

		const exitCode = await proc.exited;
		return { exitCode, output, stderr, timedOut: false };
	})();

	return Promise.race([execPromise, timeoutPromise]);
}
