export type ExplicitProfileSource = "cli" | "environment";

export interface ExplicitProfileSelection {
	profile?: string;
	source: ExplicitProfileSource;
}

let explicitSelection: ExplicitProfileSelection | undefined;

export function setExplicitProfileSelection(selection: ExplicitProfileSelection | undefined): void {
	explicitSelection = selection;
}

export function getExplicitProfileSelection(): ExplicitProfileSelection | undefined {
	return explicitSelection;
}
