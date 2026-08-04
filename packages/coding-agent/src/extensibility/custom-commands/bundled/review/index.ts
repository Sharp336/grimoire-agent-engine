import { prompt } from "@oh-my-pi/pi-utils";
import type {
	CustomCommand,
	CustomCommandAPI,
	CustomCommandContext,
} from "../../../../extensibility/custom-commands/types";
import reviewCustomRequestTemplate from "../../../../prompts/review-custom-request.md" with { type: "text" };
import reviewHeadlessRequestTemplate from "../../../../prompts/review-headless-request.md" with { type: "text" };
import * as gh from "../../../../tools/gh";
import {
	buildReviewPrompt,
	buildReviewPromptForTarget,
	createPrReviewTarget,
	LOCAL_REVIEW_CHOICES,
	type LocalReviewKind,
	resolveLocalReviewTarget,
	resolveUncommittedReviewTarget,
} from "./shared";

export * from "./shared";

interface ReviewPrRef {
	repo: string;
	number: number;
	raw: string;
	kind: "github-url" | "pr-url";
}

interface ParsedReviewArgs {
	prRef: ReviewPrRef | undefined;
	extraInstructions: string;
}

type ReviewMenuChoice = { kind: "detected-pr"; ref: ReviewPrRef } | { kind: LocalReviewKind } | { kind: "custom" };

export function buildHeadlessReviewPrompt(focus?: string): string {
	return prompt.render(reviewHeadlessRequestTemplate, { focus });
}

function buildCustomReviewPrompt(instructions: string): string {
	return prompt.render(reviewCustomRequestTemplate, { instructions });
}

const REVIEW_CONTEXT_PR_LIMIT = 3;
const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;
const PR_SCHEME_PATTERN = /^pr:\/\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/([1-9]\d*)(?:\/diff(?:\/(?:all|[1-9]\d*))?)?$/;
const PR_REF_TEXT_PATTERN = /https:\/\/github\.com\/[^\s<>"']+|pr:\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[^\s<>"']+/g;

function stripTrailingPrRefPunctuation(text: string): string {
	return text.replace(/[.,)\]>]+$/g, "");
}

function isValidRepoSegment(segment: string | undefined): segment is string {
	return segment !== undefined && REPO_SEGMENT_PATTERN.test(segment);
}

function parsePositivePrNumber(value: string | undefined): number | undefined {
	if (value === undefined || !/^[1-9]\d*$/.test(value)) return undefined;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseGithubPrUrl(text: string): ReviewPrRef | undefined {
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:" || url.hostname !== "github.com") return undefined;
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length < 4 || parts[2] !== "pull") return undefined;
	const [owner, repo, , numberPart] = parts;
	if (!isValidRepoSegment(owner) || !isValidRepoSegment(repo)) return undefined;
	const number = parsePositivePrNumber(numberPart);
	if (number === undefined) return undefined;
	return { repo: `${owner}/${repo}`, number, raw: text, kind: "github-url" };
}

function parsePrSchemeRef(text: string): ReviewPrRef | undefined {
	const match = PR_SCHEME_PATTERN.exec(text);
	if (!match) return undefined;
	const [, owner, repo, numberPart] = match;
	const number = parsePositivePrNumber(numberPart);
	if (number === undefined) return undefined;
	return { repo: `${owner}/${repo}`, number, raw: text, kind: "pr-url" };
}

function parseReviewPrRef(text: string): ReviewPrRef | undefined {
	const candidate = stripTrailingPrRefPunctuation(text);
	return parseGithubPrUrl(candidate) ?? parsePrSchemeRef(candidate);
}

function buildPrLargeDiffInstruction(ref: ReviewPrRef): string {
	const prDiffUrl = `pr://${ref.repo}/${ref.number}/diff`;
	return `MUST read assigned PR file diffs from \`${prDiffUrl}/all\` or per-file \`${prDiffUrl}/<index>\`; NEVER use local \`git diff\`/\`git show\` for PR diff content`;
}

function buildPrContextInstruction(ref: ReviewPrRef): string {
	const prDiffUrl = `pr://${ref.repo}/${ref.number}/diff`;
	return `MUST NOT read local workspace files for PR file context; use the fetched PR diff and \`${prDiffUrl}/all\` or per-file \`${prDiffUrl}/<index>\` only`;
}

function extractReviewPrRefFromArgs(args: string[]): ParsedReviewArgs {
	let prRef: ReviewPrRef | undefined;
	let prRefIndex = -1;
	for (const [index, arg] of args.entries()) {
		const parsed = parseReviewPrRef(arg);
		if (parsed) {
			prRef = parsed;
			prRefIndex = index;
			break;
		}
	}
	return {
		prRef,
		extraInstructions: args.filter((_, index) => index !== prRefIndex).join(" "),
	};
}

function extractReviewPrRefsFromText(text: string): ReviewPrRef[] {
	return Array.from(text.matchAll(PR_REF_TEXT_PATTERN), match => parseReviewPrRef(match[0])).filter(
		(ref): ref is ReviewPrRef => ref !== undefined,
	);
}

