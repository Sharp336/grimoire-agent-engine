import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	registerPersistedConsultation,
	registerPersistedSubagents,
	retryPersistedConsultationTitle,
} from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import {
	CONSULTATION_THREAD_CUSTOM_TYPE,
	CONSULTATION_TITLE_CUSTOM_TYPE,
	CONSULTATION_TITLE_STATE_CUSTOM_TYPE,
	CONSULTATION_TURN_CUSTOM_TYPE,
	consultationThreadMetadata,
	consultationThreadTitle,
	consultationThreadTitleState,
	consultationTurnStates,
	lookupConsultationThread,
	replayCompletedConsultationMessages,
} from "@oh-my-pi/pi-coding-agent/session/consultation";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { TempDir } from "@oh-my-pi/pi-utils";

const timestamp = "2026-07-20T00:00:00.000Z";

function sessionContent(id: string, entries: unknown[]): string {
	return [
		JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: "/tmp" }),
		...entries.map(entry => JSON.stringify(entry)),
	].join("\n");
}

function thread(consultationId: string) {
	return {
		type: "custom",
		id: `thread-${consultationId}`,
		parentId: null,
		timestamp,
		customType: CONSULTATION_THREAD_CUSTOM_TYPE,
		data: {
			version: 1,
			consultationId,
			parentSessionId: "parent",
			parentLeafId: "leaf",
			createdAt: 1,
		},
	};
}

function title(consultationId: string, value: string) {
	return {
		type: "custom",
		id: `title-${consultationId}`,
		parentId: null,
		timestamp,
		customType: CONSULTATION_TITLE_CUSTOM_TYPE,
		data: {
			source: "canonical",
			version: 1,
			consultationId,
			title: value,
			createdAt: 1,
		},
	};
}

function titleState(consultationId: string, status: "pending" | "failed", error?: string) {
	return {
		type: "custom",
		id: `title-state-${consultationId}-${status}`,
		parentId: null,
		timestamp,
		customType: CONSULTATION_TITLE_STATE_CUSTOM_TYPE,
		data: {
			version: 1,
			consultationId,
			status,
			attemptedAt: 1,
			...(error ? { error } : {}),
		},
	};
}

function turn(
	consultationId: string,
	turnId: string,
	turnIndex: number,
	status: "running" | "completed" | "failed" | "cancelled",
) {
	return {
		type: "custom",
		id: `${turnId}-${status}`,
		parentId: null,
		timestamp,
		customType: CONSULTATION_TURN_CUSTOM_TYPE,
		data: {
			version: 1,
			consultationId,
			turnId,
			turnIndex,
			question: `question ${turnIndex}`,
			promptText: `prompt ${turnIndex}`,
			provider: "provider",
			model: "model",
			status,
			startedAt: turnIndex,
			...(status === "running" ? {} : { finishedAt: turnIndex + 1 }),
		},
	};
}

function message(id: string, role: "user" | "assistant", text: string) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: { role, content: [{ type: "text", text }], timestamp },
	};
}

