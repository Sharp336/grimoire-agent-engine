import { declareWorkerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { startComputerProcess } from "../../src/tools/computer/process-entry";
import { COMPUTER_PROCESS_ARG, type ComputerWorkerInbound } from "../../src/tools/computer/protocol";
import { spawnComputerSubprocess } from "../../src/tools/computer/supervisor";

if (process.argv[2] === COMPUTER_PROCESS_ARG) {
	const stopped = Promise.withResolvers<void>();
	startComputerProcess({
		send(message) {
			process.send?.(message);
		},
		sendAndFlush(message) {
			const flushed = Promise.withResolvers<void>();
			process.send?.(message, () => flushed.resolve());
			return flushed.promise;
		},
		onMessage(handler) {
			const listener = (message: unknown): void => handler(message as ComputerWorkerInbound);
			process.on("message", listener);
			return () => process.off("message", listener);
		},
	});
	process.on("disconnect", () => stopped.resolve());
	await stopped.promise;
	process.kill(process.pid, "SIGKILL");
}

declareWorkerHostEntry();
const worker = spawnComputerSubprocess();
const pong = Promise.withResolvers<unknown>();
const closed = Promise.withResolvers<void>();
const unsubscribeMessage = worker.onMessage(message => {
	if (message.type === "pong") pong.resolve(message);
	if (message.type === "closed") closed.resolve();
});
const unsubscribeError = worker.onError(error => pong.reject(error));
try {
	worker.send({ type: "ping", id: "computer-npm-bundle" });
	process.stdout.write(`${JSON.stringify(await pong.promise)}\n`);
	worker.send({ type: "close" });
	await closed.promise;
} finally {
	unsubscribeMessage();
	unsubscribeError();
	await worker.terminate();
}
