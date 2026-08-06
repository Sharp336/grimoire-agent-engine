import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getSessionSpawnSemaphore, withSessionSpawnPermit } from "@oh-my-pi/pi-coding-agent/task";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

function createSession(maxConcurrency: number): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({ "task.maxConcurrency": maxConcurrency }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as ToolSession;
}

describe("session spawn permits", () => {
	it("keeps one session-owned semaphore and removes an aborted waiter", async () => {
		const session = createSession(1);
		const firstGate = Promise.withResolvers<void>();
		const firstEntered = Promise.withResolvers<void>();
		const first = withSessionSpawnPermit(session, undefined, async () => {
			firstEntered.resolve();
			await firstGate.promise;
		});
		await firstEntered.promise;

		const semaphore = getSessionSpawnSemaphore(session);
		expect(session.spawnSemaphore).toBe(semaphore);

		const abortController = new AbortController();
		let abortedWaiterRan = false;
		const abortedWaiter = withSessionSpawnPermit(session, abortController.signal, () => {
			abortedWaiterRan = true;
		});
		abortController.abort(new Error("cancelled waiter"));
		await expect(abortedWaiter).rejects.toThrow("cancelled waiter");

		let nextWaiterRan = false;
		const nextWaiter = withSessionSpawnPermit(session, undefined, () => {
			nextWaiterRan = true;
		});
		await Promise.resolve();
		expect(abortedWaiterRan).toBe(false);
		expect(nextWaiterRan).toBe(false);

		firstGate.resolve();
		await first;
		await nextWaiter;
		expect(nextWaiterRan).toBe(true);
		expect(session.spawnSemaphore).toBe(semaphore);
	});

	it("raises the live limit when the next permit acquisition enters", async () => {
		const session = createSession(1);
		const firstGate = Promise.withResolvers<void>();
		const firstEntered = Promise.withResolvers<void>();
		const first = withSessionSpawnPermit(session, undefined, async () => {
			firstEntered.resolve();
			await firstGate.promise;
		});
		await firstEntered.promise;

		session.settings.override("task.maxConcurrency", 2);
		let secondEntered = false;
		const second = withSessionSpawnPermit(session, undefined, () => {
			secondEntered = true;
		});
		await second;
		expect(secondEntered).toBe(true);

		firstGate.resolve();
		await first;
	});

	it("applies a lowered live limit before each permit release", async () => {
		const session = createSession(2);
		const firstGate = Promise.withResolvers<void>();
		const secondGate = Promise.withResolvers<void>();
		const firstEntered = Promise.withResolvers<void>();
		const secondEntered = Promise.withResolvers<void>();
		const first = withSessionSpawnPermit(session, undefined, async () => {
			firstEntered.resolve();
			await firstGate.promise;
		});
		const second = withSessionSpawnPermit(session, undefined, async () => {
			secondEntered.resolve();
			await secondGate.promise;
		});
		await Promise.all([firstEntered.promise, secondEntered.promise]);

		let thirdEntered = false;
		const third = withSessionSpawnPermit(session, undefined, () => {
			thirdEntered = true;
		});
		await Promise.resolve();
		expect(thirdEntered).toBe(false);

		session.settings.override("task.maxConcurrency", 1);
		firstGate.resolve();
		await first;
		await Promise.resolve();
		expect(thirdEntered).toBe(false);

		secondGate.resolve();
		await second;
		await third;
		expect(thirdEntered).toBe(true);
	});
});
