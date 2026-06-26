export type InvestigationMode =
	| "docs"
	| "web"
	| "source"
	| "code_experiment"
	| "reproduction"
	| "compatibility"
	| "benchmark"
	| "browser_probe";

export type InvestigationRisk = "background" | "could_change_direction" | "potential_blocker";
export type InvestigationStatus = "queued" | "running" | "ready" | "failed";

export interface InvestigationRequestInput {
	question: string;
	objective: string;
	mode: InvestigationMode;
	risk: InvestigationRisk;
	constraints?: string[];
}

export interface InvestigationRecord extends InvestigationRequestInput {
	id: string;
	status: InvestigationStatus;
	requestedBy: "advisor";
	createdAt: number;
	updatedAt: number;
	sessionId?: string;
	baseRevision?: string;
	artifactId?: string;
	artifactUrl?: string;
	summary?: string;
	error?: string;
	advisorDelivery: "pending" | "claimed" | "delivered";
}

export interface AdvisorInvestigationUpdateBatch {
	ids: readonly string[];
	text: string;
}
