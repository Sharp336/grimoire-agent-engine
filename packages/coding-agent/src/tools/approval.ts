/**
 * Tool approval resolution.
 *
 * Approval policy is declared by each tool. This module only knows how to:
 * - normalize user `tools.approval.<tool>: allow | deny | prompt` overrides and bash command-glob maps,
 * - compare a tool capability tier against the active approval mode,
 * - format the generic approval prompt body.
 */
import type { AgentTool, ToolApprovalDecision, ToolTier } from "@oh-my-pi/pi-agent-core";
import { getBashPolicyCommands } from "./bash-command-normalization";

export type { ToolApproval, ToolApprovalDecision, ToolTier } from "@oh-my-pi/pi-agent-core";

export type ApprovalPolicy = "allow" | "deny" | "prompt";
export type ApprovalMode = "always-ask" | "write" | "yolo";

export interface ApprovalOptions {
	bashStripTrailingHeadTail?: boolean;
}
type ApprovalSubject = Pick<AgentTool, "name" | "approval" | "formatApprovalDetails">;

export interface ResolvedApproval {
	policy: ApprovalPolicy;
	tier: ToolTier;
	reason?: string;
	override: boolean;
	matchedPattern?: string;
}

const POLICY_VALUES: ReadonlySet<ApprovalPolicy> = new Set(["allow", "deny", "prompt"]);
const TIER_VALUES: ReadonlySet<ToolTier> = new Set(["read", "write", "exec"]);

const TIER_RANK: Record<ToolTier, number> = {
	read: 0,
	write: 1,
	exec: 2,
};

const APPROVAL_MODE_MAX_TIER: Record<ApprovalMode, ToolTier> = {
	"always-ask": "read",
	write: "write",
	yolo: "exec",
};

const DEFAULT_PROMPT_TRUNCATE_CHARS = 2000;

/** Best-effort conversion of an arbitrary user-supplied value to a policy. */
function normalizePolicy(value: unknown): ApprovalPolicy | undefined {
	if (typeof value !== "string") return undefined;
	const lowered = value.trim().toLowerCase();
	return POLICY_VALUES.has(lowered as ApprovalPolicy) ? (lowered as ApprovalPolicy) : undefined;
}

function escapeRegExpChar(char: string): string {
	return /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
}

const globMatcherCache = new Map<string, RegExp>();

function getGlobMatcher(pattern: string): RegExp {
	let matcher = globMatcherCache.get(pattern);
	if (matcher) {
		return matcher;
	}

	let source = "^";
	for (const char of pattern) {
		if (char === "*") {
			source += "[\\s\\S]*";
		} else if (char === "?") {
			source += "[\\s\\S]";
		} else {
			source += escapeRegExpChar(char);
		}
	}
	source += "$";
	matcher = new RegExp(source);
	globMatcherCache.set(pattern, matcher);
	return matcher;
}

function globMatches(pattern: string, value: string): boolean {
	return getGlobMatcher(pattern).test(value);
}

function getBashCommands(args: unknown, options: ApprovalOptions): readonly string[] {
	if (!args || typeof args !== "object") return [""];
	const record = args as Record<string, unknown>;
	const command = record.command;
	const cwd = record.cwd;
	return getBashPolicyCommands(
		{
			command: typeof command === "string" ? command : "",
			cwd: typeof cwd === "string" ? cwd : undefined,
		},
		{ stripTrailingHeadTail: options.bashStripTrailingHeadTail },
	);
}
interface UserPolicyResult {
	policy: ApprovalPolicy;
	pattern?: string;
}

function resolveUserPolicy(
	tool: ApprovalSubject,
	args: unknown,
	value: unknown,
	options: ApprovalOptions,
): UserPolicyResult | undefined {
	const policy = normalizePolicy(value);
	if (policy || tool.name !== "bash" || !value || typeof value !== "object" || Array.isArray(value)) {
		return policy ? { policy } : undefined;
	}

	let matched: UserPolicyResult | undefined;
	const commands = getBashCommands(args, options);
	for (const command of commands) {
		let commandMatch: UserPolicyResult | undefined;
		for (const [pattern, candidate] of Object.entries(value as Record<string, unknown>)) {
			const patternPolicy = normalizePolicy(candidate);
			if (patternPolicy && globMatches(pattern, command)) {
				commandMatch = { policy: patternPolicy, pattern };
			}
		}
		matched = commandMatch ?? matched;
	}
	return matched;
}

function isToolTier(value: unknown): value is ToolTier {
	return typeof value === "string" && TIER_VALUES.has(value as ToolTier);
}

