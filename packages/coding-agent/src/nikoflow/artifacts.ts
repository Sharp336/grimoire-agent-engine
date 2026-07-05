import type { NikoflowTicket, TicketStatus } from "./tickets";

export type NikoflowArtifactKind = "adr" | "prd";

export interface NikoflowArtifact {
	kind: NikoflowArtifactKind;
	title: string;
	content: string;
}

export interface TodoItem {
	content: string;
	status: "pending" | "in_progress" | "completed" | "abandoned";
}

export interface TodoPhase {
	name: string;
	tasks: TodoItem[];
}

export function slugifyArtifactTitle(title: string): string {
	const slug = title
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^a-z0-9_-]/g, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "nikoflow";
}

export function artifactFileUrl(title: string, kind: NikoflowArtifactKind): string {
	return `local://${slugifyArtifactTitle(title)}-${kind}.md`;
}

export function renderArtifactMarkdown(artifact: NikoflowArtifact): string {
	const heading = artifact.kind.toUpperCase();
	return [`# ${heading}: ${artifact.title}`, "", artifact.content.trim(), ""].join("\n");
}

function todoStatus(status: TicketStatus): TodoItem["status"] {
	if (status === "done") return "completed";
	if (status === "todo") return "pending";
	return "in_progress";
}

export function ticketTodoContent(ticket: NikoflowTicket): string {
	const deps = ticket.blocked_by.length ? ` blocked_by=${ticket.blocked_by.join(",")}` : "";
	const acceptance = ticket.acceptance.length ? ` acceptance=${ticket.acceptance.join(" | ")}` : "";
	return `${ticket.id}:${deps}${acceptance} notes=${ticket.implementation_notes}`;
}

export function renderTicketTodoPhases(tickets: readonly NikoflowTicket[]): TodoPhase[] {
	return [
		{
			name: "Nikoflow Tickets",
			tasks: tickets.map(ticket => ({
				content: ticketTodoContent(ticket),
				status: todoStatus(ticket.status),
			})),
		},
	];
}
