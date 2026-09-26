import { type EngineEvent, EngineTargetError } from "./contracts";
import {
	type RuntimeAccess,
	type RuntimeChange,
	type RuntimeRemainingWork,
	type RuntimeWork,
	runtimeLimits,
	validateRuntimeValue,
} from "./runtime-protocol";

export interface RuntimeIdentityRow {
	agent_instance_id: string;
	agent_instance_ref: string;
	parent_agent_instance_id: string | null;
	parent_agent_instance_ref: string | null;
	principal_id: string;
	authority_generation: number;
	intent_revision: number;
	queue_revision: number;
	queue_pending_count: number;
	root_agent_instance_ref: string;
	summary_revision: number;
	summary_json: string | null;
	membership_revision: number;
	archived_at?: number | null;
	deleted_at?: number | null;
	lifecycle_revision?: number;
	lifecycle_operation_id?: string;
	lifecycle_action?: "archive" | "unarchive" | "delete";
}

export function boundedItems<T>(items: T[], maxBytes: number, maxItems: number): T[] {
	const selected: T[] = [];
	let bytes = 2;
	for (const item of items) {
		const size = Buffer.byteLength(JSON.stringify(item)) + 1;
		if (selected.length === maxItems || bytes + size > maxBytes) break;
		selected.push(item);
		bytes += size;
	}
	return selected;
}

export function runtimeInputBody(event: EngineEvent): Record<string, unknown> {
	const payload = event.payload ?? {};
	if (event.kind === "tool_approval_requested")
		return {
			kind: "tool_approval",
			inputId: String(payload.approvalId),
			revision: event.eventId,
			requestedAt: new Date(event.createdAt).toISOString(),
			prompt: `Разрешить вызов ${String(payload.toolName ?? "tool")}?`,
			tool: {
				name: String(payload.toolName ?? "tool"),
				...(typeof payload.inputHash === "string" ? { inputHash: payload.inputHash } : {}),
			},
			options: ["approve", "deny"],
		};
	const questions = payload.questions;
	if (!Array.isArray(questions) || questions.length < 1 || questions.length > runtimeLimits.inputMaxQuestions)
		throw new EngineTargetError("invalid_request", "Input question count is outside the owner limit");
	const projected = questions.map((question: Record<string, unknown>) => ({
		id: question.id,
		question: question.question,
		...(question.header !== undefined ? { header: question.header } : {}),
		options: Array.isArray(question.options)
			? question.options.map((option: Record<string, unknown>) => ({
					label: option.label,
					...(option.description !== undefined ? { description: option.description } : {}),
				}))
			: [],
		...(question.multi !== undefined ? { multi: question.multi } : {}),
		...(question.recommended !== undefined ? { recommended: question.recommended } : {}),
	}));
	if (new Set(projected.map(question => question.id)).size !== projected.length)
		throw new EngineTargetError("invalid_request", "Input question IDs must be unique");
	// Validate fields without applying a transport-frame cap to the retained full body.
	for (const question of projected) {
		if (question.options.length > runtimeLimits.inputMaxOptions)
			throw new EngineTargetError("invalid_request", "Input option count exceeds the owner limit");
		if (
			question.recommended !== undefined &&
			(!Number.isSafeInteger(question.recommended) || Number(question.recommended) >= question.options.length)
		)
			throw new EngineTargetError("invalid_request", "Recommended input option does not exist");
		for (const options of [[], ...question.options.map(option => [option])])
			validateRuntimeValue("pendingInput", {
				kind: "question",
				inputId: String(payload.inputId),
				revision: event.eventId,
				questions: [{ ...question, options }],
			});
	}
	return {
		kind: "question",
		inputId: String(payload.inputId),
		revision: event.eventId,
		requestedAt: new Date(event.createdAt).toISOString(),
		questions: projected,
	};
}

