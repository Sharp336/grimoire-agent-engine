import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, ApiKey, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { completeSimple, validateToolCall } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { toReasoningEffort } from "../thinking";
import quickSystemPrompt from "./prompts/quick-system.md" with { type: "text" };
import quickUserPrompt from "./prompts/quick-user.md" with { type: "text" };
import { extractToolCall } from "./utils";

const quickCommitSchema = type({
	files: "string[]",
	subject: "string",
	body: "string",
	branch_type: "string",
	branch_scope: type("string").or("null"),
});

const quickCommitPlanSchema = type({
	commits: quickCommitSchema.array(),
});

const QuickCommitPlanTool = {
	name: "propose_quick_commit_plan",
	description: "Return the complete whole-file commit plan for the provided staged diff.",
	parameters: quickCommitPlanSchema,
};

export interface QuickCommitPlanItem {
	files: string[];
	message: string;
	body: string;
	branchType: string;
	branchScope: string | null;
}

export interface QuickCommitPlan {
	commits: QuickCommitPlanItem[];
}

export interface GenerateQuickCommitPlanInput {
	model: Model<Api>;
	apiKey: ApiKey;
	thinkingLevel?: ThinkingLevel;
	splitMode: "on" | "off" | "auto";
	messageFormat: "conventional" | "freeform" | "user-submitted";
	messageInstructions: string;
	files: string[];
	stat: string;
	numstat: string;
	recentCommits: string[];
	diff: string;
}

const MIN_PLAN_OUTPUT_TOKENS = 2000;
const MAX_PLAN_OUTPUT_TOKENS = 8000;
// Headroom for subjects/bodies/branch metadata across all commits, on top of
// the file-list echo below.
const PLAN_CONTENT_TOKENS = 1200;

/**
 * The schema requires every staged path to appear in exactly one commit's
 * `files` array, so worst case the tool call echoes the complete staged file
 * list once (plus JSON quoting/array overhead) before a single subject or
 * body byte. A fixed 2000-token budget truncates the tool call for large
 * staged sets (bulk renames, generated-file updates) well before content is
 * actually the bottleneck. Only `input.files` is known at request time — the
 * plan (and its commit count) is the model's *output*, not an input here.
 */
function estimatePlanOutputTokens(files: readonly string[]): number {
	const pathChars = files.reduce((sum, file) => sum + file.length + 4, 0); // + quotes/comma overhead
	const pathTokens = Math.ceil(pathChars / 3.5); // conservative chars-per-token for path-like text
	const required = pathTokens + PLAN_CONTENT_TOKENS;
	if (required > MAX_PLAN_OUTPUT_TOKENS) {
		throw new Error(
			`Staged file list is too large for a single commit plan (${files.length} files, ~${required} output tokens needed, cap is ${MAX_PLAN_OUTPUT_TOKENS}). Commit in smaller batches.`,
		);
	}
	return Math.max(MIN_PLAN_OUTPUT_TOKENS, required);
}

export async function generateQuickCommitPlan(input: GenerateQuickCommitPlanInput): Promise<QuickCommitPlan> {
	const systemPrompt = prompt.render(quickSystemPrompt, {
		split_mode: input.splitMode,
		message_format: input.messageFormat,
		message_instructions:
			input.messageFormat === "user-submitted" ? input.messageInstructions.trim() || undefined : undefined,
	});
	const userPrompt = prompt.render(quickUserPrompt, {
		files: input.files.join("\n"),
		stat: input.stat,
		numstat: input.numstat,
		recent_commits: input.recentCommits.join("\n"),
		diff: input.diff,
	});
	const response = await completeSimple(
		input.model,
		{
			systemPrompt: [systemPrompt],
			messages: [{ role: "user", content: userPrompt, timestamp: Date.now() }],
			tools: [QuickCommitPlanTool],
		},
		{
			apiKey: input.apiKey,
			maxTokens: estimatePlanOutputTokens(input.files),
			reasoning: toReasoningEffort(input.thinkingLevel),
		},
	);
	return parseQuickCommitPlan(response);
}

function parseQuickCommitPlan(message: AssistantMessage): QuickCommitPlan {
	const toolCall = extractToolCall(message, QuickCommitPlanTool.name);
	if (!toolCall) throw new Error("Commit planner did not return a commit plan.");
	const parsed = validateToolCall([QuickCommitPlanTool], toolCall) as typeof quickCommitPlanSchema.infer;
	return {
		commits: parsed.commits.map(commit => {
			const subject = commit.subject.trim();
			if (/[\r\n]/.test(subject)) {
				throw new Error(`Commit planner returned a multiline commit subject: ${subject.split("\n", 1)[0]}`);
			}
			return {
				files: commit.files,
				message: formatQuickCommitMessage(subject, commit.body),
				body: commit.body.trim(),
				branchType: commit.branch_type.trim(),
				branchScope: commit.branch_scope?.trim() || null,
			};
		}),
	};
}

export function formatQuickCommitMessage(subject: string, body: string): string {
	const normalizedSubject = subject.trim();
	const normalizedBody = body.trim();
	if (!normalizedSubject || !normalizedBody) return normalizedSubject;
	return `${normalizedSubject}\n\n${normalizedBody}`;
}
