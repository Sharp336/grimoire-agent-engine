import { expect, test } from "bun:test";
import { renderTerminalOutputIsolated } from "../src/launch/terminal-output-worker-client";

class CleanExitWorker extends EventTarget {
	postMessage(): void {
		this.dispatchEvent(new Event("close"));
	}

	terminate(): void {}
}

test("legacy replay rejects when its worker exits before responding", async () => {
	const originalWorker = globalThis.Worker;
	Object.defineProperty(globalThis, "Worker", { configurable: true, value: CleanExitWorker });
	try {
		let outcome: { error?: unknown; settled: boolean } = { settled: false };
		void renderTerminalOutputIsolated("ready", { head: false, maxRows: 1 }).then(
			() => {
				outcome = { settled: true };
			},
			error => {
				outcome = { error, settled: true };
			},
		);
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(outcome.settled).toBeTrue();
		expect(outcome.error).toBeInstanceOf(Error);
		expect((outcome.error as Error).message).toBe("Terminal output worker exited before responding");
	} finally {
		Object.defineProperty(globalThis, "Worker", { configurable: true, value: originalWorker });
	}
});
