/**
 * Markdown parser for Task Manager entities.
 *
 * Replaces gray-matter with omp's `parseFrontmatter` from `@oh-my-pi/pi-utils`.
 * Pass `{ normalize: false }` to preserve snake_case keys used by the on-disk
 * format (`created_date`, `parent_task_id`, etc.).
 */

import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { FALLBACK_STATUS } from "../constants";
import type { Decision, Document, Milestone, Task } from "../types";
import {
	parseAcceptanceCriteria,
	parseComments,
	parseDefinitionOfDone,
	parseFreeTextSection,
	SECTION_HEADERS,
} from "./structured-sections";

// ─── Task ──────────────────────────────────────────────────────────────────

export function parseTask(rawContent: string): Task {
	const { frontmatter, body } = parseFrontmatter(rawContent, { normalize: false });

	const fm = frontmatter as Record<string, unknown>;
	const id = str(fm.id) ?? "";
	const title = str(fm.title) ?? "";
	const status = str(fm.status) ?? FALLBACK_STATUS;
	const description = str(fm.description) ?? "";
	const assignee = str(fm.assignee) ?? null;
	const labels = arr(fm.labels);
	const priority = str(fm.priority) ?? null;
	const parentTaskId = str(fm.parent_task_id) ?? null;
	const dependencies = arr(fm.dependencies);
	const createdAt = str(fm.created_date) ?? new Date().toISOString();
	const updatedAt = str(fm.updated_date) ?? createdAt;
	const milestone = str(fm.milestone) ?? null;
	const taskPlan = str(fm.task_plan) ?? null;
	const draft = bool(fm.draft);
	const archived = bool(fm.archived);
	const archivedAt = str(fm.archived_date) ?? null;
	const milestoneOrder = num(fm.milestone_order) ?? null;

	const acceptanceCriteria = parseAcceptanceCriteria(body);
	const definitionOfDone = parseDefinitionOfDone(body);
	const comments = parseComments(body);
	const notes = parseFreeTextSection(body, SECTION_HEADERS.NOTES, [
		SECTION_HEADERS.FINAL_SUMMARY,
		SECTION_HEADERS.PLAN,
	]);
	const finalSummary = parseFreeTextSection(body, SECTION_HEADERS.FINAL_SUMMARY, [SECTION_HEADERS.PLAN]);

	return {
		id,
		title,
		description,
		status,
		assignee,
		labels,
		priority,
		parentTaskId,
		dependencies,
		createdAt,
		updatedAt,
		milestone,
		taskPlan,
		acceptanceCriteria,
		definitionOfDone,
		comments,
		notes,
		finalSummary,
		draft,
		archived,
		archivedAt,
		milestoneOrder,
		rawContent,
		rawFrontmatter: fm,
	};
}

// ─── Decision ──────────────────────────────────────────────────────────────

export function parseDecision(rawContent: string): Decision {
	const { frontmatter, body } = parseFrontmatter(rawContent, { normalize: false });
	const fm = frontmatter as Record<string, unknown>;

	return {
		id: str(fm.id) ?? "",
		title: str(fm.title) ?? "",
		status: str(fm.status) ?? "proposed",
		context: str(fm.context) ?? body.trim(),
		decision: str(fm.decision) ?? "",
		consequences: str(fm.consequences) ?? null,
		createdAt: str(fm.created_date) ?? new Date().toISOString(),
		updatedAt: str(fm.updated_date) ?? str(fm.created_date) ?? new Date().toISOString(),
		tags: arr(fm.tags),
		rawContent,
		rawFrontmatter: fm,
	};
}

// ─── Document ──────────────────────────────────────────────────────────────

export function parseDocument(rawContent: string): Document {
	const { frontmatter, body } = parseFrontmatter(rawContent, { normalize: false });
	const fm = frontmatter as Record<string, unknown>;

	return {
		id: str(fm.id) ?? "",
		title: str(fm.title) ?? "",
		type: str(fm.type) ?? "doc",
		tags: arr(fm.tags),
		path: str(fm.path) ?? null,
		content: body.trim(),
		createdAt: str(fm.created_date) ?? new Date().toISOString(),
		updatedAt: str(fm.updated_date) ?? str(fm.created_date) ?? new Date().toISOString(),
		rawContent,
		rawFrontmatter: fm,
	};
}

// ─── Milestone ─────────────────────────────────────────────────────────────

export function parseMilestone(rawContent: string): Milestone {
	const { frontmatter } = parseFrontmatter(rawContent, { normalize: false });
	const fm = frontmatter as Record<string, unknown>;

	return {
		id: str(fm.id) ?? "",
		name: str(fm.name) ?? "",
		description: str(fm.description) ?? "",
		status: str(fm.status) ?? "active",
		createdAt: str(fm.created_date) ?? new Date().toISOString(),
		updatedAt: str(fm.updated_date) ?? str(fm.created_date) ?? new Date().toISOString(),
		archived: bool(fm.archived),
		archivedAt: str(fm.archived_date) ?? null,
		rawContent,
		rawFrontmatter: fm,
	};
}

// ─── Coercion helpers ───────────────────────────────────────────────────────

function str(v: unknown): string | null {
	if (v === null || v === undefined) return null;
	return String(v);
}

function arr(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	return v.map(String);
}

function bool(v: unknown): boolean {
	return v === true || v === "true";
}

function num(v: unknown): number | null {
	if (v === null || v === undefined) return null;
	const n = Number(v);
	return Number.isNaN(n) ? null : n;
}
