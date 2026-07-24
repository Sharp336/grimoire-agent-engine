import type { SessionEntry } from "@oh-my-pi/pi-agent-core/compaction/entries";
import type { ContextDropRecord, MessageTagRecord } from "./types";

export type CavemanLevel = "lite" | "full" | "ultra";

export interface CavemanCandidate {
	readonly targetTag: number;
	readonly entryId: string;
	readonly replacementText: string;
	readonly depth: number;
}

const FILLER_PATTERN =
	/\b(?:just|really|basically|actually|essentially|simply|clearly|obviously|quite|very|somewhat|rather|fairly|perhaps|maybe|probably|please|kindly)\b\s*/gi;
const HEDGE_PATTERN =
	/\b(?:i think|i believe|i feel|it seems|it appears|i suppose|i guess|sort of|kind of|a bit)\b\s*/gi;
const ARTICLE_PATTERN = /\b(?:the|a|an)\b\s*/gi;
const AUXILIARY_PATTERN =
	/\s+\b(?:was|were|is|are|am|be|been|being|has been|had been|have been|will be|would be|could be|should be|might be|may be)\b\s+(?=\w+(?:ed|en|ing|ized|ised)\b)/gi;

function isStructuredText(text: string): boolean {
	if (text.includes("```")) return true;
	const trimmed = text.trim();
	if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
		try {
			JSON.parse(trimmed);
			return true;
		} catch {
			// Bracketed prose is still eligible when it is not JSON.
		}
	}
	const lines = text.split("\n");
	const diffLines = lines.filter(
		line => line.startsWith("diff --git") || line.startsWith("@@") || /^[+-]{3}/.test(line),
	);
	if (diffLines.length > 0) return true;
	const urls = text.match(/https?:\/\/\S+/g) ?? [];
	return urls.length >= 3 || urls.reduce((total, url) => total + url.length, 0) > text.length * 0.1;
}

function protectInlineCode(text: string): { text: string; values: string[] } {
	const values: string[] = [];
	return {
		text: text.replace(/`[^`\n]+`/g, value => {
			const index = values.push(value) - 1;
			return `\u0000OMP_CAVE_${index}\u0000`;
		}),
		values,
	};
}

export function cavemanCompress(text: string, level: CavemanLevel): string {
	const protectedText = protectInlineCode(text);
	let compressed = protectedText.text
		.replace(/\bin order to\b/gi, "to")
		.replace(/\bdue to the fact that\b/gi, "because")
		.replace(/\bat this point in time\b|\bat the moment\b/gi, "now")
		.replace(FILLER_PATTERN, "")
		.replace(HEDGE_PATTERN, "");
	if (level === "full" || level === "ultra") {
		compressed = compressed.replace(AUXILIARY_PATTERN, " ").replace(ARTICLE_PATTERN, "");
	}
	if (level === "ultra") {
		compressed = compressed
			.replace(/\b(?:and then|then after|afterwards|therefore)\b/gi, "→")
			.replace(/\bbecause of\b|\bbecause\b/gi, "//")
			.replace(/\bfurthermore\b|\badditionally\b/gi, "+")
			.replace(/ and /gi, " + ")
			.replace(/ or /gi, " | ");
	}
	for (let index = protectedText.values.length - 1; index >= 0; index--) {
		compressed = compressed.split(`\u0000OMP_CAVE_${index}\u0000`).join(protectedText.values[index]);
	}
	return compressed
		.split("\n")
		.map(line => line.replace(/[ \t]+/g, " ").trimEnd())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function plainMessageText(entry: SessionEntry): string | undefined {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role === "user" && typeof message.content === "string") return message.content;
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	if (!Array.isArray(message.content) || message.content.length !== 1) return undefined;
	const part = message.content[0];
	return part.type === "text" ? part.text : undefined;
}

export function planCavemanCompression(
	entries: readonly SessionEntry[],
	tags: readonly MessageTagRecord[],
	existingDrops: readonly ContextDropRecord[],
	options: { readonly protectedTagCount: number; readonly minChars: number },
): CavemanCandidate[] {
	const entryById = new Map(entries.map(entry => [entry.id, entry]));
	const newestTag = tags.reduce(
		(maximum, tag) => (tag.supersededAt === undefined ? Math.max(maximum, tag.tagOrdinal) : maximum),
		0,
	);
	const protectedCutoff = newestTag - Math.max(0, options.protectedTagCount);
	const existingDepth = new Map<number, number>();
	const blockedTags = new Set<number>();
	for (const drop of existingDrops) {
		if (drop.source !== "caveman") {
			if (drop.replacementText !== undefined || (!drop.clearReasoning && drop.replacementText === undefined)) {
				for (const tag of drop.expandedTags) blockedTags.add(tag);
			}
			continue;
		}
		const depth = Number(drop.reason?.match(/^caveman:(\d)$/)?.[1] ?? 0);
		existingDepth.set(drop.targetTag, Math.max(existingDepth.get(drop.targetTag) ?? 0, depth));
	}
	const eligible = tags
		.filter(tag => tag.supersededAt === undefined && tag.entryId && tag.tagOrdinal <= protectedCutoff)
		.map(tag => ({ tag, entry: entryById.get(tag.entryId!) }))
		.filter((item): item is { tag: MessageTagRecord; entry: SessionEntry } => item.entry !== undefined)
		.map(item => ({ ...item, text: plainMessageText(item.entry) }))
		.filter(
			(item): item is { tag: MessageTagRecord; entry: SessionEntry; text: string } =>
				item.text !== undefined && item.text.length >= options.minChars && !isStructuredText(item.text),
		)
		.sort((left, right) => left.tag.tagOrdinal - right.tag.tagOrdinal);
	const candidates: CavemanCandidate[] = [];
	for (let index = 0; index < eligible.length; index++) {
		const fraction = index / eligible.length;
		const depth = fraction < 0.2 ? 3 : fraction < 0.4 ? 2 : fraction < 0.6 ? 1 : 0;
		if (depth === 0) continue;
		const item = eligible[index];
		if (blockedTags.has(item.tag.tagOrdinal) || depth <= (existingDepth.get(item.tag.tagOrdinal) ?? 0)) continue;
		const level: CavemanLevel = depth === 3 ? "ultra" : depth === 2 ? "full" : "lite";
		const replacementText = cavemanCompress(item.text, level);
		if (replacementText.length === 0 || replacementText.length >= item.text.length) continue;
		candidates.push({
			targetTag: item.tag.tagOrdinal,
			entryId: item.entry.id,
			replacementText,
			depth,
		});
	}
	return candidates;
}
