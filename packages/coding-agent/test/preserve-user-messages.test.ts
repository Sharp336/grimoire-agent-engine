import { afterEach, describe, expect, it } from "bun:test";
import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { Message, Model, UserMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, wrapSteeringForModel } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
	applyPreservedUserMessageOverlay,
	findLatestResetBoundaryIdx,
	PIN_MARKER_CUSTOM_TYPE,
	PRESERVED_USER_MESSAGES_PRESERVE_KEY,
	pruneLongUserMessage,
	readPreservedUserMessagesStore,
	resolvePreservedUserMessageContextTokens,
	resolvePreservedUserMessagePolicy,
	selectPreservedUserMessages,
	writePreservedUserMessagesStore,
} from "@oh-my-pi/pi-coding-agent/session/preserve-user-messages";
import type { CompactionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

registerMockApi("preserved-user-message-overlay-test");

const disposals: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (disposals.length > 0) await disposals.pop()?.();
});

function policy(filter: "all" | "heuristic" | "llm" | "pinned" = "all") {
	const settings = Settings.isolated({
		"compaction.keepUserMessages": true,
		"compaction.keepUserMessagesFilter": filter,
	});
	const resolved = resolvePreservedUserMessagePolicy(settings.getGroup("compaction"), new Tokenizer());
	if (!resolved) throw new Error("Expected enabled preservation policy");
	return resolved;
}

function openAiResponsesModel(): Model {
	const model = getBundledModel("openai", "gpt-5");
	if (!model) throw new Error("Expected bundled OpenAI Responses model");
	return model;
}

function providerContext(
	activeModel: Model | undefined = undefined,
	normalizeSourceUserMessage: (message: UserMessage) => Message | undefined = message =>
		convertToLlm([message]).find(converted => converted.role === "user"),
) {
	return {
		activeModel,
		compactionSettings: Settings.isolated().getGroup("compaction"),
		normalizeSourceUserMessage,
	};
}

function userText(message: { content: string | Array<{ type: string; text?: string }> } | undefined): string {
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap(block => (block.type === "text" && block.text ? [block.text] : [])).join("");
}

function compactedManager(
	preserveData?: Record<string, unknown>,
	foldedContent: UserMessage["content"] = "keep this exact folded instruction",
) {
	const manager = SessionManager.inMemory();
	const foldedId = manager.appendMessage({
		role: "user",
		content: foldedContent,
		providerPayload: { type: "openaiResponsesHistory", provider: "mock", items: [{ type: "opaque" }] },
		timestamp: 1,
	});
	manager.appendMessage({
		role: "assistant",
		content: [],
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	});
	const keptId = manager.appendMessage({ role: "user", content: "kept tail", timestamp: 3 });
	const compactionId = manager.appendCompaction("summary", "short", keptId, 1_000, {
		method: "soft",
		preserveData,
	});
	const compaction = manager.getEntry(compactionId) as CompactionEntry;
	return { manager, foldedId, keptId, compaction };
}