describe("persisted consultation discovery", () => {
	it("discovers each valid root and nested thread once with state from its latest turn", async () => {
		using temp = TempDir.createSync("@omp-consult-discovery-");
		const parentFile = path.join(temp.path(), "parent.jsonl");
		const artifacts = parentFile.slice(0, -6);
		await fs.mkdir(path.join(artifacts, "Sub"), { recursive: true });
		await Bun.write(parentFile, sessionContent("parent", []));
		await Bun.write(
			path.join(artifacts, "__consult.root.jsonl"),
			sessionContent("root", [
				thread("root"),
				turn("root", "one", 0, "running"),
				turn("root", "one", 0, "completed"),
				turn("root", "two", 1, "running"),
			]),
		);
		await Bun.write(path.join(artifacts, "Sub.jsonl"), sessionContent("Sub", []));
		await Bun.write(
			path.join(artifacts, "Sub", "__consult.nested.jsonl"),
			sessionContent("nested", [
				thread("nested"),
				turn("nested", "one", 0, "running"),
				turn("nested", "one", 0, "completed"),
			]),
		);

		const registry = new AgentRegistry();
		await registerPersistedSubagents(registry, parentFile);
		expect(registry.get("Main/consult:root")).toMatchObject({
			kind: "consultation",
			status: "parked",
			parentId: "Main",
		});
		expect(registry.get("Sub/consult:nested")).toMatchObject({
			kind: "consultation",
			status: "parked",
			parentId: "Sub",
		});
		expect(registry.list().filter(ref => ref.kind === "consultation")).toHaveLength(2);

		const restarted = new AgentRegistry();
		await registerPersistedSubagents(restarted, parentFile);
		expect(restarted.get("Main/consult:root")?.sessionFile).toBe(path.join(artifacts, "__consult.root.jsonl"));
		expect(restarted.get("Sub/consult:nested")?.sessionFile).toBe(
			path.join(artifacts, "Sub", "__consult.nested.jsonl"),
		);
	});

	it("does not cancel a registered live consultation during Agent Hub discovery", async () => {
		using temp = TempDir.createSync("@omp-consult-live-hub-discovery-");
		const parentFile = path.join(temp.path(), "parent.jsonl");
		const artifacts = parentFile.slice(0, -6);
		const consultationId = "live";
		const consultationFile = path.join(artifacts, `__consult.${consultationId}.jsonl`);
		const contents = sessionContent(consultationId, [
			thread(consultationId),
			turn(consultationId, "live-turn", 0, "running"),
		]);
		await fs.mkdir(artifacts, { recursive: true });
		await Bun.write(parentFile, sessionContent("parent", []));
		await Bun.write(consultationFile, contents);

		const registry = new AgentRegistry();
		registry.register({
			id: `Main/consult:${consultationId}`,
			displayName: `consult:${consultationId}`,
			kind: "consultation",
			parentId: "Main",
			session: null,
			sessionFile: consultationFile,
			status: "running",
		});

		await registerPersistedSubagents(registry, parentFile);

		expect(registry.get(`Main/consult:${consultationId}`)).toMatchObject({ status: "running" });
		expect(await Bun.file(consultationFile).text()).toBe(contents);
	});

	it("keeps a live consultation running when its async title completes", async () => {
		using temp = TempDir.createSync("@omp-consult-live-title-");
		const parentFile = path.join(temp.path(), "parent.jsonl");
		const artifacts = parentFile.slice(0, -6);
		const consultationId = "live-title";
		const consultationFile = path.join(artifacts, `__consult.${consultationId}.jsonl`);
		await fs.mkdir(artifacts, { recursive: true });
		await Bun.write(parentFile, sessionContent("parent", []));
		await Bun.write(
			consultationFile,
			sessionContent(consultationId, [
				thread(consultationId),
				turn(consultationId, "first-turn", 0, "running"),
				message("first-answer", "assistant", "completed answer"),
				turn(consultationId, "first-turn", 0, "completed"),
				turn(consultationId, "follow-up", 1, "running"),
			]),
		);

		const registry = new AgentRegistry();
		registerPersistedConsultation(registry, {
			ownerId: "Main",
			consultationId,
			sessionFile: consultationFile,
		});
		const session = {
			generateConsultationTitle: vi.fn(async () => "Generated while live"),
		} as unknown as Parameters<typeof retryPersistedConsultationTitle>[1]["session"];

		await retryPersistedConsultationTitle(registry, {
			ownerId: "Main",
			consultationId,
			sessionFile: consultationFile,
			session,
		});

		expect(registry.get(`Main/consult:${consultationId}`)).toMatchObject({
			displayName: "Generated while live · consult:ve-title",
			status: "running",
		});
		const titledContents = await Bun.file(consultationFile).text();
		await registerPersistedSubagents(registry, parentFile);
		expect(registry.get(`Main/consult:${consultationId}`)?.status).toBe("running");
		expect(await Bun.file(consultationFile).text()).toBe(titledContents);
	});

	it("cancels unmatched running consultations during process recovery exactly once", async () => {
		using temp = TempDir.createSync("@omp-consult-recovery-");
		const parentFile = path.join(temp.path(), "parent.jsonl");
		const artifacts = parentFile.slice(0, -6);
		const consultationId = "interrupted";
		const consultationFile = path.join(artifacts, `__consult.${consultationId}.jsonl`);
		await fs.mkdir(artifacts, { recursive: true });
		await Bun.write(parentFile, sessionContent("parent", []));
		await Bun.write(
			consultationFile,
			sessionContent(consultationId, [
				thread(consultationId),
				turn(consultationId, "interrupted-turn", 0, "running"),
			]),
		);

		await registerPersistedSubagents(new AgentRegistry(), parentFile);
		const recovered = await Bun.file(consultationFile).text();
		const recoveredEntries = parseSessionEntries(recovered);
		expect(consultationTurnStates(recoveredEntries, consultationId).map(state => state.terminal?.status)).toEqual([
			"cancelled",
		]);
		expect(recovered).toContain("[Consultation interrupted by process exit.]");

		await registerPersistedSubagents(new AgentRegistry(), parentFile);
		expect(await Bun.file(consultationFile).text()).toBe(recovered);
	});

	it("retains the persisted title and short id after cold registry discovery", async () => {
		using temp = TempDir.createSync("@omp-consult-title-");
		const parentFile = path.join(temp.path(), "parent.jsonl");
		const artifacts = parentFile.slice(0, -6);
		const consultationId = "explicit-title";
		await fs.mkdir(artifacts, { recursive: true });
		await Bun.write(parentFile, sessionContent("parent", []));
		await Bun.write(
			path.join(artifacts, `__consult.${consultationId}.jsonl`),
			sessionContent(consultationId, [
				thread(consultationId),
				title(consultationId, "Durable cache boundary"),
				turn(consultationId, "first", 0, "completed"),
			]),
		);

		const registry = new AgentRegistry();
		await registerPersistedSubagents(registry, parentFile);

		expect(registry.get(`Main/consult:${consultationId}`)).toMatchObject({
			displayName: "Durable cache boundary · consult:it-title",
			status: "parked",
		});
		const restarted = new AgentRegistry();
		await registerPersistedSubagents(restarted, parentFile);
		expect(restarted.get(`Main/consult:${consultationId}`)).toMatchObject({
			displayName: "Durable cache boundary · consult:it-title",
			status: "parked",
		});
	});

	it("does not register a filename whose immutable thread identity collides", async () => {
		using temp = TempDir.createSync("@omp-consult-collision-");
		const parentFile = path.join(temp.path(), "parent.jsonl");
		const artifacts = parentFile.slice(0, -6);
		await fs.mkdir(artifacts, { recursive: true });
		await Bun.write(parentFile, sessionContent("parent", []));
		await Bun.write(path.join(artifacts, "__consult.named.jsonl"), sessionContent("named", [thread("foreign")]));

		const registry = new AgentRegistry();
		await registerPersistedSubagents(registry, parentFile);
		expect(registry.get("Main/consult:named")).toBeUndefined();
		expect(registry.get("Main/consult:foreign")).toBeUndefined();
		expect(registry.list()).toEqual([]);
	});

	it("keeps a parked subagent whose name resembles a consultation transcript", async () => {
		using temp = TempDir.createSync("@omp-consult-reserved-name-");
		const parentFile = path.join(temp.path(), "parent.jsonl");
		const artifacts = parentFile.slice(0, -6);
		await fs.mkdir(artifacts, { recursive: true });
		await Bun.write(parentFile, sessionContent("parent", []));
		await Bun.write(path.join(artifacts, "__consult.named.jsonl"), sessionContent("__consult.named", []));

		const registry = new AgentRegistry();
		await registerPersistedSubagents(registry, parentFile);

		expect(registry.get("__consult.named")).toMatchObject({
			displayName: "__consult.named",
			kind: "sub",
			parentId: "Main",
			status: "parked",
		});
		expect(registry.get("Main/consult:named")).toBeUndefined();
	});

	it("keeps a copied legacy question as fallback display while its failed canonical title remains retryable", async () => {
		using temp = TempDir.createSync("@omp-consult-legacy-title-");
		const parentFile = path.join(temp.path(), "parent.jsonl");
		const artifacts = parentFile.slice(0, -6);
		const consultationId = "legacy-question";
		const sessionFile = path.join(artifacts, `__consult.${consultationId}.jsonl`);
		await fs.mkdir(artifacts, { recursive: true });
		await Bun.write(parentFile, sessionContent("parent", []));
		await Bun.write(
			sessionFile,
			sessionContent(consultationId, [
				thread(consultationId),
				{
					type: "custom",
					id: "legacy-copied-title",
					parentId: null,
					timestamp,
					customType: CONSULTATION_TITLE_CUSTOM_TYPE,
					data: {
						version: 1,
						consultationId,
						title: "question 0",
						createdAt: 1,
					},
				},
				titleState(consultationId, "failed", "title provider unavailable"),
				turn(consultationId, "first", 0, "completed"),
			]),
		);

		const registry = new AgentRegistry();
		await registerPersistedSubagents(registry, parentFile);
		expect(registry.get(`Main/consult:${consultationId}`)).toMatchObject({
			displayName: expect.stringMatching(/^question 0 · consult:/),
			status: "parked",
		});

		const entries = parseSessionEntries(await Bun.file(sessionFile).text());
		expect(consultationThreadTitle(entries, consultationId)).toBeUndefined();
		expect(consultationThreadTitleState(entries, consultationId)).toEqual({
			version: 1,
			consultationId,
			status: "failed",
			attemptedAt: 1,
			error: "title provider unavailable",
		});
	});

	it("refreshes stale files without clobbering a non-consultation collision", () => {
		const registry = new AgentRegistry();
		registerPersistedConsultation(registry, { ownerId: "Main", consultationId: "one", sessionFile: "/old" });
		registerPersistedConsultation(registry, { ownerId: "Main", consultationId: "one", sessionFile: "/new" });
		expect(registry.get("Main/consult:one")?.sessionFile).toBe("/new");
		registry.register({
			id: "Main/consult:collision",
			displayName: "real agent",
			kind: "sub",
			session: null,
			status: "parked",
		});
		registerPersistedConsultation(registry, {
			ownerId: "Main",
			consultationId: "collision",
			sessionFile: "/consult",
		});
		expect(registry.get("Main/consult:collision")).toMatchObject({ kind: "sub", displayName: "real agent" });
	});
	it("restores collision-safe consultation choices with latest turn state after restart", async () => {
		using temp = TempDir.createSync("@omp-consult-picker-");
		const parentFile = path.join(temp.path(), "parent.jsonl");
		const artifacts = parentFile.slice(0, -6);
		const firstId = "abcdef0one";
		const secondId = "abcdef0two";
		await fs.mkdir(artifacts, { recursive: true });
		await Bun.write(parentFile, sessionContent("parent", []));
		await Bun.write(
			path.join(artifacts, `__consult.${firstId}.jsonl`),
			sessionContent(firstId, [
				thread(firstId),
				title(firstId, "First durable title"),
				turn(firstId, "first", 0, "running"),
				turn(firstId, "first", 0, "completed"),
				turn(firstId, "second", 1, "running"),
			]),
		);
		await Bun.write(
			path.join(artifacts, `__consult.${secondId}.jsonl`),
			sessionContent(secondId, [
				thread(secondId),
				title(secondId, "Second durable title"),
				turn(secondId, "first", 0, "running"),
				turn(secondId, "first", 0, "completed"),
			]),
		);

		AgentRegistry.resetGlobalForTests();
		const selections: Array<{ title: string; choices: readonly string[] }> = [];
		const opened: Array<{ openAgentId?: string }> = [];
		const ctx = {
			sessionManager: { getSessionFile: () => parentFile },
			showHookSelector: async (title: string, choices: readonly string[]) => {
				selections.push({ title, choices });
				if (title === "Consultations")
					return choices.find(choice => choice.startsWith("First durable title · consult:cdef0one ·"));
				if (title === "First durable title · consult:cdef0one") return "Open full transcript in Agent Hub";
			},
			showAgentHub: (options: { openAgentId?: string }) => opened.push(options),
		} as unknown as InteractiveModeContext;

		try {
			await new SelectorController(ctx).showConsultsSelector();
		} finally {
			AgentRegistry.resetGlobalForTests();
		}

		const list = selections.find(selection => selection.title === "Consultations");
		expect(list?.choices).toEqual(
			expect.arrayContaining([
				expect.stringMatching(/^First durable title · consult:cdef0one · cancelled · 2 turns · /),
				expect.stringMatching(/^Second durable title · consult:cdef0two · completed · 1 turn · /),
			]),
		);
		expect(
			selections.find(selection => selection.title === "First durable title · consult:cdef0one")?.choices,
		).toEqual(["Open full transcript in Agent Hub", "Resume", "Copy selected answer", "Quote in parent", "Ask main"]);
		expect(opened).toEqual([{ openAgentId: `Main/consult:${firstId}` }]);
	});

	it("hands off the selected latest answer when the active panel shows an older turn", async () => {
		using temp = TempDir.createSync("@omp-consult-picker-handoff-");
		const parentFile = path.join(temp.path(), "parent.jsonl");
		const artifacts = parentFile.slice(0, -6);
		const consultationId = "abcdef0handoff";
		const consultationFile = path.join(artifacts, `__consult.${consultationId}.jsonl`);
		await fs.mkdir(artifacts, { recursive: true });
		await Bun.write(parentFile, sessionContent("parent", []));
		await Bun.write(
			consultationFile,
			sessionContent(consultationId, [
				thread(consultationId),
				title(consultationId, "Handoff review"),
				turn(consultationId, "first", 0, "running"),
				message("first-answer", "assistant", "older answer"),
				turn(consultationId, "first", 0, "completed"),
				turn(consultationId, "second", 1, "running"),
				message("second-answer", "assistant", "latest selected answer"),
				turn(consultationId, "second", 1, "completed"),
			]),
		);

		AgentRegistry.resetGlobalForTests();
		const quoteVisible = vi.fn(async () => true);
		const prepareSelected = vi.fn(() => true);
		const ctx = {
			sessionManager: { getSessionFile: () => parentFile },
			showHookSelector: async (title: string, choices: readonly string[]) => {
				if (title === "Consultations") return choices[0];
				return "Quote in parent";
			},
			getActiveConsultThread: () => ({
				consultationId,
				sessionFile: consultationFile,
				ownerId: "Main",
			}),
			getConsultTurnPresentation: () => ({ isLatest: false }),
			isConsultComposerActive: true,
			quoteConsultationAnswerInParent: quoteVisible,
			prepareQuotedConsultationAnswerInParent: prepareSelected,
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;

		try {
			await new SelectorController(ctx).showConsultsSelector();
		} finally {
			AgentRegistry.resetGlobalForTests();
		}

		expect(quoteVisible).not.toHaveBeenCalled();
		expect(prepareSelected).toHaveBeenCalledWith(
			"latest selected answer",
			expect.objectContaining({ consultationId, sessionFile: consultationFile }),
		);
	});
});

describe("consultation thread parsing", () => {
	it("keeps immutable thread metadata, reduces terminal state, and replays only completed turns", () => {
		const entries = parseSessionEntries(
			sessionContent("consult", [
				thread("consult"),
				message("user-one", "user", "question 0"),
				turn("consult", "one", 0, "running"),
				message("assistant-one", "assistant", "answer one"),
				turn("consult", "one", 0, "completed"),
				message("user-two", "user", "question 1"),
				turn("consult", "two", 1, "running"),
				message("assistant-two", "assistant", "partial answer two"),
				turn("consult", "two", 1, "cancelled"),
			]),
		);

		expect(consultationThreadMetadata(entries, "consult")).toEqual({
			version: 1,
			consultationId: "consult",
			parentSessionId: "parent",
			parentLeafId: "leaf",
			createdAt: 1,
		});
		expect(consultationTurnStates(entries, "consult").map(state => state.terminal?.status)).toEqual([
			"completed",
			"cancelled",
		]);
		expect(replayCompletedConsultationMessages(entries, "consult").map(entry => entry.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(lookupConsultationThread(entries, "consult")).toMatchObject({
			threadIds: ["consult"],
			hasCollision: false,
		});
	});

	it("rejects conflicting immutable records instead of selecting an arbitrary thread", () => {
		const entries = parseSessionEntries(
			sessionContent("consult", [
				thread("consult"),
				{
					...thread("consult"),
					id: "thread-conflict",
					data: { ...thread("consult").data, parentSessionId: "other-parent" },
				},
			]),
		);
		expect(consultationThreadMetadata(entries, "consult")).toBeUndefined();
		expect(lookupConsultationThread(entries, "consult")).toMatchObject({ hasCollision: true });
	});
});
