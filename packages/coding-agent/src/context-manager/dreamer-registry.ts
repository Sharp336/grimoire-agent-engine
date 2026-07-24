import type { SettingPath } from "../config/settings";
import classifyMemoriesInstructions from "../prompts/context-manager/dream-classify-memories.md" with { type: "text" };
import curateInstructions from "../prompts/context-manager/dream-curate.md" with { type: "text" };
import evaluateSmartNotesInstructions from "../prompts/context-manager/dream-evaluate-smart-notes.md" with {
	type: "text",
};
import maintainDocsInstructions from "../prompts/context-manager/dream-maintain-docs.md" with { type: "text" };
import mapMemoriesInstructions from "../prompts/context-manager/dream-map-memories.md" with { type: "text" };
import promotePrimersInstructions from "../prompts/context-manager/dream-promote-primers.md" with { type: "text" };
import refreshPrimersInstructions from "../prompts/context-manager/dream-refresh-primers.md" with { type: "text" };
import retrospectiveInstructions from "../prompts/context-manager/dream-retrospective.md" with { type: "text" };
import reviewUserMemoriesInstructions from "../prompts/context-manager/dream-review-user-memories.md" with {
	type: "text",
};
import verifyInstructions from "../prompts/context-manager/dream-verify.md" with { type: "text" };
import verifyBroadInstructions from "../prompts/context-manager/dream-verify-broad.md" with { type: "text" };

export const CONTEXT_DREAM_TASK_NAMES = [
	"map-memories",
	"verify",
	"verify-broad",
	"curate",
	"classify-memories",
	"retrospective",
	"maintain-docs",
	"promote-primers",
	"refresh-primers",
	"evaluate-smart-notes",
	"review-user-memories",
] as const;

export type ContextDreamTaskName = (typeof CONTEXT_DREAM_TASK_NAMES)[number];
export type ContextDreamLeaseDomain = "memory-maintenance" | "docs" | "smart-notes" | "user-profile";

export interface ContextDreamTaskDefinition {
	readonly name: ContextDreamTaskName;
	readonly domain: ContextDreamLeaseDomain;
	readonly schedulePath: SettingPath;
	readonly modelPath: SettingPath;
	readonly timeoutPath: SettingPath;
	readonly activity: "project-memory" | "user-memory" | "session-facts" | "messages" | "notes" | "docs";
	readonly instructions: string;
	readonly toolNames: readonly string[];
	readonly needsMemory: boolean;
}