function normalizeDecision(value: unknown): Omit<ResolvedApproval, "policy"> {
	if (isToolTier(value)) {
		return { tier: value, override: false };
	}

	if (value && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		const tier = isToolTier(record.tier) ? record.tier : "exec";
		const reason = typeof record.reason === "string" && record.reason.length > 0 ? record.reason : undefined;
		return {
			tier,
			override: record.override === true,
			...(reason ? { reason } : {}),
		};
	}

	return { tier: "exec", override: false };
}

function getToolDecision(tool: ApprovalSubject, args: unknown): Omit<ResolvedApproval, "policy"> {
	const approval = tool.approval;
	const decision: ToolApprovalDecision | undefined = typeof approval === "function" ? approval(args) : approval;
	return normalizeDecision(decision);
}

function modeApprovesTier(mode: ApprovalMode, tier: ToolTier): boolean {
	return TIER_RANK[tier] <= TIER_RANK[APPROVAL_MODE_MAX_TIER[mode]];
}

/**
 * Resolve approval policy for a tool call.
 *
 * Resolution order:
 *  1. Tool `approval(args)` decision, defaulting to tier "exec" when omitted.
 *  2. User per-tool override, if set and valid.
 *  3. Active mode tier comparison.
 *
 * In yolo mode, override-based tool prompts are ignored; user `tools.approval`
 * settings remain authoritative.
 */
export function resolveApproval(
	tool: ApprovalSubject,
	args: unknown,
	mode: ApprovalMode,
	userConfig: Record<string, unknown> = {},
	options: ApprovalOptions = {},
): ResolvedApproval {
	const decision = getToolDecision(tool, args);
	const userResult = Object.hasOwn(userConfig, tool.name)
		? resolveUserPolicy(tool, args, userConfig[tool.name], options)
		: undefined;
	const userPolicy = userResult?.policy;
	const matchedPattern = userResult?.pattern;
	const hasMatchedPattern = matchedPattern !== undefined;

	if (mode === "yolo") {
		return {
			policy: userPolicy ?? "allow",
			tier: decision.tier,
			override: false,
			...(hasMatchedPattern ? { matchedPattern } : {}),
		};
	}

	if (decision.override) {
		if (userPolicy === "deny") {
			return {
				policy: "deny",
				tier: decision.tier,
				override: true,
				...(hasMatchedPattern ? { matchedPattern } : {}),
			};
		}
		return {
			policy: "prompt",
			tier: decision.tier,
			override: true,
			...(decision.reason ? { reason: decision.reason } : {}),
		};
	}

	if (userPolicy) {
		return {
			policy: userPolicy,
			tier: decision.tier,
			override: false,
			...(hasMatchedPattern ? { matchedPattern } : {}),
		};
	}

	if (modeApprovesTier(mode, decision.tier)) {
		return { policy: "allow", tier: decision.tier, override: false };
	}

	return {
		policy: "prompt",
		tier: decision.tier,
		override: false,
		...(decision.reason ? { reason: decision.reason } : {}),
	};
}

/**
 * Check if a tool call requires user approval.
 *
 * @throws Error if policy is 'deny'
 * @returns Object with required flag and optional reason for the prompt
 */
export function requiresApproval(
	tool: ApprovalSubject,
	args: unknown,
	mode: ApprovalMode,
	userConfig: Record<string, unknown> = {},
	options: ApprovalOptions = {},
): { required: boolean; reason?: string } {
	const { policy, reason, matchedPattern } = resolveApproval(tool, args, mode, userConfig, options);

	if (policy === "deny") {
		const fix =
			matchedPattern !== undefined
				? `To allow: remove or update the matching pattern in "tools.approval.${tool.name}" config.`
				: `To allow: remove "tools.approval.${tool.name}: deny" from config.`;
		throw new Error(`Tool "${tool.name}" is blocked by user policy.\n${fix}`);
	}

	if (policy === "prompt") return { required: true, reason };
	return { required: false };
}

export function truncateForPrompt(value: string, maxChars = DEFAULT_PROMPT_TRUNCATE_CHARS): string {
	if (value.length <= maxChars) return value;
	const omitted = value.length - maxChars;
	return `${value.slice(0, maxChars)}… (${omitted} chars truncated)`;
}

/**
 * Format the approval prompt body shown to the user.
 */
export function formatApprovalPrompt(tool: ApprovalSubject, args: unknown, reason?: string): string {
	const lines = [`Allow tool: ${tool.name}`];

	if (tool.name.startsWith("mcp__") && tool.approval === undefined) {
		lines.push("Origin: MCP server tool");
	}

	if (reason) {
		lines.push(`Reason: ${reason}`);
	}

	const details = tool.formatApprovalDetails?.(args);
	if (typeof details === "string") {
		if (details.length > 0) lines.push(details);
	} else if (Array.isArray(details)) {
		for (const detail of details) {
			if (detail.length > 0) lines.push(detail);
		}
	}

	return lines.join("\n");
}
