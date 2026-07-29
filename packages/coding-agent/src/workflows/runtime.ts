import { prompt, Snowflake } from "@oh-my-pi/pi-utils";
import workflowNodeContextTemplate from "../prompts/system/workflow-node-context.md" with { type: "text" };
import type { SingleResult } from "../task/types";
import type { WorkflowStore } from "./store";
import {
	cloneWorkflowSnapshot,
	WORKFLOW_DEFINITION_VERSION,
	WORKFLOW_FAILURE_POLICY,
	WORKFLOW_SNAPSHOT_VERSION,
	type WorkflowDefinition,
	type WorkflowDraft,
	type WorkflowNode,
	type WorkflowNodeRun,
	type WorkflowSnapshot,
	type WorkflowStatus,
} from "./types";
import { parseWorkflowDefinition } from "./validation";

export interface WorkflowDispatchRequest {
	nodeId: string;
	name: string;
	agent: string;
	task: string;
	context: string;
	outputSchema?: unknown;
	schemaMode?: "permissive" | "strict";
	isolated?: boolean;
}

export type WorkflowDispatchOutcome = { result: SingleResult } | { error: string; status: "failed" | "interrupted" };

export type WorkflowDispatcher = (
	request: WorkflowDispatchRequest,
	signal: AbortSignal,
) => Promise<WorkflowDispatchOutcome>;

export interface WorkflowRunOptions {
	signal?: AbortSignal;
	preflight?: (requests: readonly WorkflowDispatchRequest[]) => Promise<void>;
	onChange?: (snapshot: WorkflowSnapshot) => void | Promise<void>;
}

export interface WorkflowRuntimeOptions {
	store: WorkflowStore;
	now?: () => number;
	idFactory?: () => string;
}

const UPSTREAM_BLOCKING_STATUSES: ReadonlySet<WorkflowNodeRun["status"]> = new Set([
	"failed",
	"blocked",
	"interrupted",
	"cancelled",
]);

function defaultWorkflowId(): string {
	return String(Snowflake.next());
}

function isReplaceable(status: WorkflowStatus): boolean {
	return status === "succeeded" || status === "cancelled";
}

function buildAgentName(workflowId: string, nodeId: string, attempt: number): string {
	const identity = `${workflowId}\0${nodeId}`;
	const suffix = new Bun.CryptoHasher("sha256").update(identity).digest("hex").slice(0, 8);
	return `wf-${workflowId.slice(0, 10)}-${nodeId.slice(0, 28)}-${suffix}-a${attempt}`;
}

function descendantIds(definition: WorkflowDefinition, rootId: string): Set<string> {
	const descendants = new Set([rootId]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const node of definition.nodes) {
			if (descendants.has(node.id) || !node.needs?.some(id => descendants.has(id))) continue;
			descendants.add(node.id);
			changed = true;
		}
	}
	return descendants;
}

function buildDependencyContext(snapshot: WorkflowSnapshot, node: WorkflowNode): string {
	const dependencies = (node.needs ?? []).map(id => {
		const dependency = snapshot.nodes[id]!;
		return {
			id,
			status: dependency.status,
			references: [dependency.outputRef, dependency.historyRef].filter(Boolean).join(", "),
		};
	});
	return prompt.render(workflowNodeContextTemplate, {
		workflowId: snapshot.definition.id,
		objective: snapshot.definition.objective,
		nodeId: node.id,
		hasDependencies: dependencies.length > 0,
		dependencies,
	});
}

function resultError(result: SingleResult): string {
	return (
		result.error?.trim() ||
		result.stderr.trim() ||
		result.abortReason?.trim() ||
		`Task exited with code ${result.exitCode}`
	);
}

export class WorkflowRuntime {
	readonly #store: WorkflowStore;
	readonly #now: () => number;
	readonly #idFactory: () => string;
	#snapshot: WorkflowSnapshot | null;
	#runAbort: AbortController | undefined;
	#cancelRequested = false;
	#saveTail: Promise<void> = Promise.resolve();