export const CONTEXT_DREAM_TASKS: Readonly<Record<ContextDreamTaskName, ContextDreamTaskDefinition>> = {
	"map-memories": {
		name: "map-memories",
		domain: "memory-maintenance",
		schedulePath: "contextManager.dreamer.tasks.map-memories.schedule",
		modelPath: "contextManager.dreamer.tasks.map-memories.model",
		timeoutPath: "contextManager.dreamer.tasks.map-memories.timeoutMinutes",
		activity: "project-memory",
		instructions: mapMemoriesInstructions,
		toolNames: ["read", "grep", "glob"],
		needsMemory: true,
	},
	verify: {
		name: "verify",
		domain: "memory-maintenance",
		schedulePath: "contextManager.dreamer.tasks.verify.schedule",
		modelPath: "contextManager.dreamer.tasks.verify.model",
		timeoutPath: "contextManager.dreamer.tasks.verify.timeoutMinutes",
		activity: "project-memory",
		instructions: verifyInstructions,
		toolNames: ["read", "grep", "glob"],
		needsMemory: true,
	},
	"verify-broad": {
		name: "verify-broad",
		domain: "memory-maintenance",
		schedulePath: "contextManager.dreamer.tasks.verify-broad.schedule",
		modelPath: "contextManager.dreamer.tasks.verify-broad.model",
		timeoutPath: "contextManager.dreamer.tasks.verify-broad.timeoutMinutes",
		activity: "project-memory",
		instructions: verifyBroadInstructions,
		toolNames: ["read", "grep", "glob"],
		needsMemory: true,
	},
	curate: {
		name: "curate",
		domain: "memory-maintenance",
		schedulePath: "contextManager.dreamer.tasks.curate.schedule",
		modelPath: "contextManager.dreamer.tasks.curate.model",
		timeoutPath: "contextManager.dreamer.tasks.curate.timeoutMinutes",
		activity: "project-memory",
		instructions: curateInstructions,
		toolNames: [],
		needsMemory: true,
	},
	"classify-memories": {
		name: "classify-memories",
		domain: "memory-maintenance",
		schedulePath: "contextManager.dreamer.tasks.classify-memories.schedule",
		modelPath: "contextManager.dreamer.tasks.classify-memories.model",
		timeoutPath: "contextManager.dreamer.tasks.classify-memories.timeoutMinutes",
		activity: "project-memory",
		instructions: classifyMemoriesInstructions,
		toolNames: [],
		needsMemory: true,
	},
	retrospective: {
		name: "retrospective",
		domain: "memory-maintenance",
		schedulePath: "contextManager.dreamer.tasks.retrospective.schedule",
		modelPath: "contextManager.dreamer.tasks.retrospective.model",
		timeoutPath: "contextManager.dreamer.tasks.retrospective.timeoutMinutes",
		activity: "messages",
		instructions: retrospectiveInstructions,
		toolNames: [],
		needsMemory: true,
	},
	"maintain-docs": {
		name: "maintain-docs",
		domain: "docs",
		schedulePath: "contextManager.dreamer.tasks.maintain-docs.schedule",
		modelPath: "contextManager.dreamer.tasks.maintain-docs.model",
		timeoutPath: "contextManager.dreamer.tasks.maintain-docs.timeoutMinutes",
		activity: "docs",
		instructions: maintainDocsInstructions,
		toolNames: ["read", "grep", "glob", "write", "edit"],
		needsMemory: false,
	},
	"promote-primers": {
		name: "promote-primers",
		domain: "user-profile",
		schedulePath: "contextManager.dreamer.tasks.promote-primers.schedule",
		modelPath: "contextManager.dreamer.tasks.promote-primers.model",
		timeoutPath: "contextManager.dreamer.tasks.promote-primers.timeoutMinutes",
		activity: "messages",
		instructions: promotePrimersInstructions,
		toolNames: [],
		needsMemory: true,
	},
	"refresh-primers": {
		name: "refresh-primers",
		domain: "user-profile",
		schedulePath: "contextManager.dreamer.tasks.refresh-primers.schedule",
		modelPath: "contextManager.dreamer.tasks.refresh-primers.model",
		timeoutPath: "contextManager.dreamer.tasks.refresh-primers.timeoutMinutes",
		activity: "user-memory",
		instructions: refreshPrimersInstructions,
		toolNames: ["ctx_search", "read", "grep", "glob"],
		needsMemory: true,
	},
	"evaluate-smart-notes": {
		name: "evaluate-smart-notes",
		domain: "smart-notes",
		schedulePath: "contextManager.dreamer.tasks.evaluate-smart-notes.schedule",
		modelPath: "contextManager.dreamer.tasks.evaluate-smart-notes.model",
		timeoutPath: "contextManager.dreamer.tasks.evaluate-smart-notes.timeoutMinutes",
		activity: "notes",
		instructions: evaluateSmartNotesInstructions,
		toolNames: ["ctx_search"],
		needsMemory: false,
	},
	"review-user-memories": {
		name: "review-user-memories",
		domain: "user-profile",
		schedulePath: "contextManager.dreamer.tasks.review-user-memories.schedule",
		modelPath: "contextManager.dreamer.tasks.review-user-memories.model",
		timeoutPath: "contextManager.dreamer.tasks.review-user-memories.timeoutMinutes",
		activity: "session-facts",
		instructions: reviewUserMemoriesInstructions,
		toolNames: [],
		needsMemory: true,
	},
};

export function isContextDreamTaskName(value: string): value is ContextDreamTaskName {
	return value in CONTEXT_DREAM_TASKS;
}
