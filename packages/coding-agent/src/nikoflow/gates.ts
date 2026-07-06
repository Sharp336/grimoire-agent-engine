export function humanGateAccepted(
	gateMintedAt: number | null | undefined,
	userTurnAt: number | null | undefined,
): boolean {
	return gateMintedAt != null && userTurnAt != null && userTurnAt > gateMintedAt;
}
