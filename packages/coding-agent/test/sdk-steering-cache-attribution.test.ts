import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

function response(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("SDK steering cache attribution", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-sdk-steering-cache-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			authStorage.close();
			tempDir.removeSync();
		}
	});

	it("only retags the wire when the wrapped steering messages change", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const settings = Settings.isolated({
			"advisor.enabled": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const created = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			model,
			settings,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		session = created.session;
		session.agent.streamFn = requestedModel => {
			const stream = new AssistantMessageEventStream();
			const message = response(requestedModel);
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		const firstSteer = { role: "user" as const, content: "first steer", steering: true, timestamp: 1 };
		session.agent.state.messages.push(firstSteer, {
			role: "user",
			content: "second steer",
			steering: true,
			timestamp: 2,
		});

		await session.prompt("first request");
		expect(session.cacheMutationLedger.consume()).toEqual(["steering-wrap"]);

		session.agent.state.messages.push({ role: "user", content: "ordinary context", timestamp: 3 }, response(model));
		await session.prompt("ordinary append request");
		expect(session.cacheMutationLedger.consume()).toEqual([]);

		firstSteer.content = "changed first steer";
		await session.prompt("changed steering request");
		expect(session.cacheMutationLedger.consume()).toEqual(["steering-wrap"]);

		for (let index = session.agent.state.messages.length - 1; index >= 0; index--) {
			const message = session.agent.state.messages[index];
			if (message?.role === "user" && message.steering === true) {
				session.agent.state.messages.splice(index, 1);
			}
		}
		await session.prompt("steering absent request");
		expect(session.cacheMutationLedger.consume()).toEqual([]);

		session.agent.state.messages.push(
			{ role: "user", content: "changed first steer", steering: true, timestamp: 1 },
			{ role: "user", content: "second steer", steering: true, timestamp: 2 },
		);
		await session.prompt("restored steering request");
		expect(session.cacheMutationLedger.consume()).toEqual(["steering-wrap"]);
	});

	it("keeps the main cache ledger unchanged through advisor and capture side hooks", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const settings = Settings.isolated({
			"advisor.enabled": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const created = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			model,
			settings,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		session = created.session;
		const ledger = session.cacheMutationLedger;
		const mainIdentity = `${model.provider}/${model.id}:main`;

		ledger.recordMainProviderToolSignature(mainIdentity, "system-and-tools:A");
		expect(ledger.consume()).toEqual([]);
		ledger.queueForNextProviderRequest("shake");

		// Advisor and auto-learn capture both use these session-side hooks.
		await session.convertMessagesToLlm([{ role: "user", content: "capture input", timestamp: 1 }]);
		await session
			.prepareSimpleStreamOptions({})
			.onPayload?.({ system: "advisor system", tools: [{ name: "advisor-tool" }] }, model);
		expect(ledger.tags).toEqual([]);

		ledger.recordMainProviderToolSignature(mainIdentity, "system-and-tools:A");
		ledger.recordQueuedMutationsAtMainProviderBoundary();
		expect(ledger.consume()).toEqual(["shake"]);
	});

	it("only retags image stripping when emitted placeholders change", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const settings = Settings.isolated({
			"advisor.enabled": false,
			"compaction.enabled": false,
			"images.blockImages": true,
			"retry.enabled": false,
			"todo.enabled": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const created = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			model,
			settings,
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		session = created.session;
		session.agent.streamFn = requestedModel => {
			const stream = new AssistantMessageEventStream();
			const message = response(requestedModel);
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};

		session.agent.state.messages.push({
			role: "user",
			content: [{ type: "image", data: "first", mimeType: "image/png" }],
			timestamp: 1,
		});
		await session.prompt("first request");
		expect(session.cacheMutationLedger.consume()).toEqual(["image-strip"]);

		await session.prompt("ordinary context growth");
		expect(session.cacheMutationLedger.consume()).toEqual([]);

		for (const message of session.agent.state.messages) {
			if (message.role !== "user" || !Array.isArray(message.content)) continue;
			for (const part of message.content) {
				if (part.type === "image") part.data = "changed-but-still-omitted";
			}
		}
		await session.prompt("same placeholder bytes");
		expect(session.cacheMutationLedger.consume()).toEqual([]);

		for (const message of session.agent.state.messages) {
			if (message.role !== "user" || !Array.isArray(message.content)) continue;
			message.content = message.content.filter(part => part.type !== "image");
		}
		await session.prompt("image removed");
		expect(session.cacheMutationLedger.consume()).toEqual([]);

		session.agent.state.messages.push({
			role: "user",
			content: [{ type: "image", data: "restored", mimeType: "image/png" }],
			timestamp: 2,
		});
		await session.prompt("image restored");
		expect(session.cacheMutationLedger.consume()).toEqual(["image-strip"]);
	});
});
