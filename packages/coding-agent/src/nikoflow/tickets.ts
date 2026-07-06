export type TicketStatus = "todo" | "red" | "green" | "review" | "done";

export const TICKET_STATUSES: readonly TicketStatus[] = ["todo", "red", "green", "review", "done"];

export interface NikoflowTicket {
	id: string;
	acceptance: string[];
	blocked_by: string[];
	implementation_notes: string;
	status: TicketStatus;
}

export const NIKOFLOW_DEFINE_TICKETS_TOOL_NAME = "nikoflow_define_tickets";

export interface NikoflowTicketInput {
	id: string;
	acceptance: string[];
	blocked_by?: string[];
	implementation_notes: string;
}

export interface NikoflowTicketDefinitionResult {
	tickets: NikoflowTicket[];
	errors: string[];
}

export interface TicketTodoTask {
	content: string;
	status: "pending" | "in_progress" | "completed" | "abandoned";
}

export interface TicketTodoPhase {
	name: string;
	tasks: TicketTodoTask[];
}

export interface DagValidation {
	ok: boolean;
	errors: string[];
}

export function cloneTickets(tickets: readonly NikoflowTicket[]): NikoflowTicket[] {
	return tickets.map(ticket => ({
		id: ticket.id,
		acceptance: [...ticket.acceptance],
		blocked_by: [...ticket.blocked_by],
		implementation_notes: ticket.implementation_notes,
		status: ticket.status,
	}));
}

function ticketSet(tickets: readonly NikoflowTicket[]): Set<string> {
	return new Set(tickets.map(ticket => ticket.id));
}

export function validateTicketDag(tickets: readonly NikoflowTicket[]): DagValidation {
	const errors: string[] = [];
	const ids = ticketSet(tickets);
	if (ids.size !== tickets.length) errors.push("ticket ids must be unique");

	for (const ticket of tickets) {
		for (const dep of ticket.blocked_by) {
			if (!ids.has(dep)) errors.push(`${ticket.id} blocked_by unknown ticket ${dep}`);
		}
	}

	const visiting = new Set<string>();
	const visited = new Set<string>();
	const byId = new Map(tickets.map(ticket => [ticket.id, ticket]));

	const visit = (id: string, path: string[]): void => {
		if (visited.has(id)) return;
		if (visiting.has(id)) {
			errors.push(`dependency cycle: ${[...path, id].join(" -> ")}`);
			return;
		}
		const ticket = byId.get(id);
		if (!ticket) return;
		visiting.add(id);
		for (const dep of ticket.blocked_by) {
			visit(dep, [...path, id]);
		}
		visiting.delete(id);
		visited.add(id);
	};

	for (const ticket of tickets) {
		visit(ticket.id, []);
	}

	return { ok: errors.length === 0, errors };
}

function cleanList(values: readonly string[]): string[] {
	return values.map(value => value.trim()).filter(Boolean);
}

export function normalizeDefinedTickets(inputs: readonly NikoflowTicketInput[]): NikoflowTicketDefinitionResult {
	const errors: string[] = [];
	const tickets: NikoflowTicket[] = inputs.map((input, index) => {
		const position = index + 1;
		const id = input.id.trim();
		const acceptance = cleanList(input.acceptance);
		const blocked_by = cleanList(input.blocked_by ?? []);
		const implementation_notes = input.implementation_notes.trim();

		if (!id) errors.push(`ticket ${position} id is required`);
		if (acceptance.length === 0) errors.push(`ticket ${id || position} acceptance must not be empty`);
		if (!implementation_notes) errors.push(`ticket ${id || position} implementation_notes is required`);

		return {
			id,
			acceptance,
			blocked_by,
			implementation_notes,
			status: "todo",
		};
	});

	if (tickets.length === 0) errors.push("ticket list must not be empty");
	const validation = validateTicketDag(tickets);
	errors.push(...validation.errors);
	return { tickets, errors };
}

export function getNextTicket(tickets: readonly NikoflowTicket[]): NikoflowTicket | null {
	const done = new Set(tickets.filter(ticket => ticket.status === "done").map(ticket => ticket.id));
	return tickets.find(ticket => ticket.status !== "done" && ticket.blocked_by.every(dep => done.has(dep))) ?? null;
}

export function markStatus(tickets: readonly NikoflowTicket[], id: string, status: TicketStatus): NikoflowTicket[] {
	return tickets.map(ticket => (ticket.id === id ? { ...ticket, status } : ticket));
}

function todoStatus(status: TicketTodoTask["status"]): TicketStatus {
	if (status === "completed") return "done";
	if (status === "in_progress") return "review";
	return "todo";
}

export function parseTicketTodoContent(
	content: string,
	status: TicketTodoTask["status"] = "pending",
): NikoflowTicket | null {
	const separator = content.indexOf(":");
	if (separator <= 0) return null;
	const id = content.slice(0, separator).trim();
	const body = content.slice(separator + 1).trim();
	if (!id) return null;
	if (!/\b(?:acceptance|notes)=/.test(body)) return null;

	const notesMarker = " notes=";
	const notesIndex = body.lastIndexOf(notesMarker);
	const fields = notesIndex >= 0 ? body.slice(0, notesIndex).trim() : body;
	const implementation_notes = notesIndex >= 0 ? body.slice(notesIndex + notesMarker.length).trim() : "";
	const blockedMatch = /(?:^|\s)blocked_by=([^\s]+)/.exec(fields);
	const acceptanceMatch = /(?:^|\s)acceptance=(.*)$/.exec(fields);
	const acceptance =
		acceptanceMatch?.[1]
			?.split(" | ")
			.map(item => item.trim())
			.filter(Boolean) ?? [];

	return {
		id,
		acceptance,
		blocked_by:
			blockedMatch?.[1]
				.split(",")
				.map(dep => dep.trim())
				.filter(Boolean) ?? [],
		implementation_notes,
		status: todoStatus(status),
	};
}

export function ticketDagFromTodoPhases(phases: readonly TicketTodoPhase[]): NikoflowTicket[] {
	const tickets: NikoflowTicket[] = [];
	for (const phase of phases) {
		for (const task of phase.tasks) {
			const ticket = parseTicketTodoContent(task.content, task.status);
			if (ticket) tickets.push(ticket);
		}
	}
	return tickets;
}
