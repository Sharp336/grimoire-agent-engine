import { currentPhase, currentRole, currentTicket, type NikoflowState } from "./state";
import { getNextTicket } from "./tickets";

const PHASE_PROMPTS: Record<string, string> = {
	grilling:
		"Grilling phase. Read code before asking. Confirm scope, risks, and success criteria. No implementation writes.",
	adr: "ADR phase. Record only hard-to-reverse tradeoffs. Otherwise write a visible skip reason.",
	prd: "PRD phase. Write user stories with Given/When/Then acceptance criteria and test seams.",
	tickets:
		"Ticketization phase. Split the PRD into dependency-ordered vertical tickets and persist them with todo. Use task lines exactly like `TSK-001: blocked_by=TSK-000 acceptance=Given/When/Then A | Given/When/Then B notes=implementation notes`; omit blocked_by when empty.",
	execute:
		"Execute phase. Work one unblocked ticket at a time. Start with a failing test, then implement the minimum code, then request independent review.",
	verify:
		"Verify phase. Run local validation and require an independent structured reviewer verdict. No primary self-approval.",
};

export function getPhasePrompt(state: NikoflowState): string {
	const phase = currentPhase(state);
	if (!phase) return "Nikoflow is complete.";
	const ticket = phase === "execute" ? (currentTicket(state) ?? getNextTicket(state.tickets)) : null;
	const ticketContext = ticket
		? [
				`Active ticket: ${ticket.id}`,
				"Acceptance:",
				...(ticket.acceptance.length > 0 ? ticket.acceptance.map(item => `- ${item}`) : ["- (not supplied)"]),
				`Implementation notes: ${ticket.implementation_notes || "(not supplied)"}`,
			]
		: [];
	return [
		`Nikoflow phase: ${phase}`,
		`Required role: ${currentRole(state)}`,
		`Gate request: ${state.gateRequestId ?? "none"}`,
		PHASE_PROMPTS[phase],
		...ticketContext,
		"Visible artifacts only. Do not rely on hidden reasoning across phase boundaries.",
	].join("\n");
}

export function getCurrentPhaseProtocol(state: NikoflowState): string {
	return `<nikoflow-context>\n${getPhasePrompt(state)}\n</nikoflow-context>`;
}
