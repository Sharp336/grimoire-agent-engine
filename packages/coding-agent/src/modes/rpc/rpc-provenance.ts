import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	Provider,
	ServiceTierByFamily,
	UsageReport,
	UsageStatus,
	UsageUnit,
} from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import type { AgentSessionEvent, AgentSessionEventListener } from "../../session/agent-session-events";
import type { TurnRecoverySnapshot } from "../../session/turn-recovery";
import { sanitizeRpcText } from "./rpc-safe-text";

const MAX_PROVENANCE_TEXT_BYTES = 1024;
const MAX_USAGE_REPORTS = 64;
const MAX_USAGE_LIMITS = 128;

export interface RpcProvenanceSource {
	model: { provider: Provider; id: string; api: Api } | undefined;
	serviceTierByFamily: ServiceTierByFamily;
	messages: AgentMessage[];
	getActiveRole(): string;
	getRecoverySnapshot(): TurnRecoverySnapshot;
	fetchUsageReports(signal?: AbortSignal): Promise<UsageReport[] | null>;
	subscribe(listener: AgentSessionEventListener): () => void;
}

export interface RpcUsageLimit {
	id: string;
	label: string;
	modelId?: string;
	tier?: string;
	shared?: boolean;
	window?: {
		id: string;
		label: string;
		durationMs?: number;
		resetsAt?: number;
		resetLabel?: string;
	};
	amount: {
		used?: number;
		limit?: number;
		remaining?: number;
		usedFraction?: number;
		remainingFraction?: number;
		unit: UsageUnit;
	};
	status?: UsageStatus;
}

export interface RpcUsageReport {
	provider: Provider;
	fetchedAt: number;
	limits: RpcUsageLimit[];
	truncated?: true;
}

export interface RpcRuntimeFailure {
	category: "authentication" | "usage_limit" | "context_overflow" | "content_blocked" | "transient" | "provider";
	nextAction:
		| "authenticate_provider"
		| "retry_after_reset_or_change_model"
		| "compact_or_change_model"
		| "revise_request"
		| "retry"
		| "retry_or_change_model";
}

export interface RpcProvenanceSnapshot {
	revision: number;
	model: {
		active?: { provider: Provider; id: string; api: Api };
		role: string;
		serviceTiers: ServiceTierByFamily;
	};
	fallback: TurnRecoverySnapshot["fallback"] | null;
	credentialRotation: {
		provider: string;
		model: string;
		reason: "usage_limit";
	} | null;
	usage: {
		available: boolean;
		reports: RpcUsageReport[];
		diagnostic?: "not_requested" | "unsupported" | "fetch_failed";
	};
	failure: RpcRuntimeFailure | null;
}

export interface RpcProvenanceFrame {
	type: "provenance_update";
	provenance: RpcProvenanceSnapshot;
}

function safeText(value: string): string {
	return sanitizeRpcText(value, MAX_PROVENANCE_TEXT_BYTES);
}

function finite(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function projectUsageReport(report: UsageReport): RpcUsageReport {
	const limits = report.limits.slice(0, MAX_USAGE_LIMITS).map(limit => ({
		id: safeText(limit.id),
		label: safeText(limit.label),
		...(limit.scope.modelId ? { modelId: safeText(limit.scope.modelId) } : {}),
		...(limit.scope.tier ? { tier: safeText(limit.scope.tier) } : {}),
		...(limit.scope.shared === undefined ? {} : { shared: limit.scope.shared }),
		...(limit.window
			? {
					window: {
						id: safeText(limit.window.id),
						label: safeText(limit.window.label),
						...(finite(limit.window.durationMs) === undefined
							? {}
							: { durationMs: finite(limit.window.durationMs) }),
						...(finite(limit.window.resetsAt) === undefined ? {} : { resetsAt: finite(limit.window.resetsAt) }),
						...(limit.window.resetLabel ? { resetLabel: safeText(limit.window.resetLabel) } : {}),
					},
				}
			: {}),
		amount: {
			...(finite(limit.amount.used) === undefined ? {} : { used: finite(limit.amount.used) }),
			...(finite(limit.amount.limit) === undefined ? {} : { limit: finite(limit.amount.limit) }),
			...(finite(limit.amount.remaining) === undefined ? {} : { remaining: finite(limit.amount.remaining) }),
			...(finite(limit.amount.usedFraction) === undefined
				? {}
				: { usedFraction: finite(limit.amount.usedFraction) }),
			...(finite(limit.amount.remainingFraction) === undefined
				? {}
				: { remainingFraction: finite(limit.amount.remainingFraction) }),
			unit: limit.amount.unit,
		},
		...(limit.status === undefined ? {} : { status: limit.status }),
	}));
	return {
		provider: report.provider,
		fetchedAt: report.fetchedAt,
		limits,
		...(limits.length < report.limits.length ? { truncated: true as const } : {}),
	};
}

function latestAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "assistant") return message;
	}
	return undefined;
}

