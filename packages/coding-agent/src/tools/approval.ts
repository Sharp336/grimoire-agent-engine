/**
 * Tool approval policies for safe mode.
 *
 * Implements VSCode-style per-tool approval with:
 * - Built-in defaults (read-only tools auto-allowed, destructive tools require approval)
 * - User allowlist via config (tools.approval.<toolName>: allow|deny|prompt)
 * - Action-based exceptions (tool-level policy can be overridden for specific actions)
 * - CLI override (--auto-approve bypasses all prompts)
 */

export type ApprovalPolicy = "allow" | "deny" | "prompt";

/**
 * Type guard for ApprovalPolicy values.
 * Use this to validate user config at runtime.
 */
export function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
	return value === "allow" || value === "deny" || value === "prompt";
}

/**
 * Action-based exception rule.
 * Allows fine-grained control over tool behavior based on input parameters.
 */
export interface ActionException {
	/** Check if this exception applies to the given input */
	matches: (input: unknown) => boolean;
	/** Policy to apply when matched */
	policy: ApprovalPolicy;
	/** If true, this exception overrides user config (for safety) */
	override?: boolean;
	/** Human-readable reason for the exception */
	reason?: string;
}

/**
 * Built-in tool default policies.
 *
 * Read-only tools are auto-allowed.
 * Destructive/execution tools require approval.
 * External/custom tools default to prompt.
 */
export const DEFAULT_APPROVAL_POLICIES: Record<string, ApprovalPolicy> = {
	// Read-only tools - auto-allow
	read: "allow",
	find: "allow",
	search: "allow",
	ast_grep: "allow",
	web_search: "allow",
	recall: "allow",
	inspect_image: "allow",
	job: "allow", // Polling/status check

	// Tools with action-based exceptions
	lsp: "prompt", // Default: prompt, but readonly actions exempted (see ACTION_EXCEPTIONS)
	bash: "prompt", // Default: prompt, critical patterns override even user "allow" (see ACTION_EXCEPTIONS)

	// Destructive tools - require approval
	write: "prompt",
	edit: "prompt",
	ast_edit: "prompt",
	debug: "prompt",
	browser: "prompt",
	task: "prompt",
	eval: "prompt",
	ssh: "prompt",
	retain: "prompt", // Writes to hindsight store
	checkpoint: "prompt", // Creates snapshots
	rewind: "prompt", // Restores snapshots

	// Interactive/meta tools - auto-allow
	ask: "allow",
	todo_write: "allow", // Internal state only
	irc: "allow", // Inter-agent messaging
	yield: "allow", // Completion signal
	resolve: "allow", // Approval confirmation

	// Default for unknown/external tools
	_default: "prompt",
};

/**
 * Bash patterns that ALWAYS trigger approval prompt even if bash is allowed.
 * These are extremely dangerous operations that should never auto-execute.
 */
