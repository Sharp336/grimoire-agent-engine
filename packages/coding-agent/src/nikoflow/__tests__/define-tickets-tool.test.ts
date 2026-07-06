import { describe, expect, test } from "bun:test";
import type { ToolSession } from "../../sdk";
import { NikoflowDefineTicketsTool } from "../../tools/nikoflow-define-tickets";
import { advancePhase, createState, setTicketDag } from "../state";
import { type NikoflowTicketDefinitionResult, type NikoflowTicketInput, normalizeDefinedTickets } from "../tickets";

function ticketizationState() {
	return advancePhase(advancePhase(advancePhase(createState("standard"))));
}

describe("nikoflow_define_tickets tool", () => {
	test("populates the executable DAG through structured input", async () => {
		let state = ticketizationState();
		const persisted: NikoflowTicketDefinitionResult[] = [];
		const session = {
			defineNikoflowTickets(tickets: readonly NikoflowTicketInput[]): NikoflowTicketDefinitionResult {
				const result = normalizeDefinedTickets(tickets);
				if (result.errors.length > 0) return result;
				state = setTicketDag(state, result.tickets);
				const stored = { tickets: state.tickets, errors: [] };
				persisted.push(stored);
				return stored;
			},
		} satisfies Partial<ToolSession>;

		const tool = new NikoflowDefineTicketsTool(session as ToolSession);
		const result = await tool.execute("call-1", {
			tickets: [
				{
					id: "TSK-001",
					acceptance: ["base works"],
					blocked_by: [],
					implementation_notes: "touch one helper",
				},
				{
					id: "TSK-002",
					acceptance: ["dependent works"],
					blocked_by: ["TSK-001"],
					implementation_notes: "reuse helper",
				},
			],
		});

		expect(result.isError).toBeUndefined();
		expect(state.tickets.map(ticket => [ticket.id, ticket.status, ticket.blocked_by.join(",")])).toEqual([
			["TSK-001", "todo", ""],
			["TSK-002", "todo", "TSK-001"],
		]);
		expect(persisted).toHaveLength(1);
		expect(result.details?.stored).toBe(true);
	});

	test("rejects malformed DAGs without mutating state", async () => {
		let state = ticketizationState();
		const session = {
			defineNikoflowTickets(tickets: readonly NikoflowTicketInput[]): NikoflowTicketDefinitionResult {
				const result = normalizeDefinedTickets(tickets);
				if (result.errors.length === 0) state = setTicketDag(state, result.tickets);
				return result;
			},
		} satisfies Partial<ToolSession>;

		const tool = new NikoflowDefineTicketsTool(session as ToolSession);
		const result = await tool.execute("call-1", {
			tickets: [
				{
					id: "TSK-001",
					acceptance: ["base works"],
					blocked_by: ["TSK-002"],
					implementation_notes: "base",
				},
				{
					id: "TSK-002",
					acceptance: ["next works"],
					blocked_by: ["TSK-001"],
					implementation_notes: "next",
				},
			],
		});

		expect(result.isError).toBe(true);
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("dependency cycle");
		expect(result.details?.stored).toBe(false);
		expect(state.tickets).toEqual([]);
	});
});
