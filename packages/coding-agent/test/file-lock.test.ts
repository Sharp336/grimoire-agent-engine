import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __internalsForTesting, withFileLock } from "@oh-my-pi/pi-coding-agent/config/file-lock";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const { tryAcquireLock, releaseLock, readLockInfo, isLockStale, getLockPath } = __internalsForTesting;

const ROOTS: string[] = [];

async function mkRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "filelock-test-"));
	ROOTS.push(root);
	return root;
}

afterAll(async () => {
	for (const root of ROOTS) {
		await removeWithRetries(root).catch(() => {});
	}
});

describe("file-lock token ownership (F1)", () => {
	test("releaseLock with the wrong token leaves the lock intact", async () => {
		const root = await mkRoot();
		const target = path.join(root, "data.json");
		const lockPath = getLockPath(target);

		const token = await tryAcquireLock(lockPath);
		expect(token).not.toBeNull();
		expect(typeof token).toBe("string");

		// A contender that lost a race calling release with a guessed/empty token
		// must NOT remove the rightful owner's lock.
		await releaseLock(lockPath, "not-the-real-token");

		const info = await readLockInfo(lockPath);
		expect(info).not.toBeNull();
		expect(info?.token).toBe(token!);

		// The rightful owner can still release.
		await releaseLock(lockPath, token!);
		expect(await readLockInfo(lockPath)).toBeNull();
	});

	test("isLockStale does NOT declare a freshly-created empty dir stale", async () => {
		const root = await mkRoot();
		const target = path.join(root, "race.json");
		const lockPath = getLockPath(target);

		// Simulate the precise window: mkdir succeeded for the winner but the
		// info file has not been written yet.
		await fs.mkdir(lockPath);

		const stale = await isLockStale(lockPath, 10_000);
		expect(stale).toBe(false);

		await removeWithRetries(lockPath);
	});

	test("withFileLock serializes N concurrent writers without lost updates", async () => {
		const root = await mkRoot();
		const target = path.join(root, "counter.json");
		await fs.writeFile(target, JSON.stringify({ counter: 0 }));

		const N = 30;
		await Promise.all(
			Array.from({ length: N }, () =>
				withFileLock(
					target,
					async () => {
						const text = await fs.readFile(target, "utf-8");
						const data = JSON.parse(text) as { counter: number };
						data.counter += 1;
						// Widen the critical-section window so any concurrency leak
						// surfaces as a lost update.
						await Bun.sleep(2);
						await fs.writeFile(target, JSON.stringify(data));
					},
					{ retries: 500, retryDelayMs: 5 },
				),
			),
		);

		const text = await fs.readFile(target, "utf-8");
		const final = JSON.parse(text) as { counter: number };
		expect(final.counter).toBe(N);
	}, 30_000);

	test("aborts promptly while waiting for an owned lock", async () => {
		const root = await mkRoot();
		const target = path.join(root, "abort.json");
		const entered = Promise.withResolvers<void>();
		const leave = Promise.withResolvers<void>();
		const owner = withFileLock(target, async () => {
			entered.resolve();
			await leave.promise;
		});
		await entered.promise;

		const controller = new AbortController();
		const reason = new Error("stop waiting for lock");
		const contender = withFileLock(target, async () => undefined, {
			retries: 5,
			retryDelayMs: 20,
			signal: controller.signal,
		});
		controller.abort(reason);

		await expect(contender).rejects.toThrow(reason.message);
		leave.resolve();
		await owner;
	});

	test("releases ownership when cancellation lands around heartbeat initialization", async () => {
		for (const abortAtCheck of [3, 4]) {
			const root = await mkRoot();
			const target = path.join(root, `heartbeat-abort-${abortAtCheck}.json`);
			const controller = new AbortController();
			const reason = new Error(`aborted at lock check ${abortAtCheck}`);
			let checks = 0;
			let entered = false;
			const signal = new Proxy(controller.signal, {
				get(targetSignal, property) {
					if (property === "throwIfAborted") {
						return () => {
							checks++;
							if (checks === abortAtCheck) controller.abort(reason);
							targetSignal.throwIfAborted();
						};
					}
					const value = Reflect.get(targetSignal, property, targetSignal) as unknown;
					return typeof value === "function" ? value.bind(targetSignal) : value;
				},
			});

			await expect(
				withFileLock(
					target,
					async () => {
						entered = true;
					},
					{ signal },
				),
			).rejects.toThrow(reason.message);
			expect(entered).toBe(false);
			expect(await __internalsForTesting.readLockInfo(__internalsForTesting.getLockPath(target))).toBeNull();
		}
	});

	test("heartbeats prevent a live owner from being reaped as stale", async () => {
		const root = await mkRoot();
		const target = path.join(root, "heartbeat.json");
		const entered = Promise.withResolvers<void>();
		const leave = Promise.withResolvers<void>();
		const owner = withFileLock(
			target,
			async () => {
				entered.resolve();
				await leave.promise;
			},
			{ staleMs: 40, heartbeatMs: 5 },
		);
		await entered.promise;
		await Bun.sleep(70);

		await expect(
			withFileLock(target, async () => undefined, { staleMs: 40, retries: 2, retryDelayMs: 5 }),
		).rejects.toThrow("Failed to acquire lock");
		leave.resolve();
		await owner;
	});
});
