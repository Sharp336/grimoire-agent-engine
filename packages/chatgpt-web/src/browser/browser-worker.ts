import type { ChatGptWebEvent, ChatGptWebRuntimeAdmission, ChatGptWebTurnIdentity } from "../provider/types";
import type { BrowserAttachment, BrowserHost, ResponseSnapshot } from "../runtime/host";
import { BrowserContractError } from "../runtime/host";
import {
	assertAuthenticatedChatGptPage,
	assertTemporaryChatPage,
	CHATGPT_TEMPORARY_CHAT_TARGET,
	effortForModelKey,
	selectChatGptEffort,
} from "./chatgpt-session";
import { ChatGptMarkdownStream } from "./markdown";

export const DEFAULT_CHATGPT_TURN_TIMEOUT_MS = 40 * 60_000;
export const CHATGPT_COMPLETION_SETTLE_MS = 2_000;
export const CHATGPT_HEARTBEAT_MS = 10_000;
export const CHATGPT_POLL_MS = 250;

export interface BrowserTurnAttachmentInput {
	readonly name: string;
	readonly bytes: Uint8Array;
}
export interface BrowserTurnRequest {
	readonly identity: ChatGptWebTurnIdentity;
	readonly modelKey: string;
	readonly mode: "browser-only" | "full";
	readonly headed: boolean;
	readonly prompt: string;
	readonly attachments?: readonly BrowserTurnAttachmentInput[];
	readonly onHeartbeat?: () => void;
}
export type ChatGptSubmissionEvidence = "user_turn" | "assistant_turn" | "generation_running";

export function chatGptSubmissionEvidence(
	initial: ResponseSnapshot,
	current: ResponseSnapshot,
	prompt: string,
): ChatGptSubmissionEvidence | undefined {
	if (current.userText === prompt && initial.userText !== prompt) return "user_turn";
	if (current.assistantText.length > 0 && current.assistantText !== initial.assistantText) return "assistant_turn";
	if (current.generationId !== null && current.generationId !== initial.generationId) return "generation_running";
	return undefined;
}

export class ChatGptCompletionTracker {
	#candidate?: { signature: string; since: number };
	constructor(private readonly stableMs = CHATGPT_COMPLETION_SETTLE_MS) {}
	update(snapshot: ResponseSnapshot, now = Date.now()): boolean {
		if (!snapshot.settled || snapshot.assistantText.length === 0) {
			this.#candidate = undefined;
			return false;
		}
		const signature = `${snapshot.generationId ?? ""}\0${snapshot.assistantText}`;
		if (this.#candidate?.signature !== signature) {
			this.#candidate = { signature, since: now };
			return false;
		}
		return now - this.#candidate.since >= this.stableMs;
	}
}

export function browserErrorClass(error: unknown): BrowserContractError["errorClass"] {
	if (error instanceof BrowserContractError) return error.errorClass;
	if (error instanceof DOMException && error.name === "AbortError") return "aborted";
	return "internal";
}

function abortError(): DOMException {
	return new DOMException("browser_turn_aborted", "AbortError");
}
function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}
function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(abortError());
		const timer = setTimeout(done, milliseconds);
		function done(): void {
			signal?.removeEventListener("abort", aborted);
			resolve();
		}
		function aborted(): void {
			clearTimeout(timer);
			reject(abortError());
		}
		signal?.addEventListener("abort", aborted, { once: true });
	});
}
export class ChatGptReasoningTracker {
	#candidate = "";
	#emitted = "";

