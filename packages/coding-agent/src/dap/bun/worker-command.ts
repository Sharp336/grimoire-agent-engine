import * as path from "node:path";
import { isCompiledBinary } from "@oh-my-pi/pi-utils/env";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { BUN_DAP_WORKER_ARG } from "./constants";

export interface BunDapWorkerCommand {
	resolvedCommand: string;
	args: string[];
}

export function resolveBunDapWorkerCommand(): BunDapWorkerCommand {
	if (isCompiledBinary()) return { resolvedCommand: process.execPath, args: [BUN_DAP_WORKER_ARG] };
	const hostEntry = workerHostEntry();
	if (hostEntry) return { resolvedCommand: process.execPath, args: [hostEntry, BUN_DAP_WORKER_ARG] };
	const packageRoot = path.resolve(import.meta.dir, "..", "..", "..");
	return { resolvedCommand: process.execPath, args: [path.join(packageRoot, "src", "cli.ts"), BUN_DAP_WORKER_ARG] };
}
