import { isRecord } from "@oh-my-pi/pi-utils";
import {
	WORKFLOW_DEFINITION_VERSION,
	WORKFLOW_FAILURE_POLICY,
	type WorkflowDefinition,
	type WorkflowNode,
} from "./types";

export const MAX_WORKFLOW_NODES = 100;

const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${field} must be a non-empty string`);
	}
	return value.trim();
}

function workflowId(value: unknown, field: string): string {
	const id = requiredString(value, field);
	if (!WORKFLOW_ID_PATTERN.test(id)) {
		throw new Error(
			`${field} must start with an alphanumeric character and contain at most 64 letters, numbers, "_" or "-"`,
		);
	}
	return id;
}

function parseNeeds(value: unknown, nodeId: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw new Error(`Workflow node "${nodeId}" needs must be an array of node ids`);
	}
	const needs = value.map((dependency, index) =>
		workflowId(dependency, `Workflow node "${nodeId}" dependency ${index + 1}`),
	);
	const duplicate = needs.find((dependency, index) => needs.indexOf(dependency) !== index);
	if (duplicate) {
		throw new Error(`Workflow node "${nodeId}" lists dependency "${duplicate}" more than once`);
	}
	return needs.length > 0 ? needs : undefined;
}

function parseNode(value: unknown, index: number): WorkflowNode {
	if (!isRecord(value)) {
		throw new Error(`Workflow node ${index + 1} must be an object`);
	}
	const id = workflowId(value.id, `Workflow node ${index + 1} id`);
	const node: WorkflowNode = {
		id,
		agent: requiredString(value.agent, `Workflow node "${id}" agent`),
		task: requiredString(value.task, `Workflow node "${id}" task`),
	};
	const needs = parseNeeds(value.needs, id);
	if (needs) node.needs = needs;
	if (Object.hasOwn(value, "outputSchema")) node.outputSchema = structuredClone(value.outputSchema);
	if (value.schemaMode !== undefined) {
		if (value.schemaMode !== "permissive" && value.schemaMode !== "strict") {
			throw new Error(`Workflow node "${id}" schemaMode must be "permissive" or "strict"`);
		}
		node.schemaMode = value.schemaMode;
	}
	if (value.isolated !== undefined) {
		if (typeof value.isolated !== "boolean") {
			throw new Error(`Workflow node "${id}" isolated must be a boolean`);
		}
		node.isolated = value.isolated;
	}
	return node;
}

function assertAcyclic(nodes: WorkflowNode[]): void {
	const indegree = new Map(nodes.map(node => [node.id, node.needs?.length ?? 0]));
	const dependents = new Map<string, string[]>();
	for (const node of nodes) {
		for (const dependency of node.needs ?? []) {
			const existing = dependents.get(dependency) ?? [];
			existing.push(node.id);
			dependents.set(dependency, existing);
		}
	}
	const queue = nodes.filter(node => indegree.get(node.id) === 0).map(node => node.id);
	let visited = 0;
	for (let index = 0; index < queue.length; index++) {
		const id = queue[index]!;
		visited += 1;
		for (const dependent of dependents.get(id) ?? []) {
			const next = (indegree.get(dependent) ?? 0) - 1;
			indegree.set(dependent, next);
			if (next === 0) queue.push(dependent);
		}
	}
	if (visited !== nodes.length) {
		const cyclic = nodes.filter(node => (indegree.get(node.id) ?? 0) > 0).map(node => node.id);
		throw new Error(`Workflow contains a dependency cycle involving: ${cyclic.join(", ")}`);
	}
}

export function parseWorkflowDefinition(value: unknown): WorkflowDefinition {
	if (!isRecord(value)) {
		throw new Error("Workflow definition must be an object");
	}
	if (value.version !== WORKFLOW_DEFINITION_VERSION) {
		throw new Error(`Workflow definition version must be ${WORKFLOW_DEFINITION_VERSION}`);
	}
	if (value.failurePolicy !== WORKFLOW_FAILURE_POLICY) {
		throw new Error(`Workflow failurePolicy must be "${WORKFLOW_FAILURE_POLICY}"`);
	}
	if (!Array.isArray(value.nodes) || value.nodes.length === 0) {
		throw new Error("Workflow must contain at least one node");
	}
	if (value.nodes.length > MAX_WORKFLOW_NODES) {
		throw new Error(`Workflow cannot contain more than ${MAX_WORKFLOW_NODES} nodes`);
	}

	const nodes = value.nodes.map(parseNode);
	const ids = new Set<string>();
	for (const node of nodes) {
		if (ids.has(node.id)) throw new Error(`Duplicate workflow node id "${node.id}"`);
		ids.add(node.id);
	}
	for (const node of nodes) {
		for (const dependency of node.needs ?? []) {
			if (dependency === node.id) {
				throw new Error(`Workflow node "${node.id}" cannot depend on itself`);
			}
			if (!ids.has(dependency)) {
				throw new Error(`Workflow node "${node.id}" depends on missing node "${dependency}"`);
			}
		}
	}
	assertAcyclic(nodes);

	return {
		version: WORKFLOW_DEFINITION_VERSION,
		id: workflowId(value.id, "Workflow id"),
		objective: requiredString(value.objective, "Workflow objective"),
		failurePolicy: WORKFLOW_FAILURE_POLICY,
		nodes,
	};
}
