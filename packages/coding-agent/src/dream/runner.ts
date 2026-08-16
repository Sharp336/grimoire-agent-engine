/**
 * Dream runner — one dreaming pass over the active memory backend.
 *
 * Dreaming is idle-time memory consolidation: while the user is away the agent
 * reviews recent session history, promotes durable signal into long-term
 * memory, and records what it did in a human-readable dream diary
 * (`DREAMS.md`). The runner drives whichever backend is active:
 *
 *   - `local`    — runs the incremental extraction + consolidation pipeline
 *                  now (instead of waiting for the next startup) and writes a
 *                  diary entry with a short model-written reflection.
 *   - `mnemopi`  — forces retention, flushes extractions, and runs sleep
 *                  consolidation via the backend's `enqueue`.
 *   - `hindsight`— flushes queued retains to the remote service.
 *   - `off`      — nothing to dream about.
 *
 * Every failure is contained: a dream can be skipped or fail, never break the
 * session.
 */
import { completeSimple, Effort, retryTransientCompletion } from "@oh-my-pi/pi-ai";
import { clampThinkingLevelForModel } from "@oh-my-pi/pi-catalog/model-thinking";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { resolveMemoryModel, runMemoryDreamPass } from "../memories";
import { resolveMemoryBackend } from "../memory-backend";
import type { MemoryBackendId } from "../memory-backend/types";
import diaryInputTemplate from "../prompts/dream/diary_input.md" with { type: "text" };
import diarySystemTemplate from "../prompts/dream/diary_system.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { appendDreamDiaryEntry, getDreamDiaryPath } from "./diary";

export type DreamTrigger = "idle" | "manual";

export type DreamOutcome =
	/** New material was consolidated (or backend maintenance ran). */
	| "dreamt"
	/** Everything was already consolidated; nothing to do. */
	| "nothing_new"
	/** Dreaming could not run (backend off, no model, or aborted). */
	| "skipped"
	| "failed";

export interface DreamRunResult {
	outcome: DreamOutcome;
	backend: MemoryBackendId;
	trigger: DreamTrigger;
	/** Unix seconds the pass started. */
	startedAtSec: number;
	durationMs: number;
	/** One human-readable sentence describing what happened. */
	detail: string;
	/** Set when a diary entry was written for this pass. */
	diaryPath?: string;
}

export interface DreamRunOptions {
	session: AgentSession;
	settings: Settings;
	agentDir: string;
	cwd: string;
	trigger: DreamTrigger;
	signal: AbortSignal;
}

const MAX_REFLECTION_INPUT_SYNOPSES = 24;

export async function runDream(options: DreamRunOptions): Promise<DreamRunResult> {
	const { session, settings, agentDir, cwd, trigger } = options;
	const startedAtSec = Math.floor(Date.now() / 1000);
	const startedMs = Date.now();
	const backendId = settings.get("memory.backend");
	const finish = (outcome: DreamOutcome, detail: string, diaryPath?: string): DreamRunResult => ({
		outcome,
		backend: backendId,
		trigger,
		startedAtSec,
		durationMs: Date.now() - startedMs,
		detail,
		diaryPath,
	});

	if (backendId === "off") {
		return finish("skipped", "No memory backend is enabled — nothing to dream about.");
	}

	try {
		if (backendId === "local") {
			return await dreamLocal(options, finish);
		}

		// Remote/engine backends own their consolidation internals; `enqueue` is
		// the sanctioned "consolidate now" surface (same as `/memory enqueue`).
		const backend = await resolveMemoryBackend(settings);
		await backend.enqueue(agentDir, cwd, session);
		const detail =
			backendId === "mnemopi"
				? "Retention flushed and sleep consolidation ran."
				: "Queued retains flushed to the memory service.";
		// Only a manual dream is diarised for these backends: `enqueue` reports no
		// stats, so an idle entry every cooldown would just be noise.
		let diaryPath: string | undefined;
		if (trigger === "manual" && settings.get("dream.diary")) {
			diaryPath = getDreamDiaryPath(agentDir, cwd);
			await appendDreamDiaryEntry(
				diaryPath,
				{ atSec: startedAtSec, trigger, facts: [`Backend: ${backendId}`, detail] },
				settings.get("dream.diaryMaxEntries"),
			);
		}
		return finish("dreamt", detail, diaryPath);
	} catch (error) {
		logger.warn("Dream run failed", { backend: backendId, trigger, error: String(error) });
		return finish("failed", `Dreaming failed: ${String(error)}`);
	}
}