	private constructor(options: WorkflowRuntimeOptions, snapshot: WorkflowSnapshot | null) {
		this.#store = options.store;
		this.#now = options.now ?? Date.now;
		this.#idFactory = options.idFactory ?? defaultWorkflowId;
		this.#snapshot = snapshot;
	}

	static async create(options: WorkflowRuntimeOptions): Promise<WorkflowRuntime> {
		const snapshot = options.store.load();
		const runtime = new WorkflowRuntime(options, snapshot);
		if (snapshot && runtime.#reconcileInterruptedRun()) {
			await runtime.#persist();
		}
		return runtime;
	}

	getSnapshot(): WorkflowSnapshot | null {
		return this.#snapshot ? cloneWorkflowSnapshot(this.#snapshot) : null;
	}

	async createWorkflow(draft: WorkflowDraft): Promise<WorkflowSnapshot> {
		if (this.#snapshot && !isReplaceable(this.#snapshot.status)) {
			throw new Error(
				`Workflow ${this.#snapshot.definition.id} is ${this.#snapshot.status}; complete or cancel it before creating another`,
			);
		}
		const definition = parseWorkflowDefinition({
			version: WORKFLOW_DEFINITION_VERSION,
			id: draft.id?.trim() || this.#idFactory(),
			objective: draft.objective,
			failurePolicy: WORKFLOW_FAILURE_POLICY,
			nodes: draft.nodes,
		});
		if (this.#store.hasWorkflowId(definition.id)) {
			throw new Error(`Workflow id "${definition.id}" already exists on this session branch`);
		}
		const now = this.#now();
		const nodes: Record<string, WorkflowNodeRun> = {};
		for (const node of definition.nodes) {
			nodes[node.id] = {
				status: (node.needs?.length ?? 0) === 0 ? "ready" : "pending",
				attempts: 0,
			};
		}
		this.#snapshot = {
			version: WORKFLOW_SNAPSHOT_VERSION,
			revision: 0,
			definition,
			status: "created",
			nodes,
			createdAt: now,
			updatedAt: now,
		};
		this.#cancelRequested = false;
		await this.#persist();
		return cloneWorkflowSnapshot(this.#snapshot);
	}