export function runtimeInputPreview(body: Record<string, unknown>): Record<string, unknown> {
	if (Buffer.byteLength(JSON.stringify(body)) <= runtimeLimits.inputPreviewBytes) return body;
	for (let length = 128; length >= 1; length = Math.floor(length / 2)) {
		const questions = body.questions as Array<Record<string, unknown>> | undefined;
		const preview = questions
			? {
					...body,
					questions: questions.map(question => ({
						...question,
						question: String(question.question).slice(0, length).toWellFormed(),
						...(question.header ? { header: String(question.header).slice(0, length).toWellFormed() } : {}),
						options: (question.options as Array<{ label: string }>).map(option => ({
							label: option.label.slice(0, length).toWellFormed(),
						})),
					})),
				}
			: { ...body, prompt: String(body.prompt).slice(0, length).toWellFormed() };
		if (Buffer.byteLength(JSON.stringify(preview)) <= runtimeLimits.inputPreviewBytes) return preview;
	}
	throw new EngineTargetError("invalid_request", "Input IDs and option shape exceed the bounded control overview");
}

export interface RuntimeTargetRequest extends RuntimeAccess {
	agentInstanceRef: string;
	attemptId?: string;
	executionId?: string;
	rootAgentInstanceRef?: string;
}

export class RuntimeQueryError extends EngineTargetError {
	constructor(
		code: "retention_gap" | "epoch_changed" | "projection_changed" | "restore_budget",
		message: string,
		readonly work: RuntimeWork,
	) {
		super(code, message);
	}
}

export class RuntimeQueryWork {
	readonly value: RuntimeWork = { bytes: 0, changes: 0, scannedRows: 0, materializedBytes: 0, elapsedMs: 0 };
	readonly #started = performance.now();

	constructor(readonly remaining: RuntimeRemainingWork) {}

	check(): void {
		this.value.elapsedMs = Math.ceil(performance.now() - this.#started);
		if (
			this.value.scannedRows > this.remaining.scannedRows ||
			this.value.materializedBytes > this.remaining.materializedBytes ||
			this.value.elapsedMs > this.remaining.timeMs
		) {
			throw new RuntimeQueryError("restore_budget", "Owner query work budget exceeded", { ...this.value });
		}
	}

	rows(count: number): void {
		this.value.scannedRows += count;
		this.check();
	}

	decode<T>(json: string): T {
		const bytes = Buffer.byteLength(json);
		if (this.value.materializedBytes + bytes > this.remaining.materializedBytes) {
			throw new RuntimeQueryError("restore_budget", "Owner materialization budget exhausted", { ...this.value });
		}
		this.value.materializedBytes += bytes;
		this.check();
		return JSON.parse(json) as T;
	}

	finish(value: unknown, changes: number): RuntimeWork {
		this.value.changes = changes;
		this.check();
		for (;;) {
			const bytes = Buffer.byteLength(JSON.stringify(value));
			if (bytes === this.value.bytes) break;
			this.value.bytes = bytes;
		}
		if (this.value.bytes > this.remaining.bytes || changes > this.remaining.changes) {
			throw new RuntimeQueryError("restore_budget", "Owner result budget exceeded", { ...this.value });
		}
		return { ...this.value };
	}
}

export function runtimeAuthorized(identity: RuntimeIdentityRow, access: RuntimeAccess): boolean {
	return (
		identity.principal_id === access.principalId ||
		(identity.principal_id === "" &&
			Boolean(access.authorizedAgentInstanceRefs?.includes(identity.agent_instance_ref)))
	);
}

export function projectionChange(
	kind: RuntimeChange["kind"],
	agentInstanceRef: string,
	cursor: number,
	revision: number,
	value: Record<string, unknown>,
	attemptId?: string,
): RuntimeChange {
	const change: RuntimeChange = {
		kind,
		agentInstanceRef,
		cursor,
		revision,
		value,
		...(attemptId ? { attemptId } : {}),
	};
	validateRuntimeValue("change", change);
	return change;
}
