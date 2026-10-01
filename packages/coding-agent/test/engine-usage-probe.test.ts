import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDbPath } from "@oh-my-pi/pi-utils/dirs";
import type { RocksEngineMutations } from "../src/engine/rocks-store";
import { runUsageProbe } from "../src/engine/usage-probe";
import { SqliteAuthCredentialStore } from "../src/session/auth-storage";

const AMBIENT = "ambient-env-secret-must-not-egress";
const readers = [
	{ builtinId: "openai_codex_usage", provider: "openai-codex", env: "OPENAI_API_KEY" },
	{ builtinId: "anthropic_claude_usage", provider: "anthropic", env: "ANTHROPIC_API_KEY" },
	{ builtinId: "cursor_usage", provider: "cursor", env: "CURSOR_API_KEY" },
] as const;

function cursorJwt(sub: string): string {
	const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode({ sub, exp: 4_102_444_800 })}.sig`;
}

describe("Engine builtin usage readers", () => {
	const cleanup: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		for (const step of cleanup.splice(0).reverse()) await step();
	});

	it.each(readers)("$builtinId reads only the exact claimed credential row", async ({ builtinId, provider, env }) => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "engine-usage-probe-"));
		cleanup.push(() => fs.rm(agentDir, { recursive: true, force: true }));
		const access = provider === "cursor" ? cursorJwt("user_claimed") : `claimed-access-${provider}`;
		const store = await SqliteAuthCredentialStore.open(getAgentDbPath(agentDir));
		const [row] = store.upsertAuthCredentialForProvider(provider, {
			type: "oauth", access, refresh: "claimed-refresh", expires: Date.now() + 86_400_000,
			accountId: provider === "cursor" ? "user_claimed" : "acct-claimed",
		});
		store.close();
		const previous = process.env[env];
		process.env[env] = AMBIENT;
		cleanup.push(() => {
			if (previous === undefined) delete process.env[env];
			else process.env[env] = previous;
		});
		const sent: string[] = [];
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(input instanceof Request ? input.headers : undefined);
			for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
			sent.push(`${String(input instanceof Request ? input.url : input)} ${JSON.stringify([...headers])}`);
			return new Response("unavailable", { status: 503 });
		}) as typeof fetch);
		cleanup.push(() => fetchSpy.mockRestore());
		// Builtin readers never consult module bindings, so no Rocks owner is involved.
		const probe = (accountId: string, providerId: string = provider) =>
			runUsageProbe({} as RocksEngineMutations, "device", {
				principalId: "grimoire:user:owner", accountRef: "gctx:account", kind: "builtin", builtinId, builtinVersion: 1,
				account: { provider_id: providerId, external_id: null, pools: [], quota_windows: [] },
				credential: { method: "oauth", store: "local_omp", agentDir, accountId, credentialId: row!.id },
			});

		// Wrong claimed account or another provider's Account never opens a credential or reaches the network.
		expect(await probe("acct-other")).toEqual({ status: "credential_unavailable_on_device", observations: [] });
		expect(await probe(provider === "cursor" ? "user_claimed" : "acct-claimed", "other-provider"))
			.toEqual({ status: "builtin_unsupported", observations: [] });
		expect(sent).toEqual([]);

		// The exact claim egresses only with its own token, never an ambient environment key, and a
		// failed fresh read is unavailable rather than a replayed last-good report.
		expect(await probe(provider === "cursor" ? "user_claimed" : "acct-claimed"))
			.toEqual({ status: "unavailable", observations: [] });
		expect(sent.join("\n")).not.toContain(AMBIENT);
		for (const request of sent) expect(request).toContain(access);
	});
});
