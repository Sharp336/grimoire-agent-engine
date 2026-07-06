import { cloneTickets, type NikoflowTicket } from "./tickets";

export const NIKOFLOW_DEPTHS = ["tactical", "standard", "deep"] as const;
export type NikoflowDepth = (typeof NIKOFLOW_DEPTHS)[number];

export type NikoflowPhase = "grilling" | "adr" | "prd" | "tickets" | "execute" | "verify";

export const NIKOFLOW_PHASES: Record<NikoflowDepth, readonly NikoflowPhase[]> = {
	tactical: ["grilling", "execute", "verify"],
	standard: ["grilling", "adr", "prd", "tickets", "execute", "verify"],
	deep: ["grilling", "adr", "prd", "tickets", "execute", "verify"],
} as const;

export type NikoflowRole = "plan" | "default" | "advisor";

export const PHASE_ROLE: Record<NikoflowPhase, NikoflowRole> = {
	grilling: "plan",
	adr: "plan",
	prd: "plan",
	tickets: "plan",
	execute: "default",
	verify: "advisor",
} as const;

export interface NikoflowState {
	depth: NikoflowDepth;
	autonomous: boolean;
	phaseIndex: number;
	gateRequestId: string | null;
	gateMintedAt: number | null;
	batchGateAcceptedAt: number | null;
	phaseTurnStarted: boolean;
	tickets: NikoflowTicket[];
	activeTicketId: string | null;
}

export function createState(depth: NikoflowDepth, options: { autonomous?: boolean } = {}): NikoflowState {
	return {
		depth,
		autonomous: options.autonomous === true,
		phaseIndex: 0,
		gateRequestId: null,
		gateMintedAt: null,
		batchGateAcceptedAt: null,
		phaseTurnStarted: false,
		tickets: [],
		activeTicketId: null,
	};
}

export function materializePhases(depth: NikoflowDepth): NikoflowPhase[] {
	return [...NIKOFLOW_PHASES[depth]];
}

export function inferDepthFromPrompt(prompt: string): NikoflowDepth | null {
	const activation = /(?:\$?nikoflow|niko[\s-]+flow|nflow|нико[\s-]*флоу)/i.test(prompt);
	if (!activation) return null;
	const explicit = /(?:\$?nikoflow|niko[\s-]+flow|nflow|нико[\s-]*флоу)(?::|\s+)?(tactical|standard|deep)\b/i.exec(
		prompt,
	);
	if (explicit?.[1]) return explicit[1].toLowerCase() as NikoflowDepth;
	if (
		/(?:не\s+(?:задавай\s+вопросов|спрашивай)|без\s+вопросов|no\s+questions|do\s+not\s+ask|don't\s+ask)/i.test(prompt)
	) {
		return "standard";
	}
	return null;
}

export function currentPhase(state: NikoflowState): NikoflowPhase | null {
	return materializePhases(state.depth)[state.phaseIndex] ?? null;
}

export function currentRole(state: NikoflowState): NikoflowRole | null {
	const phase = currentPhase(state);
	return phase ? PHASE_ROLE[phase] : null;
}

export function isHumanGatePhase(state: NikoflowState): boolean {
	const phase = currentPhase(state);
	return phase === "grilling" || phase === "adr" || phase === "prd" || phase === "tickets";
}

export function advancePhase(state: NikoflowState): NikoflowState {
	const nextIndex = Math.min(state.phaseIndex + 1, materializePhases(state.depth).length);
	const nextPhase = materializePhases(state.depth)[nextIndex] ?? null;
	return {
		...state,
		phaseIndex: nextIndex,
		gateRequestId: null,
		gateMintedAt: null,
		batchGateAcceptedAt: null,
		phaseTurnStarted: false,
		activeTicketId: nextPhase === "execute" ? state.activeTicketId : null,
	};
}

export function isComplete(state: NikoflowState): boolean {
	return state.phaseIndex >= materializePhases(state.depth).length;
}

export function mintGateRequest(state: NikoflowState, id: string, mintedAt: number | null = null): NikoflowState {
	return { ...state, gateRequestId: id, gateMintedAt: mintedAt, batchGateAcceptedAt: null };
}

export function rotateGateRequest(state: NikoflowState, id: string, mintedAt: number | null = null): NikoflowState {
	return mintGateRequest(state, id, mintedAt);
}

export function clearGateRequest(state: NikoflowState): NikoflowState {
	return { ...state, gateRequestId: null, gateMintedAt: null };
}

export function gateMatches(state: NikoflowState, id: string | null | undefined): boolean {
	return id != null && state.gateRequestId === id;
}

export function markPhaseTurnStarted(state: NikoflowState): NikoflowState {
	return state.phaseTurnStarted ? state : { ...state, phaseTurnStarted: true };
}

export function setTicketDag(state: NikoflowState, tickets: readonly NikoflowTicket[]): NikoflowState {
	return { ...state, tickets: cloneTickets(tickets), activeTicketId: null };
}

export function currentTicket(state: NikoflowState): NikoflowTicket | null {
	return state.tickets.find(ticket => ticket.id === state.activeTicketId) ?? null;
}
