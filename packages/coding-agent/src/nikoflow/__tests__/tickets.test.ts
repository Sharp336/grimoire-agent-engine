import { describe, expect, test } from "bun:test";
import {
	getNextTicket,
	markStatus,
	type NikoflowTicket,
	parseTicketTodoContent,
	ticketDagFromTodoPhases,
	validateTicketDag,
} from "../tickets";

const ticket = (id: string, blocked_by: string[] = [], status: NikoflowTicket["status"] = "todo"): NikoflowTicket => ({
	id,
	acceptance: [`${id} works`],
	blocked_by,
	implementation_notes: `${id} notes`,
	status,
});

describe("nikoflow tickets", () => {
	test("validates dangling deps, duplicate ids, and cycles", () => {
		expect(validateTicketDag([ticket("TSK-001"), ticket("TSK-002", ["TSK-001"])]).ok).toBe(true);

		const dangling = validateTicketDag([ticket("TSK-001", ["MISSING"])]);
		expect(dangling.ok).toBe(false);
		expect(dangling.errors.join("\n")).toContain("unknown ticket MISSING");

		const duplicate = validateTicketDag([ticket("TSK-001"), ticket("TSK-001")]);
		expect(duplicate.ok).toBe(false);
		expect(duplicate.errors.join("\n")).toContain("unique");

		const cycle = validateTicketDag([ticket("TSK-001", ["TSK-002"]), ticket("TSK-002", ["TSK-001"])]);
		expect(cycle.ok).toBe(false);
		expect(cycle.errors.join("\n")).toContain("dependency cycle");
	});

	test("returns the first unblocked unfinished ticket", () => {
		const tickets = [ticket("TSK-001", [], "done"), ticket("TSK-002", ["TSK-001"]), ticket("TSK-003", ["TSK-002"])];
		expect(getNextTicket(tickets)?.id).toBe("TSK-002");
		expect(getNextTicket(markStatus(tickets, "TSK-002", "done"))?.id).toBe("TSK-003");
		expect(getNextTicket(markStatus(markStatus(tickets, "TSK-002", "done"), "TSK-003", "done"))).toBeNull();
	});

	test("marks status immutably", () => {
		const tickets = [ticket("TSK-001")];
		const updated = markStatus(tickets, "TSK-001", "green");
		expect(updated).not.toBe(tickets);
		expect(updated[0]).not.toBe(tickets[0]);
		expect(tickets[0].status).toBe("todo");
		expect(updated[0].status).toBe("green");
	});

	test("parses ticket DAG from todo state", () => {
		expect(
			parseTicketTodoContent(
				"TSK-002: blocked_by=TSK-001 acceptance=Given A | Then B notes=touch one file",
				"in_progress",
			),
		).toEqual({
			id: "TSK-002",
			acceptance: ["Given A", "Then B"],
			blocked_by: ["TSK-001"],
			implementation_notes: "touch one file",
			status: "review",
		});

		const tickets = ticketDagFromTodoPhases([
			{
				name: "Nikoflow Tickets",
				tasks: [
					{ content: "TSK-001: acceptance=base works notes=base", status: "completed" },
					{ content: "TSK-002: blocked_by=TSK-001 acceptance=next works notes=next", status: "pending" },
				],
			},
		]);
		expect(validateTicketDag(tickets).ok).toBe(true);
		expect(tickets.map(item => [item.id, item.status])).toEqual([
			["TSK-001", "done"],
			["TSK-002", "todo"],
		]);
	});
});
