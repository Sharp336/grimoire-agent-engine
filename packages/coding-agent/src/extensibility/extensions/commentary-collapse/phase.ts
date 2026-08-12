import { isRecord } from "@oh-my-pi/pi-utils/type-guards";

import type { MessagePhaseInspection, NativePhase, PhaseTextBlock, TextSignatureV1 } from "./types";

export type { MessagePhaseInspection, NativePhase, PhaseTextBlock, TextSignatureV1 } from "./types";

function isNativePhase(value: unknown): value is NativePhase {
	return value === "commentary" || value === "final_answer";
}

export function parseNativeTextSignature(signature: unknown): TextSignatureV1 | undefined {
	if (typeof signature !== "string" || signature.length === 0 || !signature.startsWith("{")) {
		return undefined;
	}

	try {
		const parsed: unknown = JSON.parse(signature);
		if (!isRecord(parsed)) return undefined;
		if (parsed.v !== 1) return undefined;
		if (typeof parsed.id !== "string" || parsed.id.length === 0) return undefined;
		if (parsed.phase !== undefined && !isNativePhase(parsed.phase)) return undefined;
		return {
			v: 1,
			id: parsed.id,
			...(parsed.phase === undefined ? {} : { phase: parsed.phase }),
		};
	} catch {
		return undefined;
	}
}

export function parseNativePhase(signature: unknown): NativePhase | undefined {
	return parseNativeTextSignature(signature)?.phase;
}

function isPhaseTextBlock(block: unknown): block is PhaseTextBlock {
	if (!isRecord(block)) return false;
	if (block.type !== "text") return false;
	if (typeof block.text !== "string") return false;
	if (block.textSignature !== undefined && typeof block.textSignature !== "string") return false;
	return true;
}

export function inspectMessagePhases(message: unknown): MessagePhaseInspection {
	let hasCommentary = false;
	let hasFinalAnswer = false;

	if (isRecord(message) && Array.isArray(message.content)) {
		for (const block of message.content) {
			if (!isPhaseTextBlock(block)) continue;

			const phase = parseNativePhase(block.textSignature);
			if (phase === "commentary") hasCommentary = true;
			if (phase === "final_answer") hasFinalAnswer = true;
		}
	}

	return {
		hasCommentary,
		hasFinalAnswer,
		phaseAware: hasCommentary || hasFinalAnswer,
	};
}
