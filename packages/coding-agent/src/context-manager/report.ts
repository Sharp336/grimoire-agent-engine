import { sanitizeText, truncate } from "@oh-my-pi/pi-utils";
import { PREVIEW_LIMITS, replaceTabs, shortenPathsInText, TRUNCATE_LENGTHS } from "../tools/render-utils";
import type {
	ContextDreamRunResult,
	ContextEmbeddingStatus,
	ContextHistorianRunResult,
	ContextManagerDiagnostics,
} from "./types";

export function sanitizeContextStatusText(value: string): string {
	return truncate(
		shortenPathsInText(replaceTabs(sanitizeText(value)).replace(/[\r\n]+/g, " ")),
		TRUNCATE_LENGTHS.RECAP,
	);
}

export function formatContextHistorianResult(label: string, result: ContextHistorianRunResult): string {
	const range =
		result.startTag !== undefined && result.endTag !== undefined
			? ` tags §${result.startTag}§-§${result.endTag}§`
			: "";
	const error = result.error ? `; ${sanitizeContextStatusText(result.error)}` : "";
	return `${label}: ${result.status}; ${result.compartments} compartments, ${result.facts} facts${range}${error}`;
}

export function formatContextEmbeddingStatus(status: ContextEmbeddingStatus): string {
	const model =
		status.provider && status.model
			? ` (${sanitizeContextStatusText(status.provider)}/${sanitizeContextStatusText(status.model)})`
			: "";
	const error = status.error ? `; ${sanitizeContextStatusText(status.error)}` : "";
	return `Embedding: ${status.state}${model}; ${status.completed}/${status.pending + status.completed} complete (${Math.round(status.progress * 100)}%)${error}`;
}

export function formatContextDreamResult(result: ContextDreamRunResult): string {
	return `${result.task}: ${result.status}; ${result.changed} changed; ${sanitizeContextStatusText(result.summary)}`;
}

export function formatManagedContextStatus(diagnostics: ContextManagerDiagnostics): string {
	const status = diagnostics.status;
	const lines = [
		`Managed context: ${status.active ? "active" : "inactive"}${status.failure ? ` (${sanitizeContextStatusText(status.failure)})` : ""}`,
		`Project: ${status.projectId ? sanitizeContextStatusText(status.projectId) : "unbound"}`,
		`Session: ${status.sessionId ? sanitizeContextStatusText(status.sessionId) : "unbound"}`,
		`Tags: ${diagnostics.tags.active} active / ${diagnostics.tags.total} total; ${diagnostics.tags.dropped} dropped; ${diagnostics.tags.protected} protected; ${diagnostics.tags.superseded} superseded`,
		`Drops: ${diagnostics.drops.queued} queued; ${diagnostics.drops.active} active; ${diagnostics.drops.superseded} superseded`,
		`Compartments: ${diagnostics.compartments.total}; P1 ${diagnostics.compartments.p1Tokens}; P2 ${diagnostics.compartments.p2Tokens}; P3 ${diagnostics.compartments.p3Tokens}; budget ${diagnostics.compartments.budgetTokens}`,
		`Historian: ${diagnostics.historian.running ? "running" : "idle"}; ${diagnostics.historian.pendingPublication ? "publication pending" : "settled"}; ${diagnostics.facts} facts`,
		`Mnemopi: ${diagnostics.memory.enabled ? (diagnostics.memory.available ? "available" : "unavailable") : "disabled"}${diagnostics.memory.projectBank ? `; project ${sanitizeContextStatusText(diagnostics.memory.projectBank)}` : ""}${diagnostics.memory.userBank ? `; user ${sanitizeContextStatusText(diagnostics.memory.userBank)}` : ""}`,
		formatContextEmbeddingStatus(diagnostics.embedding),
		`Dreamer: ${diagnostics.dreamer.active ? "active" : "inactive"}; ${diagnostics.dreamer.running.length > 0 ? `running ${diagnostics.dreamer.running.join(", ")}` : "idle"}`,
		`Schedules: ${sanitizeContextStatusText(diagnostics.dreamer.scheduleSummary)}`,
	];
	if (diagnostics.runtime) {
		const runtime = diagnostics.runtime;
		lines.splice(
			3,
			0,
			`On-wire tokens: ${runtime.totalTokens} total; ${runtime.conversationTokens} conversation; ${runtime.toolCallTokens} tool calls; ${runtime.nonMessageTokens} non-message`,
			`Policy: ${runtime.pressurePercent.toFixed(1)}% pressure; execute at ${runtime.executeThresholdTokens} tokens; cache TTL ${runtime.cacheTtlMs}ms${runtime.pendingSince === undefined ? "" : `; pending since ${new Date(runtime.pendingSince).toISOString()}`}`,
		);
	}
	const jobs = diagnostics.jobs.slice(-PREVIEW_LIMITS.OUTPUT_EXPANDED);
	if (jobs.length > 0) {
		lines.push("Recent jobs:");
		for (const job of jobs) {
			const error = job.lastError ? `; ${sanitizeContextStatusText(job.lastError)}` : "";
			lines.push(
				`  ${sanitizeContextStatusText(job.task ?? job.kind)}: ${job.status}; attempt ${job.attempt}; ${Math.round(job.progress * 100)}%${error}`,
			);
		}
	}
	if (diagnostics.errors.length > 0) {
		lines.push("Errors:");
		for (const error of diagnostics.errors.slice(-PREVIEW_LIMITS.OUTPUT_EXPANDED)) {
			lines.push(`  ${sanitizeContextStatusText(error)}`);
		}
	}
	return lines.join("\n");
}