	async run(dispatcher: WorkflowDispatcher, options: WorkflowRunOptions = {}): Promise<WorkflowSnapshot> {
		const snapshot = this.#requireSnapshot();
		if (this.#runAbort) throw new Error(`Workflow ${snapshot.definition.id} is already running`);
		if (snapshot.status === "succeeded" || snapshot.status === "cancelled") {
			return cloneWorkflowSnapshot(snapshot);
		}

		this.#cancelRequested = false;
		this.#runAbort = new AbortController();
		const dispatchSignal = options.signal
			? AbortSignal.any([options.signal, this.#runAbort.signal])
			: this.#runAbort.signal;
		try {
			this.#refreshPendingStates();
			const preflightRequests = snapshot.definition.nodes
				.filter(node => {
					const status = snapshot.nodes[node.id]?.status;
					return status === "pending" || status === "ready";
				})
				.map(node => this.#dispatchRequest(snapshot.definition, node, snapshot.nodes[node.id]!.attempts + 1));
			await options.preflight?.(preflightRequests);
			while (!dispatchSignal.aborted && !this.#cancelRequested) {
				const ready = snapshot.definition.nodes.filter(node => snapshot.nodes[node.id]?.status === "ready");
				if (ready.length === 0) break;
				const startedAt = this.#now();
				for (const node of ready) {
					const state = snapshot.nodes[node.id]!;
					state.status = "running";
					state.attempts += 1;
					state.startedAt = startedAt;
					delete state.finishedAt;
					delete state.agentId;
					delete state.outputRef;
					delete state.historyRef;
					delete state.error;
				}
				snapshot.status = "running";
				await this.#persist(options.onChange);

				await Promise.all(
					ready.map(async node => {
						const state = snapshot.nodes[node.id]!;
						const request = this.#dispatchRequest(snapshot.definition, node, state.attempts);
						let outcome: WorkflowDispatchOutcome;
						try {
							outcome = await dispatcher(request, dispatchSignal);
						} catch (error) {
							outcome = {
								status: "interrupted",
								error: error instanceof Error ? error.message : String(error),
							};
						}
						this.#settleNode(node, outcome, options.signal?.aborted === true);
						this.#refreshPendingStates();
						this.#reconcileStatus(true);
						await this.#persist(options.onChange);
					}),
				);
			}

			if (dispatchSignal.aborted) {
				for (const state of Object.values(snapshot.nodes)) {
					if (state.status !== "running") continue;
					state.status = this.#cancelRequested ? "cancelled" : "interrupted";
					state.error = this.#cancelRequested ? "Workflow cancelled" : "Workflow execution interrupted";
					state.finishedAt = this.#now();
				}
				this.#refreshPendingStates();
			}
			this.#reconcileStatus(false);
			await this.#persist(options.onChange);
			return cloneWorkflowSnapshot(snapshot);
		} finally {
			this.#runAbort = undefined;
		}
	}

	async retryNode(nodeId: string): Promise<WorkflowSnapshot> {
		const snapshot = this.#requireSnapshot();
		if (this.#runAbort) throw new Error("Cannot retry a node while the workflow is running");
		const selected = snapshot.nodes[nodeId];
		if (!selected) throw new Error(`Unknown workflow node "${nodeId}"`);
		if (selected.status !== "failed" && selected.status !== "interrupted") {
			throw new Error(
				`Workflow node "${nodeId}" is ${selected.status}; only failed or interrupted nodes can be retried`,
			);
		}

		selected.status = "pending";
		delete selected.agentId;
		delete selected.outputRef;
		delete selected.historyRef;
		delete selected.error;
		delete selected.startedAt;
		delete selected.finishedAt;
		for (const descendantId of descendantIds(snapshot.definition, nodeId)) {
			if (descendantId === nodeId) continue;
			const state = snapshot.nodes[descendantId]!;
			if (state.status !== "blocked") continue;
			state.status = "pending";
			delete state.error;
			delete state.finishedAt;
		}
		this.#cancelRequested = false;
		this.#refreshPendingStates();
		this.#reconcileStatus(false);
		await this.#persist();
		return cloneWorkflowSnapshot(snapshot);
	}

	async cancel(): Promise<WorkflowSnapshot> {
		const snapshot = this.#requireSnapshot();
		if (snapshot.status === "succeeded" || snapshot.status === "cancelled") {
			return cloneWorkflowSnapshot(snapshot);
		}
		this.#cancelRequested = true;
		for (const state of Object.values(snapshot.nodes)) {
			if (state.status === "pending" || state.status === "ready") {
				state.status = "cancelled";
				state.error = "Workflow cancelled before dispatch";
				state.finishedAt = this.#now();
			}
		}
		snapshot.status = Object.values(snapshot.nodes).some(state => state.status === "running")
			? "cancelling"
			: "cancelled";
		this.#runAbort?.abort("Workflow cancelled");
		await this.#persist();
		return cloneWorkflowSnapshot(snapshot);
	}

	#requireSnapshot(): WorkflowSnapshot {
		if (!this.#snapshot) throw new Error("No workflow exists in this session");
		return this.#snapshot;
	}

	#dispatchRequest(definition: WorkflowDefinition, node: WorkflowNode, attempt: number): WorkflowDispatchRequest {
		const request: WorkflowDispatchRequest = {
			nodeId: node.id,
			name: buildAgentName(definition.id, node.id, attempt),
			agent: node.agent,
			task: node.task,
			context: buildDependencyContext(this.#requireSnapshot(), node),
		};
		if (Object.hasOwn(node, "outputSchema")) request.outputSchema = node.outputSchema;
		if (node.schemaMode !== undefined) request.schemaMode = node.schemaMode;
		if (node.isolated !== undefined) request.isolated = node.isolated;
		return request;
	}

	#settleNode(node: WorkflowNode, outcome: WorkflowDispatchOutcome, parentAborted: boolean): void {
		const state = this.#requireSnapshot().nodes[node.id]!;
		state.finishedAt = this.#now();
		if ("error" in outcome) {
			state.status = this.#cancelRequested ? "cancelled" : parentAborted ? "interrupted" : outcome.status;
			state.error = outcome.error;
			return;
		}

		const result = outcome.result;
		state.agentId = result.id;
		state.outputRef = `agent://${result.id}`;
		state.historyRef = `history://${result.id}`;
		const strictSchemaFailure =
			node.schemaMode === "strict" &&
			Object.hasOwn(node, "outputSchema") &&
			result.structuredOutput?.status !== "valid";
		if (this.#cancelRequested) {
			state.status = "cancelled";
			state.error = "Workflow cancelled";
		} else if (result.aborted || parentAborted) {
			state.status = "interrupted";
			state.error = resultError(result);
		} else if (result.exitCode !== 0 || strictSchemaFailure) {
			state.status = "failed";
			state.error = strictSchemaFailure
				? result.structuredOutput?.error || "Strict output schema validation failed"
				: resultError(result);
		} else {
			state.status = "succeeded";
			delete state.error;
		}
	}

	#refreshPendingStates(): void {
		const snapshot = this.#requireSnapshot();
		for (const node of snapshot.definition.nodes) {
			const state = snapshot.nodes[node.id]!;
			if (state.status !== "pending") continue;
			const dependencies = (node.needs ?? []).map(id => snapshot.nodes[id]!);
			if (dependencies.some(dependency => UPSTREAM_BLOCKING_STATUSES.has(dependency.status))) {
				state.status = "blocked";
				state.error = "Blocked by an unsuccessful dependency";
				state.finishedAt = this.#now();
			} else if (dependencies.every(dependency => dependency.status === "succeeded")) {
				state.status = "ready";
			}
		}
	}

	#reconcileStatus(active: boolean): void {
		const snapshot = this.#requireSnapshot();
		const states = Object.values(snapshot.nodes);
		if (states.every(state => state.status === "succeeded")) {
			snapshot.status = "succeeded";
		} else if (this.#cancelRequested) {
			snapshot.status = states.some(state => state.status === "running") ? "cancelling" : "cancelled";
		} else if (
			states.some(state => state.status === "running") ||
			(active && states.some(state => state.status === "ready"))
		) {
			snapshot.status = "running";
		} else if (states.some(state => state.status === "interrupted")) {
			snapshot.status = "interrupted";
		} else if (states.some(state => state.status === "failed" || state.status === "blocked")) {
			snapshot.status = "failed";
		} else if (states.some(state => state.status === "cancelled")) {
			snapshot.status = "cancelled";
		} else {
			snapshot.status = "created";
		}
	}

	#reconcileInterruptedRun(): boolean {
		if (!this.#snapshot) return false;
		let changed = false;
		for (const state of Object.values(this.#snapshot.nodes)) {
			if (state.status !== "running") continue;
			state.status = "interrupted";
			state.error = "Interrupted by process restart";
			state.finishedAt = this.#now();
			changed = true;
		}
		if (!changed) return false;
		this.#refreshPendingStates();
		this.#reconcileStatus(false);
		return true;
	}

	async #persist(onChange?: (snapshot: WorkflowSnapshot) => void | Promise<void>): Promise<void> {
		const snapshot = this.#requireSnapshot();
		snapshot.revision += 1;
		snapshot.updatedAt = this.#now();
		const durable = cloneWorkflowSnapshot(snapshot);
		const operation = this.#saveTail.catch(() => {}).then(() => this.#store.append(durable));
		this.#saveTail = operation;
		await operation;
		await onChange?.(cloneWorkflowSnapshot(durable));
	}
}
