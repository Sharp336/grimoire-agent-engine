/**
 * Markdown serializer for Task Manager entities.
 *
 * Replaces gray-matter's `stringify` with `Bun.YAML.stringify` for frontmatter
 * and manual `---\n${yaml}\n---\n${body}` assembly.
 */

import { YAML } from "bun";
import type { Decision, Document, Milestone, Task, TaskComment } from "../types";
import {
	serializeAcceptanceCriteria,
	serializeComments,
	serializeDefinitionOfDone,
	serializeFreeTextSection,
} from "./structured-sections";

// ─── Task ──────────────────────────────────────────────────────────────────

export function serializeTask(task: Task): string {
	const fm: Record<string, unknown> = {
		id: task.id,
		title: task.title,
		status: task.status,
	};
	if (task.description) fm.description = task.description;
	if (task.assignee) fm.assignee = task.assignee;
	if (task.labels.length > 0) fm.labels = task.labels;
	if (task.priority) fm.priority = task.priority;
	if (task.parentTaskId) fm.parent_task_id = task.parentTaskId;
	if (task.dependencies.length > 0) fm.dependencies = task.dependencies;
	if (task.milestone) fm.milestone = task.milestone;
	if (task.taskPlan) fm.task_plan = task.taskPlan;
	if (task.draft) fm.draft = true;
	if (task.archived) {
		fm.archived = true;
		if (task.archivedAt) fm.archived_date = task.archivedAt;
	}
	if (task.milestoneOrder !== null) fm.milestone_order = task.milestoneOrder;
	fm.created_date = task.createdAt;
	fm.updated_date = task.updatedAt;

	const sections: string[] = [];
	if (task.acceptanceCriteria.length > 0) {
		sections.push(serializeAcceptanceCriteria(task.acceptanceCriteria));
	}
	if (task.definitionOfDone.length > 0) {
		sections.push(serializeDefinitionOfDone(task.definitionOfDone));
	}
	if (task.taskPlan) {
		sections.push(serializeFreeTextSection("Implementation Plan", task.taskPlan));
	}
	if (task.notes) {
		sections.push(serializeFreeTextSection("Notes", task.notes));
	}
	if (task.finalSummary) {
		sections.push(serializeFreeTextSection("Final Summary", task.finalSummary));
	}
	if (task.comments.length > 0) {
		sections.push(serializeComments(task.comments));
	}

	const body = sections.filter(Boolean).join("\n\n");
	return assembleFrontmatter(fm, body);
}

// ─── Decision ──────────────────────────────────────────────────────────────

export function serializeDecision(decision: Decision): string {
	const fm: Record<string, unknown> = {
		id: decision.id,
		title: decision.title,
		status: decision.status,
		context: decision.context,
		decision: decision.decision,
	};
	if (decision.consequences) fm.consequences = decision.consequences;
	if (decision.tags.length > 0) fm.tags = decision.tags;
	fm.created_date = decision.createdAt;
	fm.updated_date = decision.updatedAt;

	return assembleFrontmatter(fm, decision.decision);
}

// ─── Document ───────────────────────────────────────────────────────────────

export function serializeDocument(doc: Document): string {
	const fm: Record<string, unknown> = {
		id: doc.id,
		title: doc.title,
		type: doc.type,
	};
	if (doc.tags.length > 0) fm.tags = doc.tags;
	if (doc.path) fm.path = doc.path;
	fm.created_date = doc.createdAt;
	fm.updated_date = doc.updatedAt;

	return assembleFrontmatter(fm, doc.content);
}

// ─── Milestone ──────────────────────────────────────────────────────────────

export function serializeMilestone(milestone: Milestone): string {
	const fm: Record<string, unknown> = {
		id: milestone.id,
		name: milestone.name,
		status: milestone.status,
	};
	if (milestone.description) fm.description = milestone.description;
	if (milestone.archived) {
		fm.archived = true;
		if (milestone.archivedAt) fm.archived_date = milestone.archivedAt;
	}
	fm.created_date = milestone.createdAt;
	fm.updated_date = milestone.updatedAt;

	return assembleFrontmatter(fm, milestone.description);
}

// ─── Comment (standalone helper for edit --comment) ──────────────────────────

export function makeComment(author: string, text: string): TaskComment {
	return {
		id: `comment-${Date.now()}`,
		author,
		text,
		createdDate: new Date().toISOString().slice(0, 10),
	};
}

// ─── Frontmatter assembly ───────────────────────────────────────────────────

function assembleFrontmatter(fm: Record<string, unknown>, body: string): string {
	const yaml = YAML.stringify(fm, null, 2).trimEnd();
	const trimmedBody = body.trim();
	return `---\n${yaml}\n---\n${trimmedBody ? `\n${trimmedBody}\n` : ""}`;
}
