import { WORKER_HOST_SELECTOR_PREFIX } from "@oh-my-pi/pi-utils/worker-host";

const STATS_WORKER_ARG = `${WORKER_HOST_SELECTOR_PREFIX}stats_sync`;

declare const self: Worker & {
	onmessage: ((event: MessageEvent<{ kind: "ping" }>) => void) | null;
};

if (Bun.isMainThread) {
	const worker = new Worker(Bun.main, { type: "module", argv: [STATS_WORKER_ARG] });
	const response = Promise.withResolvers<unknown>();
	worker.addEventListener("message", event => response.resolve(event.data));
	worker.addEventListener("error", event => response.reject(event.error ?? new Error(event.message)));
	worker.postMessage({ kind: "ping" });
	try {
		process.stdout.write(`${JSON.stringify(await response.promise)}\n`);
	} finally {
		worker.terminate();
	}
} else {
	const selector = process.argv.find(arg => arg.startsWith(WORKER_HOST_SELECTOR_PREFIX));
	if (selector === STATS_WORKER_ARG) {
		self.onmessage = (_event: MessageEvent<{ kind: "ping" }>) => {
			self.postMessage({ ok: true, kind: "pong" });
		};
	} else {
		throw new Error(`unknown worker selector: ${selector}`);
	}
}
