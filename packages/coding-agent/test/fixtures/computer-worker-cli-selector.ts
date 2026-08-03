import { spawnComputerSubprocess } from "../../src/tools/computer/supervisor";

const worker = spawnComputerSubprocess();
const response = Promise.withResolvers<unknown>();
const closed = Promise.withResolvers<void>();
const unsubscribeMessage = worker.onMessage(message => {
	if (message.type === "pong" && message.id === "computer-cli-selector") response.resolve(message);
	if (message.type === "closed") closed.resolve();
});
const unsubscribeError = worker.onError(error => response.reject(error));
worker.send({ type: "ping", id: "computer-cli-selector" });
try {
	process.stdout.write(`${JSON.stringify(await response.promise)}\n`);
	worker.send({ type: "close" });
	await closed.promise;
} finally {
	unsubscribeMessage();
	unsubscribeError();
	await worker.terminate();
}
