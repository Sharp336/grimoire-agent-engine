import { describe, expect, test } from "bun:test";
import {
	artifactFileUrl,
	type NikoflowArtifact,
	renderArtifactMarkdown,
	renderTicketTodoPhases,
	slugifyArtifactTitle,
} from "../artifacts";
import { type NikoflowTicket, ticketDagFromTodoPhases } from "../tickets";

describe("nikoflow artifacts", () => {
	test("renders stable local artifact urls", () => {
		expect(slugifyArtifactTitle("Auth Plan!")).toBe("auth-plan");
		expect(artifactFileUrl("Auth Plan!", "adr")).toBe("local://auth-plan-adr.md");
		expect(artifactFileUrl("???", "prd")).toBe("local://nikoflow-prd.md");
	});

	test("renders markdown artifact content", () => {
		const artifact: NikoflowArtifact = { kind: "adr", title: "Auth", content: "Decision." };
		expect(renderArtifactMarkdown(artifact)).toBe("# ADR: Auth\n\nDecision.\n");
	});

	test("renders ticket DAG into todo phases", () => {
		const tickets: NikoflowTicket[] = [
			{
				id: "TSK-001",
				acceptance: ["works"],
				blocked_by: [],
				implementation_notes: "small diff",
				status: "done",
			},
			{
				id: "TSK-002",
				acceptance: ["reviewed"],
				blocked_by: ["TSK-001"],
				implementation_notes: "use helper",
				status: "review",
			},
		];

		expect(renderTicketTodoPhases(tickets)).toEqual([
			{
				name: "Nikoflow Tickets",
				tasks: [
					{ content: "TSK-001: acceptance=works notes=small diff", status: "completed" },
					{
						content: "TSK-002: blocked_by=TSK-001 acceptance=reviewed notes=use helper",
						status: "in_progress",
					},
				],
			},
		]);
	});

	test("ticket DAG survives a todo-state round trip", () => {
		const tickets: NikoflowTicket[] = [
			{
				id: "TSK-001",
				acceptance: ["base works"],
				blocked_by: [],
				implementation_notes: "base",
				status: "done",
			},
			{
				id: "TSK-002",
				acceptance: ["next works"],
				blocked_by: ["TSK-001"],
				implementation_notes: "next",
				status: "todo",
			},
		];

		expect(ticketDagFromTodoPhases(renderTicketTodoPhases(tickets))).toEqual(tickets);
	});
});
