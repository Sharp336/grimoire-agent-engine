import type * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Patch } from "@oh-my-pi/hashline";
import type {
	AgentToolResult,
	SpeculativeAuthorization,
	SpeculativeCommitContext,
	SpeculativeCommitDecision,
	SpeculativeDiscardContext,
	SpeculativeExecutionHost,
	SpeculativeOperationContext,
} from "@oh-my-pi/pi-agent-core";
import type { Settings } from "../config/settings";
import { SpeculativePalCommitConflictError } from "../task/worktree";
import type { ToolSession } from "../tools";
import { type ApprovalMode, resolveApproval } from "../tools/approval";

type LocalReadEvidence = {
	path: string;
	device: number;
	inode: number;
	mtimeMs: number;
	size: number;
	digest?: string;
};

type StagedTransactionToken = {
	transaction: {
		verify(): Promise<boolean>;
		restore(): Promise<void>;
	};
};

function isStagedTransactionToken(value: unknown): value is StagedTransactionToken {
	return (
		typeof value === "object" &&
		value !== null &&
		"transaction" in value &&
		typeof (value as StagedTransactionToken).transaction?.verify === "function" &&
		typeof (value as StagedTransactionToken).transaction?.restore === "function"
	);
}

export interface SpeculationLifecycle {
	hasHandlers(eventType: string): boolean;
}

function hasLifecycleHandlers(runner: SpeculationLifecycle): boolean {
	return (
		runner.hasHandlers("tool_call") ||
		runner.hasHandlers("tool_result") ||
		runner.hasHandlers("tool_approval_requested") ||
		runner.hasHandlers("tool_approval_resolved")
	);
}
function sameResourceState(left: nodeFs.Stats, right: nodeFs.Stats): boolean {
	return (
		left.dev === right.dev && left.ino === right.ino && left.mtimeMs === right.mtimeMs && left.size === right.size
	);
}

async function captureEvidence(target: string): Promise<LocalReadEvidence | undefined> {
	try {
		const state = await fs.lstat(target);
		if (state.isSymbolicLink() || (!state.isFile() && !state.isDirectory())) return undefined;
		let digest: string | undefined;
		if (state.isFile()) {
			const hasher = new Bun.CryptoHasher("sha256");
			for await (const chunk of Bun.file(target).stream()) hasher.update(chunk);
			digest = hasher.digest("hex");
			if (!sameResourceState(state, await fs.lstat(target))) return undefined;
		}
		return { path: target, device: state.dev, inode: state.ino, mtimeMs: state.mtimeMs, size: state.size, digest };
	} catch {
		return undefined;
	}
}

function matchesHashlineEditResources(context: SpeculativeOperationContext, cwd: string): boolean {
	if (context.effect.kind !== "reversible_write" || typeof context.args.input !== "string") return false;
	try {
		const patch = Patch.parse(context.args.input, { cwd });
		if (patch.sections.length === 0) return false;
		const targets = new Set<string>();
		for (const section of patch.sections) {
			if (section.path.includes("://") || section.fileOp) return false;
			targets.add(path.resolve(cwd, section.path));
		}
		return (
			context.effect.resources.length === targets.size &&
			context.effect.resources.every(
				resource => resource.scheme === "file" && resource.access === "write" && targets.has(resource.path),
			)
		);
	} catch {
		return false;
	}
}

/** Session-scoped policy boundary for the first production-safe effect: plain local reads. */
export class CodingAgentSpeculativeExecutionHost implements SpeculativeExecutionHost {
	#evidence = new Map<string, LocalReadEvidence>();

	constructor(
		private readonly settings: Settings,
		private readonly toolSession: ToolSession,
		private readonly extensionRunner: SpeculationLifecycle,
	) {}