async function buildPrReviewPrompt(
	api: CustomCommandAPI,
	ctx: CustomCommandContext,
	ref: ReviewPrRef,
	extraInstructions: string,
): Promise<string | undefined> {
	let diffText: string;
	try {
		const lookup = await gh.getOrFetchPrDiff({ cwd: api.cwd, repo: ref.repo, number: ref.number });
		diffText = lookup.payload.unified;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const failure = `Failed to fetch PR diff for ${ref.repo}#${ref.number}: ${message}`;
		if (ctx.hasUI) {
			ctx.ui.notify(failure, "error");
			return undefined;
		}
		return failure;
	}
	const target = createPrReviewTarget(
		`PR ${ref.repo}#${ref.number}`,
		diffText,
		`PR ${ref.repo}#${ref.number} has no diff content available`,
		{ diffInstruction: buildPrLargeDiffInstruction(ref), contextInstruction: buildPrContextInstruction(ref) },
	);
	const promptText = buildReviewPromptForTarget(
		target,
		ctx.hasUI ? ctx.ui : undefined,
		extraInstructions || undefined,
	);
	if (promptText !== undefined || ctx.hasUI) return promptText;
	return `Unable to review PR ${ref.repo}#${ref.number}: no diff content available.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function getTextContentParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const parts: string[] = [];
	for (const item of content) {
		if (isRecord(item) && item.type === "text" && typeof item.text === "string") parts.push(item.text);
	}
	return parts;
}

function findRecentPrRefs(ctx: CustomCommandContext, limit: number): ReviewPrRef[] {
	const refs: ReviewPrRef[] = [];
	const seen = new Set<string>();
	const entries = ctx.sessionManager.getBranch();
	for (let entryIndex = entries.length - 1; entryIndex >= 0 && refs.length < limit; entryIndex--) {
		const entry = entries[entryIndex];
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant") continue;
		const parts = getTextContentParts(message.content);
		for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
			const partRefs = extractReviewPrRefsFromText(parts[partIndex]!);
			for (let refIndex = partRefs.length - 1; refIndex >= 0; refIndex--) {
				const ref = partRefs[refIndex]!;
				const key = `${ref.repo.toLowerCase()}#${ref.number}`;
				if (seen.has(key)) continue;
				seen.add(key);
				refs.push(ref);
				if (refs.length >= limit) break;
			}
			if (refs.length >= limit) break;
		}
	}
	return refs;
}

export class ReviewCommand implements CustomCommand {
	name = "review";
	description = "Launch interactive code review";

	constructor(private api: CustomCommandAPI) {}

	async execute(args: string[], ctx: CustomCommandContext): Promise<string | undefined> {
		const parsedArgs = extractReviewPrRefFromArgs(args);
		if (parsedArgs.prRef) return buildPrReviewPrompt(this.api, ctx, parsedArgs.prRef, parsedArgs.extraInstructions);
		const extraInstructions = parsedArgs.extraInstructions || undefined;
		if (!ctx.hasUI) return buildHeadlessReviewPrompt(extraInstructions);

		const choices: Array<{ label: string; value: ReviewMenuChoice }> = [
			...findRecentPrRefs(ctx, REVIEW_CONTEXT_PR_LIMIT).map(ref => ({
				label: `Review PR ${ref.repo}#${ref.number} from conversation`,
				value: { kind: "detected-pr" as const, ref },
			})),
			...LOCAL_REVIEW_CHOICES.map(choice => ({ label: choice.label, value: { kind: choice.kind } })),
		];
		if (!extraInstructions) {
			choices.push({ label: "4. Custom review instructions", value: { kind: "custom" } });
		}
		const selected = await ctx.ui.select(
			"Review Mode",
			choices.map(choice => choice.label),
		);
		const selectedChoice = choices.find(choice => choice.label === selected)?.value;
		if (!selectedChoice) return undefined;

		switch (selectedChoice.kind) {
			case "detected-pr":
				return buildPrReviewPrompt(this.api, ctx, selectedChoice.ref, extraInstructions ?? "");
			case "base-branch":
			case "uncommitted":
			case "commit": {
				const target = await resolveLocalReviewTarget(selectedChoice.kind, this.api.cwd, ctx.ui);
				return target ? buildReviewPromptForTarget(target, ctx.ui, extraInstructions) : undefined;
			}
			case "custom": {
				const instructions = await ctx.ui.editor(
					"Enter custom review instructions",
					"Review the following:\n\n",
					undefined,
					{ promptStyle: true },
				);
				if (!instructions?.trim()) return undefined;
				const target = await resolveUncommittedReviewTarget(this.api.cwd).catch(() => undefined);
				if (target?.rawDiff.trim()) {
					return buildReviewPrompt(
						`Custom review: ${instructions.split("\n")[0]!.slice(0, 60)}…`,
						target.snapshot,
						target.rawDiff,
						{ additionalInstructions: instructions, diffInstruction: target.diffInstruction },
					);
				}
				return buildCustomReviewPrompt(instructions);
			}
		}
	}
}

export default ReviewCommand;
