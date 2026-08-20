import type { AssistantMessageEvent, PromptProgress } from "../types";

/** Prompt-processing progress carried beside canonical assistant events. */
export interface PiNativePromptProgressFrame {
	type: "prompt_progress";
	progress: PromptProgress;
}

/** Frames emitted by the pi-native gateway SSE endpoint. */
export type PiNativeStreamFrame = AssistantMessageEvent | PiNativePromptProgressFrame;

/** One-shot prompt-progress bridge owned by a pi-native gateway request. */
export interface PiNativePromptProgressRelay {
	emit(progress: PromptProgress): void;
	subscribe(listener: (progress: PromptProgress) => void): () => void;
	close(): void;
}

/**
 * Bridge a provider callback to the SSE encoder without racing stream setup.
 * Progress emitted before the encoder subscribes is buffered briefly; closing
 * the request drops the buffer and makes later provider callbacks no-ops.
 */
export function createPiNativePromptProgressRelay(): PiNativePromptProgressRelay {
	let closed = false;
	let listener: ((progress: PromptProgress) => void) | undefined;
	let pending: PromptProgress | undefined;

	return {
		emit(progress) {
			if (closed) return;
			if (!listener) {
				// Progress is a cumulative snapshot, so only the newest value matters
				// during the brief gap before the SSE encoder subscribes.
				pending = progress;
				return;
			}
			try {
				listener(progress);
			} catch {
				// Progress is diagnostic/UI-only and cannot break generation.
			}
		},
		subscribe(next) {
			if (closed) return () => {};
			listener = next;
			if (pending) {
				try {
					next(pending);
				} catch {
					// Match live delivery: observer failures are isolated.
				}
			}
			pending = undefined;
			return () => {
				if (listener === next) listener = undefined;
			};
		},
		close() {
			closed = true;
			listener = undefined;
			pending = undefined;
		},
	};
}

/** Validate a prompt-progress frame received across the gateway boundary. */
export function isPiNativePromptProgressFrame(value: unknown): value is PiNativePromptProgressFrame {
	if (!value || typeof value !== "object") return false;
	const frame = value as Record<string, unknown>;
	if (frame.type !== "prompt_progress" || !frame.progress || typeof frame.progress !== "object") return false;
	const progress = frame.progress as Record<string, unknown>;
	const total = progress.total;
	const processed = progress.processed;
	const cached = progress.cached;
	return (
		typeof total === "number" &&
		Number.isFinite(total) &&
		total > 0 &&
		typeof processed === "number" &&
		Number.isFinite(processed) &&
		processed >= 0 &&
		processed <= total &&
		typeof cached === "number" &&
		Number.isFinite(cached) &&
		cached >= 0 &&
		cached <= processed
	);
}