export const CRITICAL_BASH_PATTERNS = [
	/rm\s+-rf\s+\//i, // rm -rf / or /path
	/sudo\s+rm/i, // sudo rm
	/:\(\)\s*\{\s*:\|:/i, // fork bomb (handles spacing variants like ":() { :|:")
	/>\s*\/dev\/sd/i, // write to disk device
	/mkfs/i, // format filesystem
	/dd\s+if=/i, // dd operations
	/curl\s+.*\|\s*(bash|sh)/i, // curl | bash
	/wget\s+.*\|\s*(bash|sh)/i, // wget | bash
] as const;

/**
 * LSP actions that are read-only.
 * Actions not in this list (rename, code_actions, reload) will require approval.
 */
export const LSP_READONLY_ACTIONS = new Set([
	"diagnostics",
	"definition",
	"type_definition",
	"implementation",
	"references",
	"hover",
	"symbols",
	"status",
	"capabilities",
]);

/**
 * Action-based exception rules.
 *
 * These rules allow fine-grained control over tool approval based on input parameters.
 * Rules are evaluated in order; first match wins.
 *
 * Use cases:
 * - LSP: exempt read-only actions from prompting (performance)
 * - Bash: force prompts for dangerous patterns (safety override)
 * - Future: debug tool "read" vs "step" actions, eval "display" vs "execute" contexts
 */
export const ACTION_EXCEPTIONS: Record<string, ActionException[]> = {
	lsp: [
		{
			// Exempt read-only LSP actions from prompting
			matches: (input: unknown) => {
				const action = String((input as any)?.action ?? "");
				return LSP_READONLY_ACTIONS.has(action);
			},
			policy: "allow",
			override: false, // User can still set "lsp: prompt" to require all actions
		},
	],
	bash: [
		{
			// Force prompt for critical patterns, even if user allowlisted bash
			matches: (input: unknown) => {
				const cmd = String((input as any)?.command ?? "");
				return CRITICAL_BASH_PATTERNS.some(p => p.test(cmd));
			},
			policy: "prompt",
			override: true, // Safety: cannot be bypassed by user config
			reason: "Critical pattern detected",
		},
	],
};

/**
 * Resolve approval policy for a tool.
 *
 * Resolution order:
 * 1. Action exceptions with override=true (safety rules)
 * 2. User config for specific tool
 * 3. Action exceptions with override=false (performance optimizations)
 * 4. Built-in default for tool
 * 5. User's _default override
 * 6. System _default (prompt)
 */
export function getApprovalPolicy(
	toolName: string,
	input: unknown,
	userConfig: Record<string, ApprovalPolicy> = {},
): { policy: ApprovalPolicy; reason?: string } {
	// 1. Check overriding exceptions first (safety rules)
	const exceptions = ACTION_EXCEPTIONS[toolName] ?? [];
	for (const exception of exceptions) {
		if (exception.override && exception.matches(input)) {
			return { policy: exception.policy, reason: exception.reason };
		}
	}

	// 2. Check user config for specific tool
	if (toolName in userConfig) {
		const userPolicy = userConfig[toolName];
		if (!isApprovalPolicy(userPolicy)) {
			// Invalid value: fail closed with warning
			console.warn(
				`Invalid approval policy "${userPolicy}" for tool "${toolName}". ` +
				`Expected "allow", "deny", or "prompt". Defaulting to "prompt".`,
			);
			return { policy: "prompt", reason: "Invalid policy value in config" };
		}
		return { policy: userPolicy };
	}

	// 3. Check non-overriding exceptions (performance optimizations)
	for (const exception of exceptions) {
		if (!exception.override && exception.matches(input)) {
			return { policy: exception.policy, reason: exception.reason };
		}
	}

	// 4. Check built-in default for tool
	if (toolName in DEFAULT_APPROVAL_POLICIES) {
		return { policy: DEFAULT_APPROVAL_POLICIES[toolName] };
	}

	// 5. Check user's _default override
	if ("_default" in userConfig) {
		const defaultPolicy = userConfig._default;
		if (!isApprovalPolicy(defaultPolicy)) {
			console.warn(
				`Invalid approval policy "${defaultPolicy}" for _default. ` +
				`Expected "allow", "deny", or "prompt". Defaulting to "prompt".`,
			);
			return { policy: "prompt", reason: "Invalid _default policy in config" };
		}
		return { policy: defaultPolicy };
	}

	// 6. System-wide fallback
	return { policy: DEFAULT_APPROVAL_POLICIES._default };
}

/**
 * Check if a tool call requires user approval.
 *
 * @throws Error if policy is 'deny'
 * @returns Object with required flag and optional reason for the prompt
 */
export function requiresApproval(
	toolName: string,
	input: unknown,
	userConfig: Record<string, ApprovalPolicy> = {},
): { required: boolean; reason?: string } {
	const { policy, reason } = getApprovalPolicy(toolName, input, userConfig);

	// Explicit deny - throw immediately
	if (policy === "deny") {
		throw new Error(
			`Tool "${toolName}" is blocked by user policy.\n` +
				`To allow: remove "tools.approval.${toolName}: deny" from config.`,
		);
	}

	// Prompt required
	if (policy === "prompt") {
		return { required: true, reason };
	}

	// Allow - only remaining valid case after validation
	if (policy === "allow") {
		return { required: false };
	}

	// This should never happen due to validation in getApprovalPolicy,
	// but fail closed if it somehow does
	console.warn(`Unexpected approval policy "${policy}" for tool "${toolName}". Failing closed.`);
	return { required: true, reason: "Unexpected policy value" };
}
}

/**
 * Format tool call details for approval prompt.
 */
export function formatApprovalPrompt(toolName: string, input: unknown, reason?: string): string {
	const parts: string[] = [`Allow tool: ${toolName}`];

	if (reason) {
		parts.push(`Reason: ${reason}`);
	}

	// Tool-specific formatting
	const inputObj = input as any;

	if (toolName === "bash" && inputObj?.command) {
		parts.push(`Command: ${inputObj.command}`);
	} else if (toolName === "write" && inputObj?.path) {
		parts.push(`Path: ${inputObj.path}`);
	} else if (toolName === "edit" && inputObj?.input) {
		const match = inputObj.input.match(/@([^\n]+)/);
		if (match) parts.push(`File: ${match[1]}`);
	} else if (toolName === "lsp" && inputObj?.action) {
		parts.push(`Action: ${inputObj.action}`);
		if (inputObj.file) parts.push(`File: ${inputObj.file}`);
	}

	return parts.join("\n");
}
