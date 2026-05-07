/**
 * ConventionExtractor: regex-based extraction of project-specific conventions
 * from user_input and assistant_message trace entries.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Convention, ConventionType, SessionTrace } from "./types";

interface PatternDef {
	type: ConventionType;
	regex: RegExp;
}

const PATTERN_DEFS: Array<{ type: ConventionType; pattern: string }> = [
	{
		type: "negative_rule",
		pattern: "(?:不要|never|don't|do not|禁止|别)[^。！？.!?;；]+",
	},
	{
		type: "positive_rule",
		pattern:
			"(?:总是先[^。！？.!?;；]+|always[^。！？.!?;；]*?first[^。！？.!?;；]*|必须先[^。！？.!?;；]+|should always[^。！？.!?;；]+)",
	},
	{
		type: "preference",
		pattern:
			"(?:prefer[^。！？.!?;；]*?over[^。！？.!?;；]*|用[^。！？.!?;；]*?而不是[^。！？.!?;；]*|应该使用)[^。！？.!?;；]*",
	},
	{
		type: "project_fact",
		pattern: "(?:本项目使用|This project uses|我们使用|we use|we are using)[^。！？.!?;；]*",
	},
	{
		type: "procedural_rule",
		pattern:
			"(?:先检查|read[^。！？.!?;；]*?first|先看一下|first check|check[^。！？.!?;；]*?first|read first|before doing)[^。！？.!?;；]*",
	},
];

function compilePatterns(): PatternDef[] {
	return PATTERN_DEFS.map(def => ({
		type: def.type,
		regex: new RegExp(def.pattern, "gi"),
	}));
}

function normalizeContent(content: string): string {
	return content.toLowerCase().trim().replace(/\s+/g, " ");
}

function generateId(content: string, type: ConventionType): string {
	const hash = Bun.hash(`${type}:${content}`).toString(36);
	return `conv_${hash}`;
}

export class ConventionExtractor {
	readonly #patterns: PatternDef[] = compilePatterns();

	extract(trace: SessionTrace): Convention[] {
		const results: Convention[] = [];
		const seen = new Set<string>();
		const now = Date.now();

		for (const entry of trace.entries) {
			if (entry.type !== "user_input" && entry.type !== "assistant_message") {
				continue;
			}
			if (!entry.content) {
				continue;
			}

			for (const { type, regex } of this.#patterns) {
				const matches = entry.content.matchAll(regex);
				for (const match of matches) {
					const raw = match[0];
					if (!raw) {
						continue;
					}
					const content = raw.trim();
					if (content.length < 4) {
						continue;
					}
					const normalized = normalizeContent(content);
					if (seen.has(normalized)) {
						continue;
					}
					seen.add(normalized);

					const convention: Convention = {
						id: generateId(normalized, type),
						type,
						content,
						sourceEpisodeId: trace.sessionId,
						confidence: 50,
						timesApplied: 0,
						timesViolated: 0,
						createdAt: now,
						lastSeenAt: now,
					};

					results.push(convention);
					logger.debug("Extracted convention", {
						type,
						content: content.slice(0, 80),
					});
				}
			}
		}

		return results;
	}
}
