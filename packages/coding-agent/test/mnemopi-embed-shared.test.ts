import { describe, expect, it } from "bun:test";
import { MnemopiEmbedClient, type MnemopiEmbedWorkerHandle } from "../src/mnemopi/embed-client";
import type { MnemopiEmbedWorkerInbound, MnemopiEmbedWorkerOutbound } from "../src/mnemopi/embed-protocol";
import { connectSharedMnemopiEmbedWorker } from "../src/mnemopi/embed-shared-client";

function inertWorker(): MnemopiEmbedWorkerHandle {
	return {
		send() {},
		onMessage() {
			return () => {};
		},
		onError() {
			return () => {};
		},
		async terminate() {},
	};
}

function controlledWorker(): {
	worker: MnemopiEmbedWorkerHandle;
	messages: MnemopiEmbedWorkerInbound[];
	firstMessage: PromiseWithResolvers<MnemopiEmbedWorkerInbound>;
	emitMessage: (message: MnemopiEmbedWorkerOutbound) => void;
	emitError: (error: Error) => void;
} {
	const messages: MnemopiEmbedWorkerInbound[] = [];
	const messageListeners = new Set<(message: MnemopiEmbedWorkerOutbound) => void>();
	const errorListeners = new Set<(error: Error) => void>();
	const firstMessage = Promise.withResolvers<MnemopiEmbedWorkerInbound>();
	return {
		messages,
		firstMessage,
		emitMessage: message => {
			for (const listener of messageListeners) listener(message);
		},
		emitError: error => {
			for (const listener of errorListeners) listener(error);
		},
		worker: {
			send(message) {
				messages.push(message);
				firstMessage.resolve(message);
			},
			onMessage(handler) {
				messageListeners.add(handler);
				return () => messageListeners.delete(handler);
			},
			onError(handler) {
				errorListeners.add(handler);
				return () => errorListeners.delete(handler);
			},
			async terminate() {
				messageListeners.clear();
				errorListeners.clear();
			},
		},
	};
}

describe("shared Mnemopi embed client", () => {
	it("falls back to a private worker when shared acquisition fails", async () => {
		const fallback = inertWorker();
		let fallbackCalls = 0;
		const worker = await connectSharedMnemopiEmbedWorker(
			() => {
				fallbackCalls += 1;
				return fallback;
			},
			async () => {
				throw new Error("global daemon unavailable");
			},
		);

		expect(worker).toBe(fallback);
		expect(fallbackCalls).toBe(1);
	});

	it("replays interrupted initialization on a private worker", async () => {
		const shared = controlledWorker();
		const fallback = controlledWorker();
		const worker = await connectSharedMnemopiEmbedWorker(
			() => fallback.worker,
			async () => shared.worker,
		);
		const responses: MnemopiEmbedWorkerOutbound[] = [];
		worker.onMessage(message => responses.push(message));

		const init = { type: "init", id: "init-1", model: "fast-test" } as const;
		worker.send(init);
		shared.emitError(new Error("broker connection closed"));
		fallback.emitMessage({ type: "ready", id: init.id });

		expect(shared.messages).toEqual([init]);
		expect(fallback.messages).toEqual([init]);
		expect(responses).toEqual([{ type: "ready", id: init.id }]);
		await worker.terminate();
	});

	it("does not replay requests completed before the shared worker fails", async () => {
		const shared = controlledWorker();
		const fallback = controlledWorker();
		const worker = await connectSharedMnemopiEmbedWorker(
			() => fallback.worker,
			async () => shared.worker,
		);
		const init: MnemopiEmbedWorkerInbound = { type: "init", id: "init-1", model: "fast-test" };
		worker.send(init);
		shared.emitMessage({ type: "ready", id: init.id });

		shared.emitError(new Error("broker connection closed"));

		expect(fallback.messages).toEqual([]);
		await worker.terminate();
	});

	it("surfaces private-worker failure after failover", async () => {
		const shared = controlledWorker();
		const fallback = controlledWorker();
		const worker = await connectSharedMnemopiEmbedWorker(
			() => fallback.worker,
			async () => shared.worker,
		);
		const errors: string[] = [];
		worker.onError(error => errors.push(error.message));

		shared.emitError(new Error("broker connection closed"));
		fallback.emitError(new Error("private worker failed"));

		expect(errors).toEqual(["private worker failed"]);
		await worker.terminate();
	});

	it("settles an interrupted client request when private fallback creation fails", async () => {
		const firstShared = controlledWorker();
		const replacementShared = controlledWorker();
		let acquisitions = 0;
		const client = new MnemopiEmbedClient(
			() =>
				connectSharedMnemopiEmbedWorker(
					() => {
						throw new Error("private worker unavailable");
					},
					async () => (++acquisitions === 1 ? firstShared.worker : replacementShared.worker),
				),
			1_000,
		);

		const interrupted = client.initialize("fast-test", undefined);
		await firstShared.firstMessage.promise;
		firstShared.emitError(new Error("broker connection closed"));
		expect(await Promise.race([interrupted, Bun.sleep(50).then(() => "still pending" as const)])).toBeNull();
		expect(await interrupted).toBeNull();

		const retried = client.initialize("fast-test", undefined);
		const retryRequest = await replacementShared.firstMessage.promise;
		replacementShared.emitMessage({ type: "ready", id: retryRequest.id });
		expect(await retried).not.toBeNull();
		expect(acquisitions).toBe(2);
		await client.terminate();
	});

	it("replays an interrupted embed on a private worker", async () => {
		const shared = controlledWorker();
		const fallback = controlledWorker();
		const worker = await connectSharedMnemopiEmbedWorker(
			() => fallback.worker,
			async () => shared.worker,
		);
		const responses: MnemopiEmbedWorkerOutbound[] = [];
		worker.onMessage(message => responses.push(message));

		const embed: MnemopiEmbedWorkerInbound = {
			type: "embed",
			id: "embed-1",
			model: "fast-test",
			texts: ["hello"],
		};
		worker.send(embed);
		shared.emitError(new Error("broker connection closed"));
		fallback.emitMessage({ type: "vectors", id: embed.id, vectors: [[1, 2, 3]] });

		expect(shared.messages).toEqual([embed]);
		expect(fallback.messages).toEqual([embed]);
		expect(responses).toEqual([{ type: "vectors", id: embed.id, vectors: [[1, 2, 3]] }]);
		await worker.terminate();
	});
});