function hasFlag(message: AssistantMessage, flag: AIError.Flag): boolean {
	return message.errorId !== undefined && AIError.is(message.errorId, flag);
}

function projectFailure(messages: readonly AgentMessage[]): RpcRuntimeFailure | null {
	const message = latestAssistant(messages);
	if (message?.stopReason !== "error") return null;
	if (hasFlag(message, AIError.Flag.AuthFailed) || hasFlag(message, AIError.Flag.OAuthExpiry)) {
		return { category: "authentication", nextAction: "authenticate_provider" };
	}
	if (hasFlag(message, AIError.Flag.UsageLimit)) {
		return { category: "usage_limit", nextAction: "retry_after_reset_or_change_model" };
	}
	if (hasFlag(message, AIError.Flag.ContextOverflow)) {
		return { category: "context_overflow", nextAction: "compact_or_change_model" };
	}
	if (hasFlag(message, AIError.Flag.ContentBlocked)) {
		return { category: "content_blocked", nextAction: "revise_request" };
	}
	if (hasFlag(message, AIError.Flag.Transient) || hasFlag(message, AIError.Flag.Timeout)) {
		return { category: "transient", nextAction: "retry" };
	}
	return { category: "provider", nextAction: "retry_or_change_model" };
}

export class RpcProvenanceManager {
	readonly #source: RpcProvenanceSource;
	readonly #output: (frame: RpcProvenanceFrame) => void;
	readonly #unsubscribe: () => void;
	#revision = 0;
	#credentialRotation: RpcProvenanceSnapshot["credentialRotation"] = null;
	#usage: RpcProvenanceSnapshot["usage"] = {
		available: false,
		reports: [],
		diagnostic: "not_requested",
	};
	#disposed = false;

	constructor(source: RpcProvenanceSource, output: (frame: RpcProvenanceFrame) => void) {
		this.#source = source;
		this.#output = output;
		this.#unsubscribe = source.subscribe(event => this.#handleEvent(event));
	}

	snapshot(): RpcProvenanceSnapshot {
		const recovery = this.#source.getRecoverySnapshot();
		return {
			revision: this.#revision,
			model: {
				...(this.#source.model
					? {
							active: {
								provider: this.#source.model.provider,
								id: this.#source.model.id,
								api: this.#source.model.api,
							},
						}
					: {}),
				role: safeText(this.#source.getActiveRole()),
				serviceTiers: { ...this.#source.serviceTierByFamily },
			},
			fallback: recovery.fallback ? { ...recovery.fallback } : null,
			credentialRotation: this.#credentialRotation ? { ...this.#credentialRotation } : null,
			usage: {
				available: this.#usage.available,
				reports: this.#usage.reports.map(report => ({
					...report,
					limits: report.limits.map(limit => ({
						...limit,
						amount: { ...limit.amount },
						...(limit.window ? { window: { ...limit.window } } : {}),
					})),
				})),
				...(this.#usage.diagnostic === undefined ? {} : { diagnostic: this.#usage.diagnostic }),
			},
			failure: projectFailure(this.#source.messages),
		};
	}

	async refresh(signal?: AbortSignal): Promise<RpcProvenanceSnapshot> {
		try {
			const reports = await this.#source.fetchUsageReports(signal);
			this.#usage = reports
				? {
						available: true,
						reports: reports.slice(0, MAX_USAGE_REPORTS).map(projectUsageReport),
					}
				: { available: false, reports: [], diagnostic: "unsupported" };
		} catch {
			this.#usage = { available: false, reports: [], diagnostic: "fetch_failed" };
		}
		this.#revision++;
		const provenance = this.snapshot();
		this.#output({ type: "provenance_update", provenance });
		return provenance;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe();
	}

	#handleEvent(event: AgentSessionEvent): void {
		if (this.#disposed) return;
		if (event.type === "credential_rotated") {
			this.#credentialRotation = {
				provider: safeText(event.provider),
				model: safeText(event.model),
				reason: event.reason,
			};
		} else if (
			event.type !== "retry_fallback_applied" &&
			event.type !== "retry_fallback_succeeded" &&
			event.type !== "model_changed" &&
			event.type !== "agent_end"
		) {
			return;
		}
		this.#revision++;
		this.#output({ type: "provenance_update", provenance: this.snapshot() });
	}
}
