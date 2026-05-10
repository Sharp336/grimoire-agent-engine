/**
 * ConventionExtractor: extracts project-specific conventions from user dialogue.
 *
 * Captures explicit instructions ("请记住"), preferences, rules, and facts
 * from user_input and assistant_message trace entries.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Convention, ConventionType, SessionTrace, ToolChainDiagnosis } from "./types";

interface PatternDef {
	type: ConventionType;
	regex: RegExp;
	boost: number;
}

/**
 * Ordered by priority. Earlier patterns with higher boost win when content
 * overlaps (e.g. "请记住：不要修改" — the "请记住" match takes precedence).
 */
const PATTERN_DEFS: Array<{ type: ConventionType; pattern: string; boost: number }> = [
	// Explicit memory requests — highest confidence, checked first
	{
		type: "preference",
		pattern: "(?:以后请记住|以后记住|请记住|记住)[：:,;]?\\s*([^\u3002\uFF01\uFF1F\uFF1B\u3001\n]{4,80})",
		boost: 85,
	},
	// Direct instructions
	{
		type: "positive_rule",
		pattern: "(?:你应该|你应该|你必须|you should|you must)[：:,;]?\\s*([^\u3002\uFF01\uFF1F\uFF1B\u3001\n]{4,80})",
		boost: 70,
	},
	// Negative rules
	{
		type: "negative_rule",
		pattern: "(?:不要|never|don['']t|do not|禁止|别|avoid|skip|don t|dont)[^\u3002\uFF01\uFF1F\uFF1B\u3001\n]{4,80}",
		boost: 60,
	},
	// Positive rules / mandates
	{
		type: "positive_rule",
		pattern:
			"(?:总是先[^\u3002\uFF01\uFF1F\uFF1B\u3001\n]{4,80}|always[^\u3002\uFF01\uFF1F\uFF1B\u3001\n]*?first[^\u3002\uFF01\uFF1F\uFF1B\u3001\n]*|必须先[^\u3002\uFF01\uFF1F\uFF1B\u3001\n]{4,80}|should always[^\u3002\uFF01\uFF1F\uFF1B\u3001\n]{4,80}|remember to[^\u3002\uFF01\uFF1F\uFF1B\u3001\n]{4,80}|make sure to[^\u3002\uFF01\uFF1F\uFF1B\u3001\n]{4,80})",
		boost: 55,
	},
	// Preferences
	{
		type: "preference",
		pattern:
			"(?:prefer[^\u3002\uFF01\uFF1F\uFF1B\u3001\n]*?over[^\u3002\uFF01\uFF1F\uFF1B\u3001\n]*|用[^\u3002\uFF01\uFF1F\uFF1B\u3001\n]*?而不是[^\u3002\uFF01\uFF1F\uFF1B\u3001\n]*|应该使用|use[^\u3002\uFF01\uFF1F\uFF1B\u3001\n]*?instead of[^\u3002\uFF01\uFF1F\uFF1B\u3001\n]*|rather than[^\u3002\uFF01\uFF1F\uFF1B\u3001\n]*)",
		boost: 50,
	},
	// Project facts
	{
		type: "project_fact",
		pattern:
			"(?:本项目使用|This project uses|我们使用|we use|we are using|project uses|uses[^\u3002\uFF01\uFF1F\uFF1B\u3001\n]*?for[^\u3002\uFF01\uFF1F\uFF1B\u3001\n]*)",
		boost: 50,
	},
	// Procedural rules
	{
		type: "procedural_rule",
		pattern:
			"(?:先检查|read[^\u3002\uFF01\uFF1F\uFF1B\u3001\n]*?first|先看一下|first check|check[^\u3002\uFF01\uFF1F\uFF1B\u3001\n]*?first|read first|before doing|before you|step [0-9]|first step|next step)",
		boost: 50,
	},
];

function compilePatterns(): PatternDef[] {
	return PATTERN_DEFS.map(def => ({
		type: def.type,
		regex: new RegExp(def.pattern, "gi"),
		boost: def.boost,
	}));
}

function normalizeContent(content: string): string {
	return content.toLowerCase().trim().replace(/\s+/g, " ");
}

