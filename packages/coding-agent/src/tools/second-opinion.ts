import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import { type Api, completeSimple, Effort, getSupportedEfforts, type Model, type Tool } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import * as z from "zod/v4";
import { extractTextContent, extractToolCall, parseJsonPayload } from "../commit/utils";
import { getModelSeries } from "../config/model-equivalence";
import { expandRoleAlias, formatModelString, resolveModelFromString } from "../config/model-resolver";
import secondOpinionDescription from "../prompts/tools/second-opinion.md" with { type: "text" };
import secondOpinionSystemPrompt from "../prompts/tools/second-opinion-system.md" with { type: "text" };
import type { SessionEntry } from "../session/session-manager";
import type { ToolSession } from "./index";
import { ToolError } from "./tool-errors";

/** Settings keys that back the reviewer selection and one-time disclosures. */
const REVIEWER_ROLE = "secondopinion";
const FINGERPRINT_KEY = "secondOpinion.lastPickerFingerprint" as const;
const CONSENTED_KEY = "secondOpinion.consented" as const;
/** Role alias resolving to the configured slow/thinking model. */
const SLOW_ROLE_PATTERN = "pi/slow";
/** Forced tool name used to coerce a structured verdict out of the reviewer. */
const VERDICT_TOOL_NAME = "submit_review";

const DEFAULT_FOCUS =
	"Independently review the assistant's most recent findings, plan, and code for correctness errors, " +
	"missed edge cases, faulty reasoning, and unstated assumptions. Be adversarial; do not rubber-stamp.";

/** Soft cap on transcript characters fed to the reviewer (keeps the newest turns). */
const CHAR_BUDGET = 48_000;
/** Per-tool-result truncation so a single noisy result cannot dominate the budget. */
const TOOL_RESULT_TRUNC = 400;

export const SECOND_OPINION_VERDICTS = ["SOUND", "SOUND_WITH_CAVEATS", "FLAWED"] as const;
export type SecondOpinionVerdict = (typeof SECOND_OPINION_VERDICTS)[number];

const verdictSchema = z
	.object({
		verdict: z
			.enum(SECOND_OPINION_VERDICTS)
			.describe("Overall judgement of the reviewed work after independent scrutiny."),
		review: z
			.string()
			.describe(
				"The full review: specific findings, bugs, weak reasoning, and what (if anything) is actually fine.",
			),
	})
	.strict();

const secondOpinionSchema = z
	.object({
		focus: z
			.string()
			.optional()
			.describe(
				"What the reviewer should scrutinize / the specific question. Omit for a general adversarial review.",
			),
		model: z
			.string()
			.optional()
			.describe(
				'Explicit reviewer selector ("provider/id", "id", or substring). Bypasses the configured role and the picker.',
			),
		effort: z
			.enum(["off", "low", "medium", "high"])
			.default("medium")
			.describe("Reviewer reasoning effort (clamped to what the model supports)."),
		lookback: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Limit to the N most recent message turns. Omit to include all that fit the context budget."),
	})
	.strict();

export type SecondOpinionParams = z.infer<typeof secondOpinionSchema>;
type EffortLevel = SecondOpinionParams["effort"];

/** How the reviewer model was chosen, surfaced in tool details. */
export type ReviewerSource = "explicit" | "configured" | "slow" | "fallback";

export interface SecondOpinionToolDetails {
	verdict?: SecondOpinionVerdict;
	reviewerModel: string;
	sessionModel?: string;
	source: ReviewerSource;
	entriesIncluded: number;
	transcriptChars: number;
	effort: EffortLevel;
	sameFamily: boolean;
	structured: boolean;
}

// ── Pure helpers (exported for unit tests) ──────────────────────────────────

/** Compact fingerprint of the model *families* the picker depends on, plus the
 *  confirmed reviewer. Family-based so point releases don't trigger a re-prompt. */
export interface PickerFingerprint {
	sessionFamily: string | null;
	slowFamily: string | null;
	confirmedReviewer: string | null;
}

export function encodeFingerprint(fp: PickerFingerprint): string {
	return JSON.stringify(fp);
}

