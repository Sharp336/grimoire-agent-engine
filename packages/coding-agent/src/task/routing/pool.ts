import type { ResourcePoolIdentity } from "./types";

function normalizeBaseUrl(raw?: string): string | undefined {
	if (!raw) return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	const withoutTrailing = trimmed.replace(/\/+$/, "");
	if (!withoutTrailing) return undefined;
	try {
		const url = new URL(withoutTrailing);
		url.hostname = url.hostname.toLowerCase();
		let rebuilt = `${url.protocol}//${url.host}${url.pathname}${url.search}${url.hash}`;
		rebuilt = rebuilt.replace(/\/+$/, "");
		if (rebuilt === `${url.protocol}//${url.host}`) {
			return rebuilt;
		}
		// URL with pathname "/" becomes ".../" -> stripped above -> bare host
		return rebuilt;
	} catch {
		return withoutTrailing.toLowerCase();
	}
}

function deriveAccountKey(input: { accountId?: string; email?: string; credentialKind?: string }): string {
	const accountId = input.accountId?.trim();
	if (accountId) return accountId.toLowerCase();
	const email = input.email?.trim();
	if (email) return email.toLowerCase();
	const kind = input.credentialKind?.trim().toLowerCase();
	if (!kind) return "none";
	if (kind.includes("env")) return "env";
	if (
		kind.includes("api") ||
		kind.includes("key") ||
		kind.includes("stored") ||
		kind.includes("runtime") ||
		kind.includes("config")
	)
		return "api-key";
	return "none";
}

export function resolveResourcePool(input: {
	provider: string;
	baseUrl?: string;
	accountId?: string;
	email?: string;
	credentialKind?: string;
}): ResourcePoolIdentity {
	const provider = input.provider.trim().toLowerCase();
	const normalizedBaseUrl = normalizeBaseUrl(input.baseUrl);
	const accountKey = deriveAccountKey(input);
	const key = `${provider}\0${normalizedBaseUrl ?? ""}\0${accountKey}`;
	const label =
		accountKey === "api-key" || accountKey === "env" || accountKey === "none"
			? provider
			: `${provider} (${accountKey})`;
	return {
		key,
		provider,
		baseUrl: normalizedBaseUrl,
		accountKey,
		label,
	};
}