function stripPrefixPunctuation(content: string): string {
	return content.replace(/^[，,；;：:\s]+/, "");
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

			for (const { type, regex, boost } of this.#patterns) {
				const matches = entry.content.matchAll(regex);
				for (const match of matches) {
					// Use capture group 1 if available (for explicit prefix patterns),
					// otherwise use full match
					const raw = match[1] ?? match[0];
					if (!raw) {
						continue;
					}
					let content = raw.trim();
					// Strip leading punctuation left by regex capture
					content = stripPrefixPunctuation(content);
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
						confidence: boost,
						timesApplied: 0,
						timesViolated: 0,
						createdAt: now,
						lastSeenAt: now,
					};

					results.push(convention);
					logger.debug("Extracted convention", {
						type,
						content: content.slice(0, 80),
						confidence: boost,
					});
				}
			}
		}

		return results;
	}
	extractFromDiagnosis(diagnosis: ToolChainDiagnosis): Convention[] {
		const results: Convention[] = [];
		const seen = new Set<string>();
		const now = Date.now();

		// Extract negative_rule conventions from read failure root causes
		for (const rf of diagnosis.readFailures) {
			let content: string | undefined;
			switch (rf.failureType) {
				case "verify_after_edit_failure":
					content = "Always verify edit/write success before reading back to confirm changes.";
					break;
				case "search_misled":
					content = "Do not guess file paths after a failed search; use find to confirm existence before reading.";
					break;
				case "path_not_found":
					content = "Use find or search to confirm a path exists before calling read.";
					break;
				case "invalid_sel":
					content = "Validate line-range selectors (1-indexed) before passing them to read.";
					break;
				case "permission_denied":
					content = "Check file permissions before attempting to read restricted files.";
					break;
			}

			if (content && !seen.has(content)) {
				seen.add(content);
				results.push({
					id: generateId(content, "negative_rule"),
					type: "negative_rule",
					content,
					sourceEpisodeId: diagnosis.sessionId,
					confidence: 70,
					timesApplied: 0,
					timesViolated: 0,
					createdAt: now,
					lastSeenAt: now,
				});
			}
		}

		// Extract procedural_rule conventions from cascade patterns
		for (const cp of diagnosis.cascadePatterns) {
			if (cp.count >= 2) {
				const content = `When ${cp.triggerTool} fails, avoid immediate ${cp.followUpTool} remediation; address the root cause (${cp.rootCause}) first.`;
				if (!seen.has(content)) {
					seen.add(content);
					results.push({
						id: generateId(content, "procedural_rule"),
						type: "procedural_rule",
						content,
						sourceEpisodeId: diagnosis.sessionId,
						confidence: 65,
						timesApplied: 0,
						timesViolated: 0,
						createdAt: now,
						lastSeenAt: now,
					});
				}
			}
		}

		// Extract preference conventions from efficiency issues
		if (diagnosis.redundantSearches) {
			const content = "Prefer ast_grep or find over repeated text searches for structural code queries.";
			if (!seen.has(content)) {
				seen.add(content);
				results.push({
					id: generateId(content, "preference"),
					type: "preference",
					content,
					sourceEpisodeId: diagnosis.sessionId,
					confidence: 60,
					timesApplied: 0,
					timesViolated: 0,
					createdAt: now,
					lastSeenAt: now,
				});
			}
		}

		if (diagnosis.slowLoop) {
			const content = "Re-evaluate approach if multiple tool calls produce no successful file modifications.";
			if (!seen.has(content)) {
				seen.add(content);
				results.push({
					id: generateId(content, "preference"),
					type: "preference",
					content,
					sourceEpisodeId: diagnosis.sessionId,
					confidence: 55,
					timesApplied: 0,
					timesViolated: 0,
					createdAt: now,
					lastSeenAt: now,
				});
			}
		}

		return results;
	}
}

/**
 * Re-extract conventions from a batch of traces for backfill / migration.
 */
export function extractConventionsFromTraces(traces: SessionTrace[]): Convention[] {
	const extractor = new ConventionExtractor();
	const all: Convention[] = [];
	for (const trace of traces) {
		all.push(...extractor.extract(trace));
	}
	return all;
}