export function decodeFingerprint(value: string | undefined): PickerFingerprint | undefined {
	if (!value) return undefined;
	try {
		const parsed = JSON.parse(value) as Partial<PickerFingerprint>;
		return {
			sessionFamily: parsed.sessionFamily ?? null,
			slowFamily: parsed.slowFamily ?? null,
			confirmedReviewer: parsed.confirmedReviewer ?? null,
		};
	} catch {
		return undefined;
	}
}

export interface PickerDecisionInput {
	fingerprint: PickerFingerprint | undefined;
	sessionFamily: string | null;
	slowFamily: string | null;
}

/**
 * Fire the picker only when user input is genuinely needed: the first run (no
 * fingerprint), or when the session/slow model *family* has changed since the
 * last confirmation. An out-of-band reviewer edit is adopted silently elsewhere,
 * not surfaced here.
 */
export function shouldShowPicker(input: PickerDecisionInput): boolean {
	if (!input.fingerprint) return true;
	if (input.fingerprint.sessionFamily !== input.sessionFamily) return true;
	return input.fingerprint.slowFamily !== input.slowFamily;
}

/**
 * Resolve the default reviewer when none is explicitly requested. Prefers a
 * configured role, then the slow model *if it is cross-family* with the session,
 * then any available cross-family model, then slow, then anything available.
 */
export function resolveDefaultReviewer(args: {
	configuredModel: Model<Api> | undefined;
	slowModel: Model<Api> | undefined;
	sessionModel: Model<Api> | undefined;
	available: Model<Api>[];
	familyOf: (model: Model<Api>) => string;
}): { model: Model<Api>; source: ReviewerSource } | undefined {
	const { configuredModel, slowModel, sessionModel, available, familyOf } = args;
	if (configuredModel) return { model: configuredModel, source: "configured" };
	const sessionFamily = sessionModel ? familyOf(sessionModel) : undefined;
	const crossFamily = sessionFamily ? available.find(m => familyOf(m) !== sessionFamily) : undefined;
	if (slowModel) {
		if (!sessionFamily || familyOf(slowModel) !== sessionFamily) return { model: slowModel, source: "slow" };
		if (crossFamily) return { model: crossFamily, source: "fallback" };
		return { model: slowModel, source: "slow" };
	}
	const fallback = crossFamily ?? available[0];
	return fallback ? { model: fallback, source: "fallback" } : undefined;
}

/** Flatten message/content into plain text. Tool calls become markers; thinking/images dropped. */
export function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: string; name?: string };
		if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		else if (b.type === "toolCall" && b.name) parts.push(`[tool call: ${b.name}]`);
	}
	return parts.join("\n");
}

function roleLabel(role: string): string {
	switch (role) {
		case "user":
			return "USER";
		case "assistant":
			return "ASSISTANT";
		case "developer":
			return "DEVELOPER";
		case "tool":
			return "TOOL RESULT";
		default:
			return role.toUpperCase();
	}
}

interface RenderedTurn {
	role: string;
	text: string;
}

/** Render a single session entry into a transcript turn, or null to skip it. */
export function renderEntry(entry: SessionEntry): RenderedTurn | null {
	if (entry.type === "message") {
		const msg = entry.message as { role?: string; content?: unknown; toolName?: string };
		if (typeof msg.role !== "string") return null;
		if (msg.role === "toolResult") {
			const raw = textFromContent(msg.content);
			if (!raw.trim()) return null;
			const trunc = raw.length > TOOL_RESULT_TRUNC ? `${raw.slice(0, TOOL_RESULT_TRUNC)} …[truncated]` : raw;
			return { role: "tool", text: `[${msg.toolName ?? "tool"}] ${trunc}` };
		}
		const text = textFromContent(msg.content);
		if (!text.trim()) return null;
		return { role: msg.role, text };
	}
	if (entry.type === "custom_message") {
		const text = textFromContent(entry.content);
		if (!text.trim()) return null;
		return { role: `note:${entry.customType ?? "custom"}`, text };
	}
	return null;
}

