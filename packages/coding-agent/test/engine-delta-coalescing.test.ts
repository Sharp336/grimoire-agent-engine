import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { StreamAdmissionLimits } from "@oh-my-pi/pi-ai/utils/stream-admission";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EngineRuntime } from "@oh-my-pi/pi-coding-agent/engine/runtime";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { startStorageWorker, storageBlobsDir } from "./helpers/storage-worker-fixture";

const executable = process.env.ARTEL_STORAGE_TEST_RUNTIME_EXE;
const runRoot = process.env.ARTEL_STORAGE_TEST_RUN_ROOT;

const frame = (content: string, finishReason: string | null = null) =>
	`data: ${JSON.stringify({
		id: "chatcmpl-flood",
		object: "chat.completion.chunk",
		created: 0,
		model: "delta-flood",
		choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
	})}\n\n`;

/**
 * An OpenAI-compatible model that sends each network chunk of deltas as soon as the previous chunk reached
 * session subscribers: as fast as the Engine consumes. Optionally storage stalls every durable text update
 * after the first until the whole answer was published (or the run ended).
 */
async function runFlood(
	chunkSizes: readonly number[],
	options: { stallAfterFirstUpdate?: boolean; streamAdmissionLimits?: Partial<StreamAdmissionLimits> } = {},
) {
	const deltas = Array.from({ length: chunkSizes.reduce((sum, size) => sum + size, 0) }, (_, index) => `t${index} `);
	const ends = chunkSizes.map((_, index) => chunkSizes.slice(0, index + 1).reduce((sum, size) => sum + size, 0));
	const produced = Promise.withResolvers<void>();
	let published = 0;
	let publishedText = "";
	let chunkPublished = Promise.withResolvers<void>();
	const encoder = new TextEncoder();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			await request.arrayBuffer();
			let chunk = 0;
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					if (chunk > 0) {
						await Promise.race([chunkPublished.promise, produced.promise]);
						chunkPublished = Promise.withResolvers<void>();
					}
					if (chunk === chunkSizes.length) {
						controller.enqueue(encoder.encode(`${frame("", "stop")}data: [DONE]\n\n`));
						controller.close();
						return;
					}
					const start = chunk === 0 ? 0 : ends[chunk - 1];
					controller.enqueue(
						encoder.encode(
							deltas
								.slice(start, ends[chunk++])
								.map(delta => frame(delta))
								.join(""),
						),
					);
				},
			});
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		},
	});
	const root = await fs.mkdtemp(path.join(runRoot!, "delta-coalescing-"));
	const worker = await startStorageWorker(executable!, root, `${crypto.randomUUID()}${crypto.randomUUID()}`, 1);
	const savedEnv = { binding: process.env.GRIMOIRE_STORAGE_BINDING, blobs: process.env.PI_BLOBS_DIR };
	process.env.GRIMOIRE_STORAGE_BINDING = JSON.stringify(worker.binding);
	process.env.PI_BLOBS_DIR = storageBlobsDir(root);
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	await fs.mkdir(cwd);
	const auth = await AuthStorage.create(path.join(root, "auth.db"));
	auth.setRuntimeApiKey("delta-flood", "fixture-key");
	const runtime = await EngineRuntime.create({
		databasePath: path.join(root, "engine.sqlite"),
		streamAdmissionLimits: options.streamAdmissionLimits,
		dispatchPrompt: (session, input) => {
			session.subscribe(event => {
				if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
					published++;
					publishedText += event.assistantMessageEvent.delta;
					if (ends.includes(published)) chunkPublished.resolve();
				}
				if (published === deltas.length || event.type === "agent_end") produced.resolve();
			});
			return session.prompt(input);
		},
		sessionDefaults: {
			cwd,
			agentDir,
			settings: await Settings.loadReadOnly({ cwd, agentDir }),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			modelRegistry: new ModelRegistry(auth, path.join(root, "models.yml")),
			model: buildModel({
				id: "delta-flood",
				name: "Delta flood",
				api: "openai-completions",
				provider: "delta-flood",
				baseUrl: `${server.url}v1`,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 32_000,
				maxTokens: 16_000,
			}),
		},
	});
	const append = runtime.store.appendEvent.bind(runtime.store);
	let updateWrites = 0;
	const store = spyOn(runtime.store, "appendEvent").mockImplementation(async event => {
		if (options.stallAfterFirstUpdate && event.kind === "message_updated" && ++updateWrites > 1)
			await produced.promise;
		return append(event);
	});
	try {
		const started = await runtime.start(
			{
				commandId: "flood-command",
				agentInstanceId: "flood-agent",
				executionId: "flood-execution",
				attemptId: "flood-attempt",
				authorityGeneration: 1,
				cwd,
				input: "long answer",
			},
			{ spawns: "", profileDigest: "flood-profile", enableMCP: false, enableLsp: false },
		);
		await runtime.drain();
		const attempt = await runtime.store.getAttempt(started.attemptId);
		const updates = (await runtime.store.pendingEvents()).filter(
			event =>
				event.attemptId === started.attemptId &&
				event.kind === "message_updated" &&
				event.payload?.stream === "assistant",
		);
		const history = await runtime.sessionHistoryPage(
			started.agentInstanceId,
			"grimoire://tasks/grimoire/flood/agents/flood",
		);
		const answer = history.entries
			.filter(entry => entry.role === "assistant")
			.flatMap(entry => entry.blocks ?? [])
			.filter(block => block.kind === "text")
			.map(block => block.text)
			.join("");
		return { deltas, ends, attempt, updates, answer, publishedText };
	} finally {
		store.mockRestore();
		await runtime.dispose();
		await worker.stop();
		for (const [name, value] of [
			["GRIMOIRE_STORAGE_BINDING", savedEnv.binding],
			["PI_BLOBS_DIR", savedEnv.blobs],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		auth.close();
		server.stop(true);
		await fs.rm(root, { recursive: true, force: true });
	}
}

it.skipIf(!(executable && runRoot))(
	"streams thousands of deltas past stalled storage into few durable updates with the exact text",
	async () => {
		// Three times the stream admission event budget; one durable write per delta cannot keep up.
		const { deltas, attempt, updates, answer } = await runFlood(Array(60).fill(50), { stallAfterFirstUpdate: true });
		expect(attempt?.state, attempt?.cause ?? undefined).toBe("completed");
		// The first delta is durable on its own and at once; the rest are coalesced, not written per delta.
		expect(updates[0]?.payload?.text).toBe(deltas[0]);
		expect(updates.length).toBeLessThan(deltas.length / 100);
		expect(updates.map(event => String(event.payload?.text)).join("")).toBe(deltas.join(""));
		expect(updates.at(-1)?.payload?.status).toBe("settled");
		expect(answer).toBe(deltas.join(""));
	},
	90_000,
);

it.skipIf(!(executable && runRoot))(
	"keeps the text already streamed when stream capacity is exceeded and interrupts the Attempt",
	async () => {
		// The second network chunk crosses the provider event budget part-way through.
		const { deltas, ends, attempt, updates, answer, publishedText } = await runFlood([20, 400], {
			streamAdmissionLimits: { maxProviderEvents: 30 },
		});
		expect(attempt?.state).toBe("interrupted");
		expect(attempt?.cause).toContain("maxProviderEvents");
		// Everything the user already saw survives in history, including text from the chunk that overflowed.
		expect(publishedText.startsWith(deltas.slice(0, ends[0]).join(""))).toBe(true);
		expect(answer.startsWith(publishedText)).toBe(true);
		expect(deltas.join("").startsWith(answer)).toBe(true);
		expect(updates.at(-1)?.payload).toMatchObject({ status: "cancelled" });
	},
	90_000,
);
