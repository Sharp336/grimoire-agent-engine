import { inspectMessagePhases, parseNativePhase } from "./phase";
import type { MessagePhaseInspection, PhaseMessage, PhaseTextBlock } from "./types";

export const COLLAPSED_COMMENTARY_PREFIX = "↳ ";
export const COLLAPSED_COMMENTARY_VISIBLE_CODE_POINT_LIMIT = 72;

const ANSI_ESCAPE_PATTERN =
	/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[PX^_][^\u001B]*(?:\u001B\\))/gu;
const STRIPPED_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const LINE_SPLIT_PATTERN = /\r\n|[\n\r\u2028\u2029]/u;
const WHITESPACE_PATTERN = /\s+/gu;

function sanitizeSummaryLine(line: string): string {
	return line
		.replace(ANSI_ESCAPE_PATTERN, "")
		.replace(STRIPPED_CONTROL_PATTERN, "")
		.replace(WHITESPACE_PATTERN, " ")
		.trim();
}

function isPhaseTextBlock(block: unknown): block is PhaseTextBlock {
	return (
		typeof block === "object" &&
		block !== null &&
		!Array.isArray(block) &&
		"type" in block &&
		block.type === "text" &&
		"text" in block &&
		typeof block.text === "string"
	);
}

function capVisibleCodePoints(value: string): string {
	const codePoints = Array.from(value);
	if (codePoints.length <= COLLAPSED_COMMENTARY_VISIBLE_CODE_POINT_LIMIT) return value;

	return `${codePoints.slice(0, COLLAPSED_COMMENTARY_VISIBLE_CODE_POINT_LIMIT - 1).join("")}…`;
}

export function createCollapsedCommentarySummary(text: string): string | undefined {
	for (const rawLine of text.split(LINE_SPLIT_PATTERN)) {
		const line = sanitizeSummaryLine(rawLine);
		if (line.length === 0) continue;

		return capVisibleCodePoints(`${COLLAPSED_COMMENTARY_PREFIX}${line}`);
	}

	return undefined;
}

export function createCollapsedThinkingSummary(text: string): string | undefined {
	for (const rawLine of text.split(LINE_SPLIT_PATTERN)) {
		let line = sanitizeSummaryLine(rawLine);
		if (line.length === 0 || /^<!--\s*(?:-->)?$/u.test(line)) continue;
		line = line.replace(/^#{1,6}\s+/u, "");
		for (const marker of ["**", "__", "*", "_"] as const) {
			if (line.startsWith(marker) && line.endsWith(marker) && line.length > marker.length * 2) {
				line = line.slice(marker.length, -marker.length).trim();
				break;
			}
		}
		if (line.length > 0) return capVisibleCodePoints(line);
	}
	return undefined;
}

function collapseCommentaryBlock(block: PhaseTextBlock): PhaseTextBlock | undefined {
	const summary = createCollapsedCommentarySummary(block.text);
	if (summary === undefined) return undefined;
	return { ...block, text: summary };
}

export function transformMessageForCollapsedDisplay<Message extends PhaseMessage>(message: Message): Message {
	const inspection = inspectMessagePhases(message);
	return transformInspectedMessageForCollapsedDisplay(message, inspection);
}

export function transformInspectedMessageForCollapsedDisplay<Message extends PhaseMessage>(
	message: Message,
	inspection: MessagePhaseInspection,
): Message {
	if (!inspection.hasCommentary || !Array.isArray(message.content)) return message;

	let sawCommentary = false;
	const transformedContent: unknown[] = [];
	for (const contentBlock of message.content) {
		if (isPhaseTextBlock(contentBlock) && parseNativePhase(contentBlock.textSignature) === "commentary") {
			sawCommentary = true;
			const collapsed = collapseCommentaryBlock(contentBlock);
			if (collapsed !== undefined) transformedContent.push(collapsed);
			continue;
		}

		transformedContent.push(contentBlock);
	}

	if (!sawCommentary) return message;
	return { ...message, content: transformedContent } as Message;
}

export function transformMessageWithoutCommentary<Message extends PhaseMessage>(message: Message): Message {
	if (!Array.isArray(message.content)) return message;

	let sawCommentary = false;
	const transformedContent: unknown[] = [];
	for (const contentBlock of message.content) {
		if (isPhaseTextBlock(contentBlock) && parseNativePhase(contentBlock.textSignature) === "commentary") {
			sawCommentary = true;
			continue;
		}
		transformedContent.push(contentBlock);
	}

	if (!sawCommentary) return message;
	return { ...message, content: transformedContent } as Message;
}

export function transformMessagesForCollapsedDisplay<Message extends PhaseMessage>(
	messages: readonly Message[],
): Message[] {
	return messages.map(message => transformMessageForCollapsedDisplay(message));
}

export interface MessageState<Message extends PhaseMessage> {
	readonly messages: readonly Message[];
}

export function deriveCollapsedDisplayMessages<Message extends PhaseMessage>(state: MessageState<Message>): Message[] {
	return transformMessagesForCollapsedDisplay(state.messages);
}