/**
 * Build a transcript from session entries (current branch path-from-leaf),
 * keeping the most recent within the char budget. `lookback` counts rendered
 * message turns, not raw entries.
 */
export function buildTranscript(entries: SessionEntry[], lookback?: number): { text: string; count: number } {
	const rendered: RenderedTurn[] = [];
	for (const entry of entries) {
		const turn = renderEntry(entry);
		if (turn) rendered.push(turn);
	}
	const scoped = typeof lookback === "number" && lookback > 0 ? rendered.slice(-lookback) : rendered;
	const blocks = scoped.map(t => `## ${roleLabel(t.role)}\n${t.text}`);

	const kept: string[] = [];
	let total = 0;
	for (let i = blocks.length - 1; i >= 0; i--) {
		total += blocks[i].length + 2;
		if (total > CHAR_BUDGET && kept.length > 0) break;
		kept.unshift(blocks[i]);
	}
	return { text: kept.join("\n\n"), count: kept.length };
}

/** Clamp a requested effort to what the model actually supports. */
export function clampEffort(model: Model<Api>, level: EffortLevel): Effort | undefined {
	if (level === "off" || !model.reasoning) return undefined;
	const efforts = getSupportedEfforts(model);
	if (!efforts || efforts.length === 0) return undefined;
	const want = level === "low" ? Effort.Low : level === "high" ? Effort.High : Effort.Medium;
	return efforts.includes(want) ? want : efforts[efforts.length - 1];
}

const VERDICT_SCAN: ReadonlyArray<readonly [SecondOpinionVerdict, RegExp]> = [
	["FLAWED", /\bFLAWED\b/i],
	["SOUND_WITH_CAVEATS", /\bSOUND[\s_-]?WITH[\s_-]?CAVEATS\b/i],
	["SOUND", /\bSOUND\b/i],
];

function scanVerdict(text: string): SecondOpinionVerdict | undefined {
	for (const [verdict, pattern] of VERDICT_SCAN) {
		if (pattern.test(text)) return verdict;
	}
	return undefined;
}

/**
 * Extract a structured `{ verdict, review }` from a reviewer response. Prefers
 * the forced tool call, falls back to a JSON payload in the text, then to the
 * raw prose with a keyword-scanned verdict. Never throws — the prose is valuable
 * even when the structure is imperfect.
 */
export function parseVerdict(response: Parameters<typeof extractToolCall>[0]): {
	verdict?: SecondOpinionVerdict;
	review: string;
	structured: boolean;
} {
	const call = extractToolCall(response, VERDICT_TOOL_NAME);
	if (call) {
		const parsed = verdictSchema.safeParse(call.arguments);
		if (parsed.success) return { verdict: parsed.data.verdict, review: parsed.data.review, structured: true };
	}
	const text = extractTextContent(response);
	try {
		const parsed = verdictSchema.safeParse(parseJsonPayload(text));
		if (parsed.success) return { verdict: parsed.data.verdict, review: parsed.data.review, structured: true };
	} catch {
		// fall through to prose handling
	}
	return { verdict: scanVerdict(text), review: text, structured: false };
}

// ── Tool ────────────────────────────────────────────────────────────────────

export class SecondOpinionTool implements AgentTool<typeof secondOpinionSchema, SecondOpinionToolDetails> {
	readonly name = "second_opinion";
	readonly approval = "read" as const;
	readonly label = "Second Opinion";
	readonly loadMode = "discoverable";
	readonly summary = "Get an independent second-opinion review from a different model";
	readonly description: string;
	readonly parameters = secondOpinionSchema;
	readonly strict = false;

	constructor(
		private readonly session: ToolSession,
		private readonly completeImpl: typeof completeSimple = completeSimple,
	) {
		this.description = prompt.render(secondOpinionDescription);
	}

