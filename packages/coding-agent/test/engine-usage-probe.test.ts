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

type Account = {
	provider_id: string;
	external_id: null;
	pools: Array<{ pool_id: string }>;
	quota_windows: Array<{ window_id: string; window_seconds: number }>;
};

function cursorJwt(sub: string): string {
	const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none" })}.${encode({ sub, exp: 4_102_444_800 })}.sig`;
}

describe("Engine builtin usage readers", () => {
	const cleanup: Array<() => Promise<void> | void> = [];
	afterEach(async () => {
		for (const step of cleanup.splice(0).reverse()) await step();
	});

	/** One stored local OMP OAuth row; `accountId: undefined` is a row minted before logins recorded it. */
	async function storedRow(provider: string, access: string, accountId: string | undefined) {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "engine-usage-probe-"));
		cleanup.push(() => fs.rm(agentDir, { recursive: true, force: true }));
		const store = await SqliteAuthCredentialStore.open(getAgentDbPath(agentDir));
		const [row] = store.upsertAuthCredentialForProvider(provider, {
			type: "oauth", access, refresh: "claimed-refresh", expires: Date.now() + 86_400_000,
			...(accountId === undefined ? {} : { accountId }),
		});
		store.close();
		return { agentDir, credentialId: row!.id };
	}

	/** Every provider request with its headers; `respond` answers by URL. */
	function providerFetch(respond: (url: string) => Response) {
		const sent: string[] = [];
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			const headers = new Headers(input instanceof Request ? input.headers : undefined);
			for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
			sent.push(`${url} ${JSON.stringify([...headers])}`);
			return respond(url);
		}) as typeof fetch);
		cleanup.push(() => fetchSpy.mockRestore());
		return sent;
	}

	// Builtin readers never consult module bindings, so no Rocks owner is involved.
	const probe = (
		builtinId: string,
		account: Account,
		credential: { agentDir: string; credentialId: number; accountId: string },
	) =>
		runUsageProbe({} as RocksEngineMutations, "device", {
			principalId: "grimoire:user:owner", accountRef: "gctx:account", kind: "builtin", builtinId, builtinVersion: 1,
			account, credential: { method: "oauth", store: "local_omp", ...credential },
		});

	it.each([...readers])("$builtinId reads only the exact claimed credential row", async ({ builtinId, provider, env }) => {
		const access = provider === "cursor" ? cursorJwt("user_claimed") : `claimed-access-${provider}`;
		const claimed = provider === "cursor" ? "user_claimed" : "acct-claimed";
		const row = await storedRow(provider, access, claimed);
		const previous = process.env[env];
		process.env[env] = AMBIENT;
		cleanup.push(() => {
			if (previous === undefined) delete process.env[env];
			else process.env[env] = previous;
		});
		const sent = providerFetch(() => new Response("unavailable", { status: 503 }));
		const account = (providerId: string): Account => ({ provider_id: providerId, external_id: null, pools: [], quota_windows: [] });

		// Wrong claimed account or another provider's Account never opens a credential or reaches the network.
		expect(await probe(builtinId, account(provider), { ...row, accountId: "acct-other" }))
			.toEqual({ status: "credential_unavailable_on_device", observations: [] });
		expect(await probe(builtinId, account("other-provider"), { ...row, accountId: claimed }))
			.toEqual({ status: "builtin_unsupported", observations: [] });
		expect(sent).toEqual([]);

		// The exact claim egresses only with its own token, never an ambient environment key, and a
		// failed fresh read is unavailable rather than a replayed last-good report.
		expect(await probe(builtinId, account(provider), { ...row, accountId: claimed }))
			.toEqual({ status: "unavailable", observations: [] });
		expect(sent.join("\n")).not.toContain(AMBIENT);
		for (const request of sent) expect(request).toContain(access);
	});

	it("maps Claude windows by exact duration and its USD extra usage to the claimed pool", async () => {
		const row = await storedRow("anthropic", "claude-access", "acct-claimed");
		let reportedAccount = "acct-claimed";
		providerFetch(url => {
			expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
			return Response.json({
				account_id: reportedAccount,
				email: "owner@example.test",
				five_hour: { utilization: 40, resets_at: "2026-10-01T18:00:00Z" },
				seven_day: { utilization: 10, resets_at: "2026-10-05T00:00:00Z" },
				extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 5000, currency: "USD" },
			});
		});
		const account: Account = {
			provider_id: "anthropic",
			external_id: null,
			pools: [{ pool_id: "anthropic:extra" }],
			quota_windows: [
				{ window_id: "anthropic:5h", window_seconds: 5 * 3600 },
				// Same id, wrong duration: never matched by a guessed fraction.
				{ window_id: "anthropic:7d", window_seconds: 3600 },
			],
		};
		const result = await probe("anthropic_claude_usage", account, { ...row, accountId: "acct-claimed" });
		expect(result.status).toBe("ready");
		const byKey = Object.fromEntries(result.observations.map(item => [`${item.dimension_id}:${item.metric}`, item]));
		expect(Object.keys(byKey).sort()).toEqual([
			"anthropic:5h:quota_remaining",
			"anthropic:extra:aggregate_spend_usd",
			"anthropic:extra:exhausted",
		]);
		expect(byKey["anthropic:5h:quota_remaining"]).toMatchObject({ dimension: "quota_window", unit: "fraction" });
		expect(byKey["anthropic:5h:quota_remaining"]!.value as number).toBeCloseTo(0.6);
		expect(byKey["anthropic:extra:aggregate_spend_usd"])
			.toMatchObject({ dimension: "pool", value: 50, unit: "usd" });

		// The provider answering for another account is a mismatch, never a reading for the claim.
		reportedAccount = "acct-other";
		expect(await probe("anthropic_claude_usage", account, { ...row, accountId: "acct-claimed" }))
			.toEqual({ status: "account_identity_mismatch", observations: [] });
	});

	it("maps Cursor spend and request rails to exact pools and proves a legacy row by its token", async () => {
		// A row stored before Cursor logins recorded the account id is proven by its token's user id.
		const legacy = await storedRow("cursor", cursorJwt("user_claimed"), undefined);
		providerFetch(url => {
			if (url === "https://api2.cursor.sh/auth/usage") return Response.json({ "gpt-4": { numRequests: 120, maxRequestUsage: 500 } });
			if (url === "https://cursor.com/api/usage-summary") {
				return Response.json({
					billingCycleEnd: "2026-11-01T00:00:00Z",
					individualUsage: { overall: { enabled: true, used: 1234, limit: 5000, remaining: 3766 } },
				});
			}
			if (url === "https://cursor.com/api/auth/me") return Response.json({ sub: "user_claimed", email: "owner@example.test" });
			throw new Error(`unexpected Cursor request ${url}`);
		});
		const account: Account = {
			provider_id: "cursor",
			external_id: null,
			pools: [{ pool_id: "cursor:usd:individual-overall" }, { pool_id: "cursor:requests:gpt-4" }],
			// Cursor rails report no window duration, so no quota fraction is ever substituted.
			quota_windows: [{ window_id: "cursor:usd:individual-overall", window_seconds: 30 * 86_400 }],
		};
		const result = await probe("cursor_usage", account, { ...legacy, accountId: "user_claimed" });
		expect(result.status).toBe("ready");
		expect(result.observations).toEqual([
			expect.objectContaining({
				dimension: "pool", dimension_id: "cursor:usd:individual-overall", metric: "aggregate_spend_usd",
				value: 12.34, unit: "usd", resets_at: "2026-11-01T00:00:00.000Z",
			}),
			expect.objectContaining({
				dimension: "pool", dimension_id: "cursor:requests:gpt-4", metric: "request_count", value: 120, unit: "requests",
			}),
		]);

		// A recorded claim whose token belongs to another Cursor user is a mismatch.
		const foreign = await storedRow("cursor", cursorJwt("user_other"), "user_claimed");
		expect(await probe("cursor_usage", account, { ...foreign, accountId: "user_claimed" }))
			.toEqual({ status: "account_identity_mismatch", observations: [] });
	});
});
