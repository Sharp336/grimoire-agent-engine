import { isRecord } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../tools";
import {
	cloneWorkflowSnapshot,
	WORKFLOW_SESSION_CUSTOM_TYPE,
	WORKFLOW_SNAPSHOT_VERSION,
	type WorkflowNodeRun,
	type WorkflowNodeStatus,
	type WorkflowSnapshot,
	type WorkflowStatus,
} from "./types";
import { parseWorkflowDefinition } from "./validation";

export interface WorkflowStore {
	load(): WorkflowSnapshot | null;
	hasWorkflowId(id: string): boolean;
	append(snapshot: WorkflowSnapshot): Promise<void>;
}

type WorkflowSessionManager = NonNullable<ToolSession["sessionManager"]>;

const NODE_STATUSES: ReadonlySet<WorkflowNodeStatus> = new Set([
	"pending",
	"ready",
	"running",
	"succeeded",
	"failed",
	"blocked",
	"interrupted",
	"cancelled",
]);

const WORKFLOW_STATUSES: ReadonlySet<WorkflowStatus> = new Set([
	"created",
	"running",
	"succeeded",
	"failed",
	"interrupted",
	"cancelling",
	"cancelled",
]);

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseNodeRun(value: unknown): WorkflowNodeRun | undefined {
	if (!isRecord(value) || typeof value.status !== "string" || !NODE_STATUSES.has(value.status as WorkflowNodeStatus)) {
		return undefined;
	}
	if (typeof value.attempts !== "number" || !Number.isInteger(value.attempts) || value.attempts < 0) {
		return undefined;
	}
	return {
		status: value.status as WorkflowNodeStatus,
		attempts: value.attempts,
		agentId: optionalString(value.agentId),
		outputRef: optionalString(value.outputRef),
		historyRef: optionalString(value.historyRef),
		error: optionalString(value.error),
		startedAt: optionalNumber(value.startedAt),
		finishedAt: optionalNumber(value.finishedAt),
	};
}

export function parseWorkflowSnapshot(value: unknown): WorkflowSnapshot | undefined {
	if (!isRecord(value) || value.version !== WORKFLOW_SNAPSHOT_VERSION) return undefined;
	if (typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 0) return undefined;
	if (typeof value.status !== "string" || !WORKFLOW_STATUSES.has(value.status as WorkflowStatus)) return undefined;
	if (
		typeof value.createdAt !== "number" ||
		!Number.isFinite(value.createdAt) ||
		typeof value.updatedAt !== "number" ||
		!Number.isFinite(value.updatedAt) ||
		!isRecord(value.nodes)
	) {
		return undefined;
	}
	try {
		const definition = parseWorkflowDefinition(value.definition);
		const nodes: Record<string, WorkflowNodeRun> = {};
		for (const node of definition.nodes) {
			const run = parseNodeRun(value.nodes[node.id]);
			if (!run) return undefined;
			nodes[node.id] = run;
		}
		if (Object.keys(value.nodes).some(id => !Object.hasOwn(nodes, id))) return undefined;
		return {
			version: WORKFLOW_SNAPSHOT_VERSION,
			revision: value.revision,
			definition,
			status: value.status as WorkflowStatus,
			nodes,
			createdAt: value.createdAt,
			updatedAt: value.updatedAt,
		};
	} catch {
		return undefined;
	}
}

export class SessionWorkflowStore implements WorkflowStore {
	readonly #sessionManager: WorkflowSessionManager;

	constructor(sessionManager: WorkflowSessionManager) {
		this.#sessionManager = sessionManager;
	}

	load(): WorkflowSnapshot | null {
		const entries = this.#sessionManager.getBranch();
		for (let index = entries.length - 1; index >= 0; index--) {
			const entry = entries[index]!;
			if (entry.type !== "custom" || entry.customType !== WORKFLOW_SESSION_CUSTOM_TYPE) continue;
			const snapshot = parseWorkflowSnapshot(entry.data);
			if (snapshot) return cloneWorkflowSnapshot(snapshot);
		}
		return null;
	}

	hasWorkflowId(id: string): boolean {
		return this.#sessionManager.getBranch().some(entry => {
			if (entry.type !== "custom" || entry.customType !== WORKFLOW_SESSION_CUSTOM_TYPE) return false;
			return parseWorkflowSnapshot(entry.data)?.definition.id === id;
		});
	}

	async append(snapshot: WorkflowSnapshot): Promise<void> {
		this.#sessionManager.appendCustomEntry(WORKFLOW_SESSION_CUSTOM_TYPE, cloneWorkflowSnapshot(snapshot));
		await this.#sessionManager.ensureOnDisk();
		await this.#sessionManager.flush();
	}
}