	async execute(
		_toolCallId: string,
		params: SecondOpinionParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SecondOpinionToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<SecondOpinionToolDetails>> {
		if (!context) {
			throw new ToolError("second_opinion requires an active session context.");
		}
		const sessionManager = context.sessionManager;
		if (!sessionManager) {
			throw new ToolError("second_opinion has no session transcript to review.");
		}

		const modelRegistry = this.session.modelRegistry;
		if (!modelRegistry) {
			throw new ToolError("Model registry is unavailable for second_opinion.");
		}
		const available = modelRegistry.getAvailable();
		if (available.length === 0) {
			throw new ToolError("No authenticated models available for second_opinion.");
		}

		const settings = this.session.settings;
		const matchPreferences = { usageOrder: settings.getStorage()?.getModelUsageOrder() };
		const resolvePattern = (pattern: string | undefined): Model<Api> | undefined => {
			if (!pattern) return undefined;
			return resolveModelFromString(expandRoleAlias(pattern, settings), available, matchPreferences, modelRegistry);
		};
		const familyOf = (model: Model<Api>): string =>
			getModelSeries(modelRegistry.getCanonicalId(model) ?? model.id) ?? model.provider.toLowerCase();

		const sessionModel = context.model;
		const slowModel = resolvePattern(SLOW_ROLE_PATTERN);
		const configuredPattern = settings.getModelRole(REVIEWER_ROLE)?.trim() || undefined;
		const configuredModel = configuredPattern ? resolvePattern(configuredPattern) : undefined;

		let reviewer: Model<Api> | undefined;
		let source: ReviewerSource = "fallback";

		const explicit = params.model?.trim();
		if (explicit) {
			reviewer = resolveModelFromString(explicit, available, matchPreferences, modelRegistry);
			if (!reviewer) {
				throw new ToolError(this.#formatModelNotFound(explicit, available));
			}
			source = "explicit";
		} else {
			const sessionFamily = sessionModel ? familyOf(sessionModel) : null;
			const slowFamily = slowModel ? familyOf(slowModel) : null;
			const fingerprint = decodeFingerprint(settings.get(FINGERPRINT_KEY));

			if (shouldShowPicker({ fingerprint, sessionFamily, slowFamily }) && context.hasUI && context.ui) {
				if (!settings.get(CONSENTED_KEY)) {
					const consented = await context.ui.confirm(
						"Second opinion — data disclosure",
						"This sends your full conversation transcript — including tool outputs and any file contents in it — to a " +
							"separate model, which may be a different vendor than your session model. Continue?",
					);
					if (!consented) {
						throw new ToolError("second_opinion cancelled: transcript sharing was declined.");
					}
					settings.set(CONSENTED_KEY, true);
				}
				const picked = await this.#runPicker(
					context,
					available,
					configuredModel ?? slowModel,
					sessionModel,
					familyOf,
				);
				if (picked) {
					reviewer = picked;
					source = "configured";
					settings.setModelRole(REVIEWER_ROLE, formatModelString(picked));
					settings.set(
						FINGERPRINT_KEY,
						encodeFingerprint({ sessionFamily, slowFamily, confirmedReviewer: formatModelString(picked) }),
					);
				}
			}

			if (!reviewer) {
				const resolved = resolveDefaultReviewer({ configuredModel, slowModel, sessionModel, available, familyOf });
				if (!resolved) {
					throw new ToolError("second_opinion could not resolve a reviewer model.");
				}
				reviewer = resolved.model;
				source = resolved.source;
				// Out-of-band adoption: a configured reviewer edited via config/CLI is
				// taken as implicit confirmation — refresh the fingerprint silently so we
				// don't re-prompt on a value the user just chose.
				if (
					configuredModel &&
					fingerprint &&
					fingerprint.confirmedReviewer !== formatModelString(configuredModel)
				) {
					settings.set(
						FINGERPRINT_KEY,
						encodeFingerprint({
							sessionFamily,
							slowFamily,
							confirmedReviewer: formatModelString(configuredModel),
						}),
					);
				}
			}
		}

		const { text: transcript, count } = buildTranscript(sessionManager.getBranch(), params.lookback);
		if (!transcript.trim()) {
			throw new ToolError("second_opinion has no prior conversation context to review.");
		}

		const apiKey = await modelRegistry.getApiKey(reviewer);
		if (!apiKey) {
			throw new ToolError(
				`No API key available for ${formatModelString(reviewer)}. Configure credentials for this provider or choose another reviewer.`,
			);
		}

		const focus = params.focus?.trim() || DEFAULT_FOCUS;
		const userText = `${focus}\n\n---\nPrior conversation transcript (oldest first, most recent last):\n\n${transcript}`;
		const telemetry = resolveTelemetry(this.session.getTelemetry?.(), this.session.getSessionId?.() ?? undefined);
		const tools: Tool[] = [
			{
				name: VERDICT_TOOL_NAME,
				description: "Return your review by calling this tool with the verdict and the full review text.",
				parameters: verdictSchema,
				strict: false,
			},
		];

		const response = await instrumentedCompleteSimple(
			reviewer,
			{
				systemPrompt: [prompt.render(secondOpinionSystemPrompt)],
				messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }],
				tools,
			},
			{
				apiKey,
				signal,
				reasoning: clampEffort(reviewer, params.effort),
				toolChoice: { type: "tool", name: VERDICT_TOOL_NAME },
			},
			{ telemetry, oneshotKind: "second_opinion", completeImpl: this.completeImpl },
		);

