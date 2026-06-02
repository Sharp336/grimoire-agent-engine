import type { Langfuse } from "langfuse";

const _PANTHEON_DOMAINS: Record<string, string[]> = {
	work: ["work", "usmobile", "ai-monorepo", "other", "infra-monorepo"],
	notes: ["notes", "vault", "obsidian", "20_drafts", "30_notes", "60_traces"],
	tooling: ["tools", "hermes", "arachne", "minerva", "mcp-", "shoal", "oh-my-pi", "pisces"],
	infra: ["infra", "mcp-servers", "deploy", "containers", "podman", "caddy", "langfuse"],
	personal: ["projects", "dashboard", "sandbox", "propflow", "grove", "opus"],
	dotfiles: ["dotfiles", "components/", ".config", "stow"],
};

export function detectDomain(cwd?: string): string {
	const dir = cwd || process.cwd();
	const lc = dir.toLowerCase();
	for (const [domain, keywords] of Object.entries(_PANTHEON_DOMAINS)) {
		for (const kw of keywords) {
			if (lc.includes(kw)) return domain;
		}
	}
	return "";
}

let _client: Langfuse | null = null;

/** Lazily import the langfuse SDK so it is never loaded when telemetry is disabled. */
export async function getLangfuseClient(): Promise<Langfuse | null> {
	if (_client) return _client;

	const publicKey = process.env.LANGFUSE_PUBLIC_KEY || process.env.HERMES_LANGFUSE_PUBLIC_KEY;
	const secretKey = process.env.LANGFUSE_SECRET_KEY || process.env.HERMES_LANGFUSE_SECRET_KEY;
	const host = process.env.LANGFUSE_HOST || process.env.HERMES_LANGFUSE_BASE_URL || "https://cloud.langfuse.com";

	if (!publicKey || !secretKey) return null;

	try {
		const mod = await import("langfuse");
		_client = new mod.Langfuse({
			publicKey,
			secretKey,
			baseUrl: host,
		});
		return _client;
	} catch {
		return null;
	}
}

export async function addTraceScore(traceId: string, name: string, value: number, comment?: string): Promise<void> {
	const client = await getLangfuseClient();
	if (!client) return;

	try {
		await client.score({
			traceId,
			name,
			value,
			comment,
		});
	} catch {
		// fail-open
	}
}

export async function updateTraceTags(traceId: string, tags: string[]): Promise<void> {
	const client = await getLangfuseClient();
	if (!client) return;

	try {
		await client.trace({
			id: traceId,
			tags,
		});
	} catch {
		// fail-open
	}
}

export async function updateTraceMetadata(traceId: string, metadata: Record<string, unknown>): Promise<void> {
	const client = await getLangfuseClient();
	if (!client) return;

	try {
		await client.trace({
			id: traceId,
			metadata,
		});
	} catch {
		// fail-open
	}
}

export async function queryRecentTraces(
	limit: number = 10,
	sessionId?: string,
): Promise<Array<{ id: string; name: string; tags: string[]; metadata: Record<string, unknown> }>> {
	const publicKey = process.env.LANGFUSE_PUBLIC_KEY || process.env.HERMES_LANGFUSE_PUBLIC_KEY;
	const secretKey = process.env.LANGFUSE_SECRET_KEY || process.env.HERMES_LANGFUSE_SECRET_KEY;
	const host = process.env.LANGFUSE_HOST || process.env.HERMES_LANGFUSE_BASE_URL || "https://cloud.langfuse.com";

	if (!publicKey || !secretKey) return [];

	try {
		const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
		const url = new URL("/api/public/traces", host);
		url.searchParams.set("limit", String(limit));
		if (sessionId) url.searchParams.set("sessionId", sessionId);

		const res = await fetch(url.toString(), {
			headers: { Authorization: `Basic ${auth}` },
		});
		if (!res.ok) return [];
		const data = (await res.json()) as any;
		return (data.data || []).map((t: any) => ({
			id: t.id,
			name: t.name || "",
			tags: t.tags || [],
			metadata: t.metadata || {},
		}));
	} catch {
		return [];
	}
}