describe("preserved user-message provider overlay", () => {
	it("injects only transient copies after the exact compaction summary", () => {
		const { manager, foldedId } = compactedManager();
		const baseline = manager.buildSessionContext().messages;
		const transformed = applyPreservedUserMessageOverlay(baseline, manager.getBranch(), policy(), providerContext());

		expect(baseline.map(message => message.role)).toEqual(["compactionSummary", "user"]);
		expect(transformed.map(message => message.role)).toEqual(["compactionSummary", "user", "user"]);
		expect(transformed[1]).toMatchObject({ role: "user", content: "keep this exact folded instruction" });
		expect(transformed[1]).not.toBe((manager.getEntry(foldedId) as { message?: unknown })?.message);
		if (transformed[1]?.role !== "user") throw new Error("Expected transient user overlay");
		expect(transformed[1].providerPayload).toBeUndefined();

		const deobfuscatedSummary = { ...baseline[0], summary: "deobfuscated summary", shortSummary: "deobfuscated" };
		expect(
			applyPreservedUserMessageOverlay([deobfuscatedSummary], manager.getBranch(), policy(), providerContext()).map(
				message => message.role,
			),
		).toEqual(["compactionSummary", "user"]);

		const staleSummary = { ...baseline[0], timestamp: baseline[0]!.timestamp + 1 };
		expect(
			applyPreservedUserMessageOverlay([staleSummary], manager.getBranch(), policy(), providerContext()),
		).toEqual([staleSummary]);
	});

	it("keeps reusable native history authoritative and suppresses a duplicate overlay", () => {
		const preserveData = {
			openaiRemoteCompaction: {
				provider: "openai",
				replacementHistory: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "keep this exact folded instruction" }],
					},
					{ type: "message", role: "user", content: [{ type: "input_text", text: "native kept tail" }] },
					{ type: "message", role: "developer", content: [{ type: "input_text", text: "retain developer" }] },
					{ type: "compaction", encrypted_content: "opaque" },
				],
				compactionItem: { type: "compaction", encrypted_content: "opaque" },
			},
		};
		const { manager } = compactedManager(preserveData);
		const transformed = applyPreservedUserMessageOverlay(
			manager.buildSessionContext().messages,
			manager.getBranch(),
			policy(),
			providerContext(openAiResponsesModel()),
		);
		const summary = transformed[0];
		if (summary?.role !== "compactionSummary") throw new Error("Expected compaction summary");
		expect(summary.providerPayload?.items).toEqual(preserveData.openaiRemoteCompaction.replacementHistory);
		expect(transformed.filter(message => message.role === "user")).toHaveLength(0);
	});

	it("deduplicates a truncated selection using its normalized original content", () => {
		const fullText = `HEAD ${"middle ".repeat(200)}TAIL`;
		const compactionItem = { type: "compaction", encrypted_content: "opaque" };
		const preserveData = {
			openaiRemoteCompaction: {
				provider: "openai",
				replacementHistory: [
					{ type: "message", role: "user", content: [{ type: "input_text", text: fullText }] },
					compactionItem,
				],
				compactionItem,
			},
		};
		const { manager } = compactedManager(preserveData, fullText);
		const pruningPolicy = {
			...policy(),
			pruneLongUserMessages: "head-only" as const,
			maxTokensPerUserMessage: 20,
		};
		const transformed = applyPreservedUserMessageOverlay(
			manager.buildSessionContext().messages,
			manager.getBranch(),
			pruningPolicy,
			providerContext(openAiResponsesModel()),
		);
		expect(transformed.filter(message => message.role === "user")).toHaveLength(0);
		const compaction = manager.getBranch().findLast(entry => entry.type === "compaction");
		if (compaction?.type !== "compaction") throw new Error("Expected compaction");
		const selection = selectPreservedUserMessages(manager.getBranch(), compaction, pruningPolicy);
		expect(selection.sourceTokenCount).toBeGreaterThan(selection.tokenCount);
		expect(
			resolvePreservedUserMessageContextTokens(
				selection,
				compaction,
				openAiResponsesModel(),
				Settings.isolated().getGroup("compaction"),
			),
		).toBe(selection.sourceTokenCount);
	});

	it("sums per-message remote maxima for mixed retained-source and added-overlay costs", () => {
		const manager = SessionManager.inMemory();
		const sourceHeavyText = `HEAD ${"source-heavy ".repeat(300)}TAIL`;
		manager.appendMessage({ role: "user", content: sourceHeavyText, timestamp: 1 });
		manager.appendMessage({ role: "user", content: "steer", steering: true, timestamp: 2 });
		const keptId = manager.appendMessage({ role: "user", content: "kept", timestamp: 3 });
		const compactionItem = { type: "compaction", encrypted_content: "opaque" };
		const preserveData = {
			openaiRemoteCompaction: {
				provider: "openai",
				replacementHistory: [
					{ type: "message", role: "user", content: [{ type: "input_text", text: sourceHeavyText }] },
					compactionItem,
				],
				compactionItem,
			},
		};
		const compactionId = manager.appendCompaction("summary", undefined, keptId, 100, { preserveData });
		const compaction = manager.getEntry(compactionId) as CompactionEntry;
		const pruningPolicy = {
			...policy(),
			pruneLongUserMessages: "head-only" as const,
			maxTokensPerUserMessage: 20,
		};
		const selection = selectPreservedUserMessages(manager.getBranch(), compaction, pruningPolicy);

		expect(selection.remoteTokenCount).toBeGreaterThan(selection.tokenCount);
		expect(selection.remoteTokenCount).toBeGreaterThan(selection.sourceTokenCount);
		expect(
			resolvePreservedUserMessageContextTokens(
				selection,
				compaction,
				openAiResponsesModel(),
				Settings.isolated().getGroup("compaction"),
			),
		).toBe(selection.remoteTokenCount);
	});

	it("deduplicates a secret-bearing source after outbound obfuscation", () => {
		const compactionItem = { type: "compaction", encrypted_content: "opaque" };
		const preserveData = {
			openaiRemoteCompaction: {
				provider: "openai",
				replacementHistory: [
					{ type: "message", role: "user", content: [{ type: "input_text", text: "token [secret]" }] },
					compactionItem,
				],
				compactionItem,
			},
		};
		const { manager } = compactedManager(preserveData, "token SECRET");
		const transformed = applyPreservedUserMessageOverlay(
			manager.buildSessionContext().messages,
			manager.getBranch(),
			policy(),
			providerContext(openAiResponsesModel(), source => {
				const normalized = convertToLlm([source]).find(message => message.role === "user");
				return normalized
					? { ...normalized, content: userText(normalized).replace("SECRET", "[secret]") }
					: undefined;
			}),
		);
		expect(transformed.filter(message => message.role === "user")).toHaveLength(0);
	});

	it("deduplicates steering and images with plain remote-input normalization", () => {
		const compactionItem = { type: "compaction", encrypted_content: "opaque" };
		const preserveData = {
			openaiRemoteCompaction: {
				provider: "openai",
				replacementHistory: [
					{
						type: "message",
						role: "user",
						content: [
							{ type: "input_text", text: "raw steer" },
							{ type: "input_image", image_url: "data:image/png;base64,aW1hZ2U=" },
						],
					},
					compactionItem,
				],
				compactionItem,
			},
		};
		const { manager, foldedId } = compactedManager(preserveData, [
			{ type: "text", text: "raw steer" },
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
		]);
		const folded = manager.getEntry(foldedId);
		if (folded?.type !== "message" || folded.message.role !== "user") throw new Error("Expected folded user");
		folded.message.steering = true;
		const transformed = applyPreservedUserMessageOverlay(
			manager.buildSessionContext().messages,
			manager.getBranch(),
			policy(),
			providerContext(openAiResponsesModel()),
		);
		expect(transformed.filter(message => message.role === "user")).toHaveLength(0);
	});

	it("does not deduplicate for a same-provider model that cannot reuse Responses history", () => {
		const compactionItem = { type: "compaction", encrypted_content: "opaque" };
		const preserveData = {
			openaiRemoteCompaction: {
				provider: "same-provider",
				replacementHistory: [
					{
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "keep this exact folded instruction" }],
					},
					compactionItem,
				],
				compactionItem,
			},
		};
		const nonResponsesModel: Model = {
			...openAiResponsesModel(),
			provider: "same-provider",
			api: "openai-completions",
		};
		const { manager } = compactedManager(preserveData);
		const transformed = applyPreservedUserMessageOverlay(
			manager.buildSessionContext().messages,
			manager.getBranch(),
			policy(),
			providerContext(nonResponsesModel),
		);
		expect(transformed.filter(message => message.role === "user")).toHaveLength(1);
	});

	it("uses a namespaced LLM verdict and sizes an unclassified prospective cut conservatively", () => {
		const manager = SessionManager.inMemory();
		const firstId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const secondId = manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
		const keptId = manager.appendMessage({ role: "user", content: "kept", timestamp: 3 });
		const stored = writePreservedUserMessagesStore(undefined, {
			version: 1,
			preservedIds: [secondId],
			classifiedIds: [firstId, secondId],
		});
		const compactionId = manager.appendCompaction("summary", undefined, keptId, 100, { preserveData: stored });
		const compaction = manager.getEntry(compactionId) as CompactionEntry;

		const selected = selectPreservedUserMessages(manager.getBranch(), compaction, policy("llm"));
		expect([...selected.selectedIds]).toEqual([secondId]);
		expect(compaction.preserveData?.[PRESERVED_USER_MESSAGES_PRESERVE_KEY]).toMatchObject({ version: 1 });
		expect(
			readPreservedUserMessagesStore({
				preservedUserMessageIds: [secondId],
				classifiedUserMessageIds: [firstId, secondId],
			}),
		).toEqual({ version: 1, preservedIds: [secondId], classifiedIds: [firstId, secondId] });

		const prospective = selectPreservedUserMessages(
			manager.getBranch().slice(0, -1),
			{ firstKeptEntryId: keptId, preserveData: undefined },
			policy("llm"),
			{ prospective: true },
		);
		expect([...prospective.selectedIds]).toEqual([firstId, secondId]);
	});

	it("filters real post-reset users under heuristic, pinned, and all policies", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "pre-reset instruction", timestamp: 1 });
		manager.appendResetBoundary();
		const acknowledgmentId = manager.appendMessage({ role: "user", content: "ok", timestamp: 2 });
		const directiveId = manager.appendMessage({ role: "user", content: "always keep exact paths", timestamp: 3 });
		manager.appendMessage({ role: "user", content: "synthetic", synthetic: true, timestamp: 4 });
		manager.appendMessage({ role: "user", content: "agent injection", attribution: "agent", timestamp: 5 });
		manager.appendCustomEntry(PIN_MARKER_CUSTOM_TYPE, { messageId: directiveId, pinned: true });
		const keptId = manager.appendMessage({ role: "user", content: "kept", timestamp: 6 });
		const boundary = { firstKeptEntryId: keptId };

		expect(findLatestResetBoundaryIdx(manager.getBranch())).toBeGreaterThan(0);
		expect([...selectPreservedUserMessages(manager.getBranch(), boundary, policy("heuristic")).selectedIds]).toEqual([
			directiveId,
		]);
		expect([...selectPreservedUserMessages(manager.getBranch(), boundary, policy("pinned")).selectedIds]).toEqual([
			directiveId,
		]);
		expect([...selectPreservedUserMessages(manager.getBranch(), boundary, policy("all")).selectedIds]).toEqual([
			acknowledgmentId,
			directiveId,
		]);
	});

	it("keeps overlapping edges once and moves the last window as folded history grows", () => {
		const manager = SessionManager.inMemory();
		const firstId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const secondId = manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
		const firstKeptId = manager.appendMessage({ role: "user", content: "first kept", timestamp: 3 });
		const compactionId = manager.appendCompaction("summary", undefined, firstKeptId, 100);
		const edgePolicy = { ...policy("all"), keepFirstNMessages: 2, keepLastNMessages: 2 };
		const initial = selectPreservedUserMessages(
			manager.getBranch(),
			manager.getEntry(compactionId) as CompactionEntry,
			edgePolicy,
		);
		expect([...initial.selectedIds]).toEqual([firstId, secondId]);

		const laterId = manager.appendMessage({ role: "user", content: "later one", timestamp: 4 });
		const latestId = manager.appendMessage({ role: "user", content: "later two", timestamp: 5 });
		const latestKeptId = manager.appendMessage({ role: "user", content: "latest kept", timestamp: 6 });
		const grown = selectPreservedUserMessages(manager.getBranch(), { firstKeptEntryId: latestKeptId }, edgePolicy, {
			prospective: true,
		});
		expect([...grown.selectedIds]).toEqual([firstId, secondId, laterId, latestId]);
	});

	it("implements each long-message mode and excludes before applying the window", () => {
		const tokenizer = new Tokenizer();
		const long = { role: "user" as const, content: `HEAD ${"middle ".repeat(200)}TAIL`, timestamp: 1 };
		const middle = pruneLongUserMessage(long, "middle-out", 40, tokenizer);
		const head = pruneLongUserMessage(long, "head-only", 40, tokenizer);
		const tail = pruneLongUserMessage(long, "tail-only", 40, tokenizer);
		expect(userText(middle)).toStartWith("HEAD");
		expect(userText(middle)).toEndWith("TAIL");
		expect(userText(head)).toStartWith("HEAD");
		expect(userText(head)).not.toEndWith("TAIL");
		expect(userText(tail)).not.toStartWith("HEAD");
		expect(userText(tail)).toEndWith("TAIL");

		const manager = SessionManager.inMemory();
		manager.appendMessage(long);
		const shortId = manager.appendMessage({ role: "user", content: "short instruction", timestamp: 2 });
		const keptId = manager.appendMessage({ role: "user", content: "kept", timestamp: 3 });
		const selected = selectPreservedUserMessages(
			manager.getBranch(),
			{ firstKeptEntryId: keptId },
			{
				...policy("all"),
				keepFirstNMessages: 1,
				pruneLongUserMessages: "exclude",
				maxTokensPerUserMessage: 40,
			},
			{ prospective: true },
		);
		expect([...selected.selectedIds]).toEqual([shortId]);
	});

	it("reports the exact transformed token cost and fails closed on a missing kept boundary", () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "historical steer", steering: true, timestamp: 1 });
		const keptId = manager.appendMessage({ role: "user", content: "kept", timestamp: 2 });
		const selected = selectPreservedUserMessages(manager.getBranch(), { firstKeptEntryId: keptId }, policy("all"), {
			prospective: true,
		});
		expect(selected.tokenCount).toBe(new Tokenizer().countMessages(wrapSteeringForModel(selected.messages)));
		expect(selected.tokenCount).toBeGreaterThan(new Tokenizer().countMessages(selected.messages));
		expect(
			selectPreservedUserMessages(
				manager.getBranch(),
				{ id: "missing-compaction", firstKeptEntryId: "missing-kept" },
				policy("all"),
			).messages,
		).toEqual([]);
	});

	it("runs on the primary SDK provider transform without entering Agent state", async () => {
		const tempDir = TempDir.createSync("@pi-preserved-user-overlay-");
		const authStorage = await AuthStorage.create(":memory:");
		const modelRegistry = new ModelRegistry(authStorage);
		const mock = createMockModel({ responses: [{ content: ["done"] }] });
		authStorage.setRuntimeApiKey("mock", "test-key");
		const { manager } = compactedManager();
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"compaction.keepUserMessages": true,
			"compaction.keepUserMessagesFilter": "all",
			"retry.enabled": false,
			"todo.enabled": false,
		});
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry,
			model: mock,
			getApiKey: () => "test-key",
			sessionManager: manager,
			settings,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: [],
		});
		disposals.push(async () => {
			await session.dispose();
			authStorage.close();
			await tempDir.remove();
		});

		expect(JSON.stringify(session.agent.state.messages)).not.toContain("exact folded instruction");
		await session.prompt("current request");
		expect(JSON.stringify(mock.calls[0]?.context.messages)).toContain("keep this exact folded instruction");
		expect(JSON.stringify(session.agent.state.messages)).not.toContain("exact folded instruction");
	});
});