		if (response.stopReason === "error") {
			throw new ToolError(response.errorMessage ?? "second_opinion reviewer request failed.");
		}
		if (response.stopReason === "aborted") {
			throw new ToolError("second_opinion review aborted.");
		}

		const { verdict, review, structured } = parseVerdict(response);
		if (!review.trim()) {
			throw new ToolError("second_opinion reviewer returned no review text.");
		}
		const body = verdict ? `${review.trim()}\n\nVerdict: ${verdict}` : review.trim();

		return {
			content: [{ type: "text", text: body }],
			details: {
				verdict,
				reviewerModel: formatModelString(reviewer),
				sessionModel: sessionModel ? formatModelString(sessionModel) : undefined,
				source,
				entriesIncluded: count,
				transcriptChars: transcript.length,
				effort: params.effort,
				sameFamily: sessionModel ? familyOf(reviewer) === familyOf(sessionModel) : false,
				structured,
			},
		};
	}

	/** Interactive reviewer picker. Returns the chosen model, or undefined if cancelled. */
	async #runPicker(
		context: AgentToolContext,
		available: Model<Api>[],
		defaultModel: Model<Api> | undefined,
		sessionModel: Model<Api> | undefined,
		familyOf: (model: Model<Api>) => string,
	): Promise<Model<Api> | undefined> {
		const ui = context.ui;
		if (!ui) return undefined;

		const sessionFamily = sessionModel ? familyOf(sessionModel) : undefined;
		const defaultLabel = defaultModel ? formatModelString(defaultModel) : undefined;
		const byLabel = new Map<string, Model<Api>>();
		const options = available.map(model => {
			const label = formatModelString(model);
			byLabel.set(label, model);
			const tags: string[] = [];
			if (label === defaultLabel) tags.push("default reviewer");
			if (sessionFamily && familyOf(model) === sessionFamily) tags.push("⚠ same family as session — weaker review");
			return tags.length > 0 ? { label, description: tags.join(" · ") } : { label };
		});
		const initialIndex = defaultLabel
			? Math.max(
					0,
					options.findIndex(o => o.label === defaultLabel),
				)
			: 0;

		for (;;) {
			const chosen = await ui.select("Second-opinion reviewer model", options, { initialIndex });
			if (chosen === undefined) return undefined;
			const picked = byLabel.get(chosen);
			if (!picked) return undefined;
			if (sessionFamily && familyOf(picked) === sessionFamily) {
				const ok = await ui.confirm(
					"Same-family reviewer",
					`${formatModelString(picked)} shares the ${familyOf(picked)} family with your session model. ` +
						"Same-family reviews are weaker — they share blind spots. Use it anyway?",
				);
				if (!ok) continue;
			}
			return picked;
		}
	}

	#formatModelNotFound(selector: string, available: Model<Api>[]): string {
		const ids = available.map(formatModelString);
		const hint = ids.length ? `Available include: ${ids.slice(0, 12).join(", ")}` : "No models are available.";
		return `second_opinion: model "${selector}" not found. ${hint}`;
	}
}