async function dreamLocal(
	options: DreamRunOptions,
	finish: (outcome: DreamOutcome, detail: string, diaryPath?: string) => DreamRunResult,
): Promise<DreamRunResult> {
	const { session, settings, agentDir, cwd, trigger, signal } = options;
	const pass = await runMemoryDreamPass({
		session,
		settings,
		modelRegistry: session.modelRegistry,
		agentDir,
		signal,
		limits: {
			maxSessions: settings.get("dream.maxSessionsPerDream"),
			minSessionIdleHours: settings.get("dream.minSessionIdleHours"),
		},
	});

	if (!pass.ran) {
		return finish("skipped", "Local memory pipeline is unavailable.");
	}
	if (!pass.modelAvailable && !pass.consolidated) {
		return finish("skipped", "No model or API key available for memory consolidation.");
	}

	const dreamt = pass.extracted > 0 || pass.consolidated;
	if (!dreamt) {
		return finish("nothing_new", "Recent sessions are already consolidated.");
	}

	const facts = [
		"Backend: local",
		`Sessions reviewed: ${pass.scanned} (${pass.extracted} yielded new memories${pass.failed > 0 ? `, ${pass.failed} failed` : ""})`,
		pass.consolidated ? "Long-term memory updated (MEMORY.md)" : "Extraction stored; consolidation deferred",
	];
	const detail = `${facts[1]}. ${pass.consolidated ? "Long-term memory updated." : "Consolidation deferred to a later pass."}`;

	let diaryPath: string | undefined;
	if (settings.get("dream.diary")) {
		const reflection =
			pass.synopses.length > 0 && !signal.aborted
				? await generateDreamReflection(session, pass.synopses)
				: undefined;
		diaryPath = getDreamDiaryPath(agentDir, cwd);
		await appendDreamDiaryEntry(
			diaryPath,
			{ atSec: Math.floor(Date.now() / 1000), trigger, facts, reflection, synopses: pass.synopses },
			settings.get("dream.diaryMaxEntries"),
		);
	}
	return finish("dreamt", detail, diaryPath);
}

/**
 * One short model-written paragraph about what the dream reviewed. Input is
 * stage-1 synopses, which are already secret-redacted; failure or an
 * unavailable model just drops the paragraph, never the diary entry.
 */
async function generateDreamReflection(session: AgentSession, synopses: string[]): Promise<string | undefined> {
	try {
		const modelRegistry = session.modelRegistry;
		const model = await resolveMemoryModel({ modelRegistry, session, fallbackRole: "smol" });
		if (!model) return undefined;
		const apiKey = await modelRegistry.getApiKey(model, session.sessionId);
		if (!apiKey) return undefined;

		const input = prompt.render(diaryInputTemplate, {
			synopses: synopses.slice(0, MAX_REFLECTION_INPUT_SYNOPSES).map(s => s.replace(/\s+/g, " ").trim()),
		});
		const response = await retryTransientCompletion(() =>
			completeSimple(
				model,
				{
					systemPrompt: [diarySystemTemplate],
					messages: [{ role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() }],
				},
				{
					apiKey: modelRegistry.resolver(model, session.sessionId),
					metadata: session.agent?.metadataForProvider(model.provider),
					maxTokens: 1024,
					reasoning: clampThinkingLevelForModel(model, Effort.Low),
				},
			),
		);
		if (response.stopReason === "error") return undefined;
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("\n")
			.trim();
		return text || undefined;
	} catch (error) {
		logger.debug("Dream reflection generation failed", { error: String(error) });
		return undefined;
	}
}
