export type TicketStatus = "todo" | "red" | "green" | "review" | "done";

export const TICKET_STATUSES: readonly TicketStatus[] = ["todo", "red", "green", "review", "done"];

export interface NikoflowTicket {
	id: string;
	acceptance: string[];
	blocked_by: string[];
	implementation_notes: string;
	status: TicketStatus;
}

export interface DagValidation {
	ok: boolean;
	errors: string[];
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

export function getNextTicket(tickets: readonly NikoflowTicket[]): NikoflowTicket | null {
	const done = new Set(tickets.filter(ticket => ticket.status === "done").map(ticket => ticket.id));
	return tickets.find(ticket => ticket.status !== "done" && ticket.blocked_by.every(dep => done.has(dep))) ?? null;
}

export function markStatus(tickets: readonly NikoflowTicket[], id: string, status: TicketStatus): NikoflowTicket[] {
	return tickets.map(ticket => (ticket.id === id ? { ...ticket, status } : ticket));
}
