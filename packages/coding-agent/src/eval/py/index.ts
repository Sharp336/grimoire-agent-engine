import type { ToolSession } from "../../tools";
import {
	type ExecutorBackend,
	type ExecutorBackendExecOptions,
	type ExecutorBackendResult,
	resolveEvalUrlRoots,
} from "../backend";
import {
	readSetting,
	namespaceSessionId as sharedNamespace,
	readInterpreterSetting as sharedReadInterpreterSetting,
	toExecutorBackendResult,
} from "../backend-helpers";
import { executePython, type PythonExecutorOptions } from "./executor";
import { checkPythonKernelAvailability } from "./kernel";

const PYTHON_SESSION_PREFIX = "python:";

export function namespaceSessionId(sessionId: string): string {
	return sharedNamespace(sessionId, PYTHON_SESSION_PREFIX);
}

function readInterpreterSetting(session: ToolSession): string | undefined {
	return sharedReadInterpreterSetting(session, "python.interpreter");
}
export default {
	id: "python",
	label: "Python",
	highlightLang: "python",

	async isAvailable(session: ToolSession): Promise<boolean> {
		const availability = await checkPythonKernelAvailability(session.cwd, readInterpreterSetting(session));
		return availability.ok;
	},

	async execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
		const kernelMode = readSetting<PythonExecutorOptions["kernelMode"]>(opts.session, "python.kernelMode");
		const remote = opts.sshHost !== undefined;
		const executorOptions: PythonExecutorOptions = {
			cwd: opts.cwd,
			sshHost: opts.sshHost,
			idleTimeoutMs: opts.idleTimeoutMs,
			signal: opts.signal,
			sessionId: namespaceSessionId(opts.sessionId),
			kernelMode,
			interpreter: remote ? undefined : readInterpreterSetting(opts.session),
			sessionFile: remote ? undefined : opts.sessionFile,
			artifactsDir: remote ? undefined : (opts.session.getArtifactsDir?.() ?? undefined),
			localRoots: remote ? undefined : resolveEvalUrlRoots(opts.session),
			kernelOwnerId: opts.kernelOwnerId,
			reset: opts.reset,
			onChunk: opts.onChunk,
			onStatus: opts.onStatus,
			toolSession: opts.session,
		};
		const result = await executePython(code, executorOptions);
		return toExecutorBackendResult(result);
	},
} satisfies ExecutorBackend;
