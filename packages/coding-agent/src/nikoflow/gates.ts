export interface NikoflowGrillingMarker {
	openQuestions: readonly string[];
	assumptions: readonly string[];
	risks: readonly string[];
}

export function jsonRecordFromValue(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object") return value as Record<string, unknown>;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	const direct = parseJsonRecord(trimmed);
	if (direct) return direct;
	const start = trimmed.indexOf("{");
	if (start < 0) return null;
	for (let end = trimmed.lastIndexOf("}"); end > start; end = trimmed.lastIndexOf("}", end - 1)) {
		const parsed = parseJsonRecord(trimmed.slice(start, end + 1));
		if (parsed) return parsed;
	}
	return null;
}

export function normalizeNikoflowGrillingMarker(value: unknown): NikoflowGrillingMarker | null {
	const root = jsonRecordFromValue(value);
	const marker = jsonRecordFromValue(root?.nikoflow_grilling);
	const openQuestions = stringList(marker?.open_questions);
	if (!openQuestions) return null;
	return {
		openQuestions,
		assumptions: stringList(marker?.assumptions) ?? [],
		risks: stringList(marker?.risks) ?? [],
	};
}

export function humanGateAccepted(
	gateMintedAt: number | null | undefined,
	userTurnAt: number | null | undefined,
): boolean {
	return gateMintedAt != null && userTurnAt != null && userTurnAt > gateMintedAt;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(value) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function stringList(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const result: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") return null;
		const text = item.trim();
		if (text.length > 0) result.push(text);
	}
	return result;
}