	observe(current: string): ChatGptWebEvent | undefined {
		if (!current || current !== this.#candidate) {
			this.#candidate = current;
			return undefined;
		}
		if (current === this.#emitted) return undefined;
		const continuation = this.#emitted.length > 0 && current.startsWith(this.#emitted);
		const text = continuation ? current.slice(this.#emitted.length) : current;
		this.#emitted = current;
		return text ? { type: "reasoning", text, continuation } : undefined;
	}
}
async function stageAttachments(
	inputs: readonly BrowserTurnAttachmentInput[],
	stage: (input: BrowserTurnAttachmentInput) => Promise<BrowserAttachment>,
): Promise<readonly BrowserAttachment[]> {
	const output: BrowserAttachment[] = [];
	for (const input of inputs) output.push(await stage(input));
	return output;
}

export async function runBrowserTurn(
	turn: BrowserTurnRequest,
	host: BrowserHost,
	admission: ChatGptWebRuntimeAdmission,
	emit: (event: ChatGptWebEvent) => void,
	signal?: AbortSignal,
): Promise<void> {
	const deadline = Date.now() + DEFAULT_CHATGPT_TURN_TIMEOUT_MS;
	let lease: Awaited<ReturnType<BrowserHost["lease"]>> | undefined;
	let abortLease: (() => void) | undefined;
	const heartbeat = turn.onHeartbeat
		? setInterval(() => {
				try {
					turn.onHeartbeat?.();
				} catch {
					// Heartbeat observers cannot interrupt or expose browser turn state.
				}
			}, CHATGPT_HEARTBEAT_MS)
		: undefined;
	try {
		throwIfAborted(signal);
		lease = await host.lease(
			{
				sessionId: turn.identity.sessionId,
				turnId: turn.identity.turnId,
				modelKey: turn.modelKey,
				mode: turn.mode,
				headed: turn.headed,
				...(signal ? { signal } : {}),
			},
			admission,
		);
		if (signal) {
			const activeLease = lease;
			abortLease = () => {
				void activeLease.close().catch(() => undefined);
			};
			signal.addEventListener("abort", abortLease, { once: true });
		}
		throwIfAborted(signal);
		const page = lease.page;
		await page.goto(CHATGPT_TEMPORARY_CHAT_TARGET);
		await assertAuthenticatedChatGptPage(page);
		await assertTemporaryChatPage(page);
		await selectChatGptEffort(page, effortForModelKey(turn.modelKey));

		const composer = page.locator("composer").last();
		await composer.fill(turn.prompt);
		const composed = await page.readComposerSnapshot();
		if (!composed.ready || composed.text !== turn.prompt) {
			throw new BrowserContractError("selector_drift", "prompt_attachment_failed");
		}

		const attachments = await stageAttachments(turn.attachments ?? [], input => lease!.stageAttachment(input));
		if (attachments.length > 0) {
			await page.locator("attachment-input").setInputFiles(attachments);
			for (const attachment of attachments) {
				const evidence = page.locator("health").filter({ key: "attachment-input", hasText: attachment.name });
				if ((await evidence.count()) !== 1 || !(await evidence.isVisible())) {
					throw new BrowserContractError("selector_drift", "attachment_evidence_missing");
				}
			}
		}

		const initial = await page.readResponseSnapshot();
		const send = page.locator("send").last();
		if (!composed.canSubmit || !(await send.isVisible()) || !(await send.isEnabled())) {
			throw new BrowserContractError("selector_drift", "send_not_ready");
		}
		await send.press("Enter");

		let latest = initial;
		let evidence: ChatGptSubmissionEvidence | undefined;
		while (!evidence) {
			throwIfAborted(signal);
			if (Date.now() >= deadline) throw new BrowserContractError("browser_unavailable", "submission_timeout");
			latest = await page.readResponseSnapshot();
			evidence = chatGptSubmissionEvidence(initial, latest, turn.prompt);
			if (!evidence) await sleep(CHATGPT_POLL_MS, signal);
		}
		emit({ type: "start", responseId: latest.generationId ?? lease.id });

		const markdown = new ChatGptMarkdownStream();
		const completion = new ChatGptCompletionTracker();
		const reasoning = new ChatGptReasoningTracker();
		let emittedText = "";
		for (;;) {
			throwIfAborted(signal);
			if (Date.now() >= deadline) throw new BrowserContractError("browser_unavailable", "turn_timeout");
			const health = await page.readHealthSnapshot();
			if (!health.ready || health.errorClass) {
				throw new BrowserContractError(health.errorClass ?? "selector_drift", "browser_health_failed");
			}
			latest = await page.readResponseSnapshot();
			const reasoningEvent = reasoning.observe(latest.reasoningText);
			if (reasoningEvent) emit(reasoningEvent);
			if (latest.settled) {
				const stableDelta = markdown.observeStableHtml(latest.assistantText);
				if (stableDelta) {
					emit({ type: "text", text: stableDelta, continuation: emittedText.length > 0 });
					emittedText += stableDelta;
				}
			}
			if (completion.update(latest)) {
				const final = markdown.finish(latest.assistantText);
				if (!final.markdown) throw new BrowserContractError("malformed_browser_output", "empty_settled_response");
				if (final.delta) emit({ type: "text", text: final.delta, continuation: emittedText.length > 0 });
				emit({ type: "done", reason: "stop" });
				return;
			}
			await sleep(CHATGPT_POLL_MS, signal);
		}
	} catch (error) {
		if (signal?.aborted && lease) {
			const stop = lease.page.getByRole({ role: "button", name: "Stop generating" });
			if (await stop.isVisible().catch(() => false)) await stop.press("Enter").catch(() => undefined);
		}
		emit({ type: "error", errorClass: browserErrorClass(error), retryable: false });
		throw error;
	} finally {
		clearInterval(heartbeat);
		if (abortLease) signal?.removeEventListener("abort", abortLease);
		await lease?.close().catch(() => undefined);
	}
}
