import type { ToolSession } from "../../tools";
import {
	type ExecutorBackend,
	type ExecutorBackendExecOptions,
	type ExecutorBackendResult,
	resolveEvalUrlRoots,
} from "../backend";
import {
	namespaceSessionId as sharedNamespace,
	readInterpreterSetting as sharedReadInterpreterSetting,
	toExecutorBackendResult,
} from "../backend-helpers";
import { executeRust } from "./executor";
import { checkRustKernelAvailability } from "./kernel";

const RUST_SESSION_PREFIX = "rust:";

export function namespaceSessionId(sessionId: string): string {
	return sharedNamespace(sessionId, RUST_SESSION_PREFIX);
}

function readInterpreterSetting(session: ToolSession): string | undefined {
	return sharedReadInterpreterSetting(session, "rust.interpreter");
}

export default {
	id: "rust",
	label: "Rust",
	highlightLang: "rust",

	async isAvailable(session: ToolSession): Promise<boolean> {
		const availability = await checkRustKernelAvailability(session.cwd, readInterpreterSetting(session));
		return availability.ok;
	},

	async execute(code: string, opts: ExecutorBackendExecOptions): Promise<ExecutorBackendResult> {
		const result = await executeRust(code, {
			cwd: opts.cwd,
			idleTimeoutMs: opts.idleTimeoutMs,
			signal: opts.signal,
			sessionId: namespaceSessionId(opts.sessionId),
			interpreter: readInterpreterSetting(opts.session),
			sessionFile: opts.sessionFile,
			artifactsDir: opts.session.getArtifactsDir?.() ?? undefined,
			localRoots: resolveEvalUrlRoots(opts.session),
			kernelOwnerId: opts.kernelOwnerId,
			reset: opts.reset,
			onChunk: opts.onChunk,
		});
		return toExecutorBackendResult(result);
	},
} satisfies ExecutorBackend;
