import { expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { RocksEngineStore } from "../src/engine/rocks-runtime-store";
import { EngineRuntime, type EngineRuntimeOptions } from "../src/engine/runtime";
import { type RuntimeChange, type RuntimeEventsRequest, runtimeRemainingWork } from "../src/engine/runtime-protocol";
import { parseNativeSessionLocator, RocksNativeSessionStorage } from "../src/session/rocks-native-session-storage";
import { SessionManager } from "../src/session/session-manager";
import * as storage from "../src/session/storage-client";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

it.skipIf(!Bun.env.ARTEL_STORAGE_TEST_BINDING || !Bun.env.ARTEL_STORAGE_TEST_RUN_ROOT)(
	"branches and edits real Rocks history before compaction, across inherited prefixes and restart",
	async () => {
		const root = Bun.env.ARTEL_STORAGE_TEST_RUN_ROOT!;
		const binding = storage.readStorageBinding(Bun.env.ARTEL_STORAGE_TEST_BINDING)!;
		const readBinding = spyOn(storage, "readStorageBinding").mockReturnValue(binding);
		const client = new storage.StorageClient(binding);
		const family = `history-${crypto.randomUUID()}`;
		const sourceStorage = new RocksNativeSessionStorage(client, family, "source");
		const source = SessionManager.createNative(root, sourceStorage);
		source.appendModelChange("mock/past-model");
		const first = source.appendMessage({ role: "user", content: "PAST", timestamp: 1 });
		await source.flushAndCheckpoint();
		for (let n = 0; n < 160; n++) {
			source.appendMessage({ role: "user", content: `archive-${n}`, timestamp: n + 2 });
			if (n % 16 === 15) await source.flush();
		}
		const kept = source.appendMessage({ role: "user", content: "KEPT", timestamp: 200 });
		source.appendCompaction("FUTURE-SUMMARY", undefined, kept, 100);
		source.appendModelChange("mock/future-model");
		const last = source.appendMessage({ role: "user", content: "AFTER", timestamp: 201 });
		await source.flushAndCheckpoint();
		const reads = spyOn(client, "readContext");
		const archive = spyOn(sourceStorage, "readArchive");
		const past = await SessionManager.forkNativeContext(
			sourceStorage,
			new RocksNativeSessionStorage(client, family, "past"),
			root,
			root,
			{ entryId: first, leafEntryId: last },
		);
		expect(JSON.stringify(past.buildSessionContext())).toContain("PAST");
		expect(JSON.stringify(past.buildSessionContext())).not.toContain("FUTURE");
		expect(past.getLeafId()).toBe(first);
		const after = await SessionManager.forkNativeContext(
			sourceStorage,
			new RocksNativeSessionStorage(client, family, "after"),
			root,
			root,
			{ entryId: last, leafEntryId: last },
		);
		expect(JSON.stringify(after.buildSessionContext())).toContain("FUTURE-SUMMARY");
		expect(after.getWorkingEntries().length).toBeLessThan(10);
		expect(reads.mock.calls.length).toBeLessThan(20);
		expect(archive).not.toHaveBeenCalled();
		const nested = await SessionManager.forkNativeContext(
			new RocksNativeSessionStorage(client, family, "after"),
			new RocksNativeSessionStorage(client, family, "nested"),
			root,
			root,
			{ entryId: first, leafEntryId: last, edit: { entryId: first, text: "REPLACEMENT" } },
		);
		expect(nested.getLeafId()).not.toBe(first);
		expect(JSON.stringify(nested.buildSessionContext())).toContain("REPLACEMENT");
		expect(JSON.stringify(nested.buildSessionContext())).not.toContain("FUTURE");
		expect((await SessionManager.openNative(sourceStorage)).getLeafId()).toBe(last);
		await expect(sourceStorage.readContext({ entryId: first, expectedLeafEntryId: "stale" })).rejects.toThrow(
			"leaf changed",
		);
		reads.mockRestore();
		archive.mockRestore();

		registerMockApi("native-history-real");
		const contexts: string[] = [];
		const model = createMockModel({
			handler: context => {
				contexts.push(JSON.stringify(context.messages));
				return { content: [`ANSWER-${contexts.length}`] };
			},
		});
		const auth = createInMemoryAuthStorage();
		auth.setRuntimeApiKey("mock", "test-key");
		const cwd = path.join(root, "workspace");
		await fs.mkdir(cwd, { recursive: true });
		const options: EngineRuntimeOptions = {
			databasePath: path.join(root, "unused.sqlite"),
			sessionDefaults: {
				cwd,
				agentDir: path.join(root, "agent"),
				settings: await Settings.loadReadOnly({
					cwd,
					agentDir: path.join(root, "agent"),
					overrides: { "compaction.enabled": false },
				}),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				modelRegistry: new ModelRegistry(auth),
				model: model.model,
			},
		};
		const profile = { spawns: "", profileDigest: "native-history-real", enableMCP: false, enableLsp: false };
		let runtime = await EngineRuntime.create(options);
		try {
			const id = `engine-history-${crypto.randomUUID()}`;
			const agentInstanceRef = `grimoire://tasks/grimoire/history-test/agents/${id}`;
			const started = await runtime.start(
				{
					commandId: `${id}-start`,
					agentInstanceId: id,
					agentInstanceRef,
					executionId: `${id}-execution`,
					attemptId: `${id}-attempt`,
					authorityGeneration: 1,
					cwd,
					input: "ORIGINAL",
				},
				profile,
			);
			await runtime.drain();
			const history = await runtime.sessionHistoryPage(id, agentInstanceRef);
			const user = history.entries.find(entry => entry.role === "user")!;
			const assistant = history.entries.find(entry => entry.role === "assistant")!;
			const request = {
				commandId: `${id}-branch`,
				agentInstanceId: `${id}-branch`,
				agentInstanceRef: `${agentInstanceRef}-branch`,
				executionId: `${id}-branch-execution`,
				attemptId: `${id}-branch-attempt`,
				authorityGeneration: 1,
				cwd,
				input: "BRANCH",
				historyEdit: {
					mode: "branch" as const,
					source: started,
					sourceSessionId: history.sessionId,
					expectedLeafEntryId: history.anchor!,
					entryId: user.entryId,
				},
			};
			const branch = await runtime.start(request, profile);
			await runtime.drain();
			expect(contexts[1]).toContain("ORIGINAL");
			expect(contexts[1]).not.toContain("ANSWER-1");
			expect((await runtime.sessionHistoryPage(id, agentInstanceRef)).entries.map(entry => entry.text)).toEqual(
				history.entries.map(entry => entry.text),
			);
			expect((await runtime.start(request, profile)).attemptId).toBe(branch.attemptId);
			expect(contexts).toHaveLength(2);
			const edited = await runtime.start(
				{
					...request,
					commandId: `${id}-edit`,
					agentInstanceId: id,
					agentInstanceRef,
					executionId: `${id}-edit-execution`,
					attemptId: `${id}-edit-attempt`,
					input: undefined,
					expectedIntentRevision: started.intentRevision,
					historyEdit: {
						...request.historyEdit,
						mode: "edit",
						entryId: assistant.entryId,
						replacementText: "EDITED",
					},
				},
				profile,
			);
			await runtime.drain();
			expect(contexts[2]).toContain("EDITED");
			expect(contexts[2]).not.toContain("ANSWER-1");
			expect(edited.historyEdit?.replacementEntryId).not.toBe(assistant.entryId);
			// Read the real owner's agent index, including both Attempts of the edited agent.
			const projections = new RocksEngineStore(client);
			for (const attemptId of [started.attemptId, edited.attemptId]) {
				const request: RuntimeEventsRequest = {
					scope: { kind: "attempt", agentInstanceRef, attemptId, kinds: ["state"] },
					principalId: "native-history-test",
					authorizedAgentInstanceRefs: [agentInstanceRef],
					epoch: (await projections.meta()).epoch,
					afterCursor: 0,
					limit: 100,
					maxBytes: 65536,
					timeoutMs: 0,
					remainingWork: runtimeRemainingWork(),
				};
				const changes: RuntimeChange[] = [];
				for (let page = 0; page < 100; page++) {
					const batch = await projections.runtimeEvents(request);
					changes.push(...batch.changes);
					request.afterCursor = batch.throughCursor;
					if (!batch.hasMore) break;
				}
				const states = changes.filter(change => change.kind === "state" && change.value.attemptId != null);
				expect(states.length).toBeGreaterThan(0);
				expect(states.every(change => change.value.attemptId === attemptId)).toBe(true);
				expect(states.at(-1)?.value.state).toBe("completed");
			}
			const oldScope = parseNativeSessionLocator(started.sessionFile!);
			const oldStore = new RocksNativeSessionStorage(client, oldScope.familyId, oldScope.generationId);
			expect(JSON.stringify((await oldStore.readContext()).entries)).toContain("ANSWER-1");
			await runtime.dispose();
			runtime = await EngineRuntime.create(options);
			await runtime.start(
				{
					commandId: `${id}-continue`,
					agentInstanceId: branch.agentInstanceId,
					agentInstanceRef: request.agentInstanceRef,
					attemptId: `${id}-continue-attempt`,
					executionId: `${id}-continue-execution`,
					authorityGeneration: 1,
					expectedIntentRevision: branch.intentRevision,
					cwd,
					input: "CONTINUE",
				},
				profile,
			);
			await runtime.drain();
			expect(contexts[3]).toContain("BRANCH");
			expect(contexts[3]).toContain("ANSWER-2");
			expect(contexts[3]).not.toContain("EDITED");
		} finally {
			await runtime.dispose();
			auth.close();
			readBinding.mockRestore();
		}
	},
	60_000,
);