	async authorize(context: SpeculativeOperationContext): Promise<SpeculativeAuthorization> {
		const directEffect =
			context.source === "direct" &&
			((context.tool.name === "read" && context.effect.kind === "local_read") ||
				((context.tool.name === "write" || context.tool.name === "edit") &&
					context.effect.kind === "reversible_write"));
		const shadowEffect =
			context.source === "eval_shadow" &&
			((context.tool.name === "read" && context.effect.kind === "local_read") ||
				(context.tool.name === "completion" && context.effect.kind === "model_completion"));
		if (!directEffect && !shadowEffect) {
			return { allowed: false, reason: "only plain local reads, eval completions, and PAL writes are eligible" };
		}
		if (hasLifecycleHandlers(this.extensionRunner)) {
			return { allowed: false, reason: "active extension lifecycle handler" };
		}
		const approvalMode = this.settings.get("tools.approvalMode") as ApprovalMode;
		const policies = this.settings.get("tools.approval") as Record<string, unknown>;
		const approval = resolveApproval(context.tool, context.args, approvalMode, policies);
		if (approval.policy !== "allow") return { allowed: false, reason: "tool approval is not auto-allow" };
		if (context.effect.kind === "model_completion") return { allowed: true };
		if (context.effect.kind === "reversible_write") {
			if (context.tool.name === "edit") {
				if (!matchesHashlineEditResources(context, this.toolSession.cwd)) {
					return { allowed: false, reason: "PAL edit resources changed" };
				}
				return { allowed: true, deferBeforeToolCall: true };
			}
			const resource = context.effect.resources[0];
			if (
				!resource ||
				context.effect.resources.length !== 1 ||
				resource.access !== "write" ||
				typeof context.args.path !== "string" ||
				resource.path !== path.resolve(this.toolSession.cwd, context.args.path)
			) {
				return { allowed: false, reason: "PAL write resource changed" };
			}
			return { allowed: true, deferBeforeToolCall: true };
		}
		if (context.effect.kind !== "local_read") {
			return { allowed: false, reason: "unsupported speculative effect" };
		}
		const resource = context.effect.resources[0];
		if (!resource || context.effect.resources.length !== 1 || resource.access !== "read") {
			return { allowed: false, reason: "local read must have one read resource" };
		}
		if (typeof context.args.path !== "string") return { allowed: false, reason: "local read path is invalid" };
		let resolved: string;
		try {
			resolved = await fs.realpath(path.resolve(this.toolSession.cwd, context.args.path));
		} catch {
			return { allowed: false, reason: "local read path is unavailable" };
		}
		if (resolved !== resource.path) return { allowed: false, reason: "local read resource changed" };
		const evidence = await captureEvidence(resolved);
		if (!evidence) return { allowed: false, reason: "local read target is unsafe" };
		this.#evidence.set(context.candidateId, evidence);
		return { allowed: true, deferBeforeToolCall: true };
	}

	async validate(context: SpeculativeCommitContext): Promise<boolean> {
		if (context.effect.kind === "model_completion" && context.physicalOutcome.kind === "result") {
			return (await this.authorize(context)).allowed;
		}
		if (context.physicalOutcome.kind === "staged") {
			if (!isStagedTransactionToken(context.physicalOutcome.token)) return false;
			const authorization = await this.authorize(context);
			return authorization.allowed && (await context.physicalOutcome.token.transaction.verify());
		}
		const expected = this.#evidence.get(context.candidateId);
		if (!expected) return false;
		const authorization = await this.authorize(context);
		if (!authorization.allowed) return false;
		const current = this.#evidence.get(context.candidateId);
		return (
			current !== undefined &&
			current.device === expected.device &&
			current.inode === expected.inode &&
			current.mtimeMs === expected.mtimeMs &&
			current.size === expected.size &&
			current.digest === expected.digest
		);
	}

	async commit(
		context: SpeculativeCommitContext,
		commitDefault: () => Promise<AgentToolResult<unknown>>,
	): Promise<SpeculativeCommitDecision> {
		try {
			try {
				return { kind: "committed" as const, result: await commitDefault() };
			} catch (error) {
				if (error instanceof SpeculativePalCommitConflictError) {
					return {
						kind: "fallback",
						reason: "speculative commit was rejected because the source changed",
						restored: false,
					};
				}
				if (context.physicalOutcome.kind !== "staged" || !isStagedTransactionToken(context.physicalOutcome.token)) {
					return { kind: "failed" as const, error };
				}
				try {
					await context.physicalOutcome.token.transaction.restore();
					return {
						kind: "fallback",
						reason: "speculative commit failed and source state was restored",
						restored: true,
					};
				} catch {
					return { kind: "failed", error };
				}
			}
		} finally {
			this.#evidence.delete(context.candidateId);
		}
	}

	discard(context: SpeculativeDiscardContext): void {
		this.#evidence.delete(context.candidateId);
	}

	close(): void {
		this.#evidence.clear();
	}
}
