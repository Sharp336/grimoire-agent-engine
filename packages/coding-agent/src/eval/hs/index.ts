import type { ToolSession } from "../../tools";
import {
	type ExecutorBackend,
	type ExecutorBackendExecOptions,
	type ExecutorBackendResult,
	resolveEvalUrlRoots,
} from "../backend";
import { executeHs } from "./executor";

export default {
	id: "hs",
	label: "Haskell",
	highlightLang: "haskell",

	async isAvailable(_session: ToolSession): Promise<boolean> {
		try {
			const proc = Bun.spawn(["runhaskell", "--version"], {
				stdout: "ignore",
				stderr: "ignore",
			});
			const exitCode = await proc.exited;
			return exitCode === 0;
		} catch {
			return false;
		}
	},

	async execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
		const result = await executeHs(code, {
			cwd: opts.cwd,
			idleTimeoutMs: opts.idleTimeoutMs,
			signal: opts.signal,
			sessionId: opts.sessionId,
			sessionFile: opts.sessionFile,
			reset: opts.reset,
			onChunk: opts.onChunk,
			onStatus: opts.onStatus,
			session: opts.session,
			localRoots: resolveEvalUrlRoots(opts.session),
		});
		return {
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			artifactId: result.artifactId,
			totalLines: result.totalLines,
			totalBytes: result.totalBytes,
			outputLines: result.outputLines,
			outputBytes: result.outputBytes,
			displayOutputs: result.displayOutputs,
		};
	},
} satisfies ExecutorBackend;
