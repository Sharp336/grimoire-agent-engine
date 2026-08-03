import type { ComputerProcessTransport } from "./protocol";
import { ComputerWorkerCore } from "./worker";

/** Starts the computer runtime inside an IPC subprocess. */
export function startComputerProcess(transport: ComputerProcessTransport): void {
	new ComputerWorkerCore({ ...transport, close() {} });
}
