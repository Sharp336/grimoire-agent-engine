const ERROR_ID_KEYS = ["errorId", "error_id", "requestId", "request_id", "code"] as const;
const HEADER_ID_KEYS = ["x-request-id", "request-id", "cf-ray"] as const;

export function errorIdFromError(error: unknown, _api?: string): string | undefined {
	const record = asRecord(error);
	const direct = findErrorId(record);
	if (direct) return direct;

	const header = findHeaderId(record?.headers);
	if (header) return header;

	return findHeaderId(asRecord(record?.captured)?.headers);
}

function findErrorId(value: unknown, depth = 0): string | undefined {
	if (depth > 3) return undefined;
	const record = asRecord(value);
	if (!record) return undefined;

	for (const key of ERROR_ID_KEYS) {
		const found = asNonEmptyString(record[key]);
		if (found) return found;
	}

	return (
		findErrorId(record.error, depth + 1) ??
		findErrorId(record.metadata, depth + 1) ??
		findErrorId(asRecord(record.captured)?.bodyJson, depth + 1)
	);
}

function findHeaderId(headers: unknown): string | undefined {
	if (headers instanceof Headers) {
		for (const key of HEADER_ID_KEYS) {
			const found = asNonEmptyString(headers.get(key));
			if (found) return found;
		}
		return undefined;
	}

	const record = asRecord(headers);
	if (!record) return undefined;
	for (const key of HEADER_ID_KEYS) {
		const found = asNonEmptyString(record[key]);
		if (found) return found;
	}
	return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	if (value.length === 0) return undefined;
	return value;
}
