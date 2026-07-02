/**
 * Structured section managers for markdown task bodies.
 *
 * These parse and serialize the markdown-list sections embedded in a task's
 * body: acceptance criteria, definition of done, and comments. No external
 * dependencies — pure string manipulation.
 */

import type { AcceptanceCriterion, DefinitionOfDoneItem, TaskComment } from "../types";

// ─── Headers ───────────────────────────────────────────────────────────────

const AC_HEADER = /##\s*Acceptance Criteria/i;
const DOD_HEADER = /##\s*Definition of Done/i;
const COMMENTS_HEADER = /##\s*Comments/i;
const NOTES_HEADER = /##\s*Notes/i;
const FINAL_SUMMARY_HEADER = /##\s*Final Summary/i;
const PLAN_HEADER = /##\s*Implementation Plan/i;

/** Match a checkbox list item: `- [ ] text` or `- [x] text` */
const CHECKBOX_RE = /^\s*-\s*\[([ xX])\]\s*(.+)$/;

// ─── Acceptance Criteria ───────────────────────────────────────────────────

export function parseAcceptanceCriteria(body: string): AcceptanceCriterion[] {
	const section = extractSection(body, AC_HEADER, [
		DOD_HEADER,
		COMMENTS_HEADER,
		NOTES_HEADER,
		FINAL_SUMMARY_HEADER,
		PLAN_HEADER,
	]);
	if (!section) return [];
	return parseCheckboxList(section);
}

export function serializeAcceptanceCriteria(items: AcceptanceCriterion[]): string {
	if (items.length === 0) return "";
	const lines = ["## Acceptance Criteria", ""];
	for (const item of items) {
		const box = item.checked ? "[x]" : "[ ]";
		lines.push(`- ${box} ${item.text}`);
	}
	return lines.join("\n");
}

// ─── Definition of Done ────────────────────────────────────────────────────

export function parseDefinitionOfDone(body: string): DefinitionOfDoneItem[] {
	const section = extractSection(body, DOD_HEADER, [COMMENTS_HEADER, NOTES_HEADER, FINAL_SUMMARY_HEADER, PLAN_HEADER]);
	if (!section) return [];
	return parseCheckboxList(section);
}

export function serializeDefinitionOfDone(items: DefinitionOfDoneItem[]): string {
	if (items.length === 0) return "";
	const lines = ["## Definition of Done", ""];
	for (const item of items) {
		const box = item.checked ? "[x]" : "[ ]";
		lines.push(`- ${box} ${item.text}`);
	}
	return lines.join("\n");
}

// ─── Comments ──────────────────────────────────────────────────────────────

export function parseComments(body: string): TaskComment[] {
	const section = extractSection(body, COMMENTS_HEADER, [NOTES_HEADER, FINAL_SUMMARY_HEADER, PLAN_HEADER]);
	if (!section) return [];
	const comments: TaskComment[] = [];
	const lines = section.split("\n");
	let current: Partial<TaskComment> | null = null;
	let textLines: string[] = [];

	for (const line of lines) {
		const metaMatch = line.match(/^\s*>\s*\*\*(.+?)\s*\((\S+)\)\s*\*\*\s*(.*)?$/);
		if (metaMatch) {
			if (current) {
				comments.push({
					...(current as TaskComment),
					text: textLines.join("\n").trim(),
				});
			}
			current = {
				author: metaMatch[1],
				createdDate: metaMatch[2],
				id: `comment-${comments.length + 1}`,
			};
			textLines = metaMatch[3] ? [metaMatch[3]] : [];
		} else if (line.trim() === "" && current) {
			// blank line separates comment text
		} else if (current) {
			textLines.push(line.replace(/^\s*>\s?/, ""));
		}
	}
	if (current) {
		comments.push({
			...(current as TaskComment),
			text: textLines.join("\n").trim(),
		});
	}
	return comments;
}

export function serializeComments(comments: TaskComment[]): string {
	if (comments.length === 0) return "";
	const lines = ["## Comments", ""];
	for (const c of comments) {
		const date = c.createdDate || new Date().toISOString().slice(0, 10);
		lines.push(`> **${c.author} (${date})** ${c.text}`);
		lines.push("");
	}
	return lines.join("\n");
}

// ─── Free-text sections ────────────────────────────────────────────────────

export function parseFreeTextSection(body: string, headerRe: RegExp, stopHeaders: RegExp[]): string | null {
	const section = extractSection(body, headerRe, stopHeaders);
	return section?.trim() || null;
}

export function serializeFreeTextSection(header: string, content: string | null): string {
	if (!content) return "";
	return `## ${header}\n\n${content.trim()}`;
}

export const SECTION_HEADERS = {
	AC: AC_HEADER,
	DOD: DOD_HEADER,
	COMMENTS: COMMENTS_HEADER,
	NOTES: NOTES_HEADER,
	FINAL_SUMMARY: FINAL_SUMMARY_HEADER,
	PLAN: PLAN_HEADER,
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractSection(body: string, headerRe: RegExp, stopHeaders: RegExp[]): string | null {
	const lines = body.split("\n");
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (headerRe.test(lines[i])) {
			start = i + 1;
			break;
		}
	}
	if (start === -1) return null;

	const sectionLines: string[] = [];
	for (let i = start; i < lines.length; i++) {
		const line = lines[i];
		if (stopHeaders.some(re => re.test(line))) break;
		sectionLines.push(line);
	}
	return sectionLines.join("\n");
}

function parseCheckboxList(text: string): AcceptanceCriterion[] {
	const items: AcceptanceCriterion[] = [];
	for (const line of text.split("\n")) {
		const match = line.match(CHECKBOX_RE);
		if (match) {
			items.push({
				checked: match[1].toLowerCase() === "x",
				text: match[2].trim(),
			});
		}
	}
	return items;
}
