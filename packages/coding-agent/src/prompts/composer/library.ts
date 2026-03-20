/**
 * Collects the guidance library — raw tool docs and system prompt sections
 * that the compiler uses as reference material when composing the system prompt.
 *
 * Prompts are embedded at build time via Bun text imports. Do not read them
 * from the filesystem at runtime; packaged/runtime paths are not stable.
 */

import systemPromptTemplate from "../system/system-prompt.md" with { type: "text" };
import askDescription from "../tools/ask.md" with { type: "text" };
import astEditDescription from "../tools/ast-edit.md" with { type: "text" };
import astGrepDescription from "../tools/ast-grep.md" with { type: "text" };
import asyncResultDescription from "../tools/async-result.md" with { type: "text" };
import awaitDescription from "../tools/await.md" with { type: "text" };
import bashDescription from "../tools/bash.md" with { type: "text" };
import browserDescription from "../tools/browser.md" with { type: "text" };
import calculatorDescription from "../tools/calculator.md" with { type: "text" };
import cancelJobDescription from "../tools/cancel-job.md" with { type: "text" };
import checkpointDescription from "../tools/checkpoint.md" with { type: "text" };
import exitPlanModeDescription from "../tools/exit-plan-mode.md" with { type: "text" };
import fetchDescription from "../tools/fetch.md" with { type: "text" };
import findDescription from "../tools/find.md" with { type: "text" };
import geminiImageDescription from "../tools/gemini-image.md" with { type: "text" };
import grepDescription from "../tools/grep.md" with { type: "text" };
import hashlineDescription from "../tools/hashline.md" with { type: "text" };
import inspectImageDescription from "../tools/inspect-image.md" with { type: "text" };
import inspectImageSystemDescription from "../tools/inspect-image-system.md" with { type: "text" };
import lspDescription from "../tools/lsp.md" with { type: "text" };
import patchDescription from "../tools/patch.md" with { type: "text" };
import pythonDescription from "../tools/python.md" with { type: "text" };
import readDescription from "../tools/read.md" with { type: "text" };
import recallDescription from "../tools/recall.md" with { type: "text" };
import renderMermaidDescription from "../tools/render-mermaid.md" with { type: "text" };
import replaceDescription from "../tools/replace.md" with { type: "text" };
import resolveDescription from "../tools/resolve.md" with { type: "text" };
import rewindDescription from "../tools/rewind.md" with { type: "text" };
import sshDescription from "../tools/ssh.md" with { type: "text" };
import taskDescription from "../tools/task.md" with { type: "text" };
import taskSummaryDescription from "../tools/task-summary.md" with { type: "text" };
import todoDescription from "../tools/todo.md" with { type: "text" };
import todoWriteDescription from "../tools/todo-write.md" with { type: "text" };
import todosDescription from "../tools/todos.md" with { type: "text" };
import webSearchDescription from "../tools/web-search.md" with { type: "text" };
import writeDescription from "../tools/write.md" with { type: "text" };

export interface GuidanceLibrary {
	/** Concatenated tool documentation */
	toolDocs: string;
	/** The current system prompt template (raw, unrendered) */
	systemPromptTemplate: string;
}

const TOOL_DOCS: Array<{ name: string; content: string }> = [
	{ name: "ask", content: askDescription },
	{ name: "async-result", content: asyncResultDescription },
	{ name: "ast-edit", content: astEditDescription },
	{ name: "ast-grep", content: astGrepDescription },
	{ name: "await", content: awaitDescription },
	{ name: "bash", content: bashDescription },
	{ name: "browser", content: browserDescription },
	{ name: "calculator", content: calculatorDescription },
	{ name: "cancel-job", content: cancelJobDescription },
	{ name: "checkpoint", content: checkpointDescription },
	{ name: "exit-plan-mode", content: exitPlanModeDescription },
	{ name: "fetch", content: fetchDescription },
	{ name: "find", content: findDescription },
	{ name: "gemini-image", content: geminiImageDescription },
	{ name: "grep", content: grepDescription },
	{ name: "hashline", content: hashlineDescription },
	{ name: "inspect-image", content: inspectImageDescription },
	{ name: "inspect-image-system", content: inspectImageSystemDescription },
	{ name: "lsp", content: lspDescription },
	{ name: "patch", content: patchDescription },
	{ name: "python", content: pythonDescription },
	{ name: "read", content: readDescription },
	{ name: "recall", content: recallDescription },
	{ name: "render-mermaid", content: renderMermaidDescription },
	{ name: "replace", content: replaceDescription },
	{ name: "resolve", content: resolveDescription },
	{ name: "rewind", content: rewindDescription },
	{ name: "ssh", content: sshDescription },
	{ name: "task", content: taskDescription },
	{ name: "task-summary", content: taskSummaryDescription },
	{ name: "todo", content: todoDescription },
	{ name: "todo-write", content: todoWriteDescription },
	{ name: "todos", content: todosDescription },
	{ name: "web-search", content: webSearchDescription },
	{ name: "write", content: writeDescription },
];

export async function collectGuidanceLibrary(): Promise<GuidanceLibrary> {
	const toolDocs = TOOL_DOCS.map(({ name, content }) => {
		return `### Tool: ${name}\n\n${content.trim()}`;
	}).join("\n\n---\n\n");

	return {
		toolDocs,
		systemPromptTemplate,
	};
}
