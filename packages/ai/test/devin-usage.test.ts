import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { streamDevin } from "@oh-my-pi/pi-ai/providers/devin";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { type UsageFetchParams, usageReportSchema } from "@oh-my-pi/pi-ai/usage";
import { devinUsageProvider, fetchDevinConsumption } from "@oh-my-pi/pi-ai/usage/devin";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { GetChatMessageResponseSchema } from "@oh-my-pi/pi-catalog/discovery/devin-gen/exa/api_server_pb/api_server_pb";
import { GetUserJwtResponseSchema } from "@oh-my-pi/pi-catalog/discovery/devin-gen/exa/auth_pb/auth_pb";
import {
	ModelUsageStatsSchema,
	StopReason,
} from "@oh-my-pi/pi-catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb";
import { type } from "arktype";

function frameConnectMessage(payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(5 + payload.length);
	const view = new DataView(out.buffer);
	view.setUint8(0, 0);
	view.setUint32(1, payload.length, false);
	out.set(payload, 5);
	return out;
}

const devinModel: Model<"devin-agent"> = buildModel({
	id: "devin-test",
	name: "Devin Test",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "https://server.codeium.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
});

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
const ORIGINAL_DEVIN_ORG_ID = Bun.env.DEVIN_ORG_ID;
const ORIGINAL_DEVIN_USAGE_ORG_ID = Bun.env.DEVIN_USAGE_ORG_ID;
const ORIGINAL_DEVIN_API_KEY = Bun.env.DEVIN_API_KEY;

afterEach(() => {
	if (ORIGINAL_DEVIN_ORG_ID === undefined) delete Bun.env.DEVIN_ORG_ID;
	else Bun.env.DEVIN_ORG_ID = ORIGINAL_DEVIN_ORG_ID;
	if (ORIGINAL_DEVIN_USAGE_ORG_ID === undefined) delete Bun.env.DEVIN_USAGE_ORG_ID;
	else Bun.env.DEVIN_USAGE_ORG_ID = ORIGINAL_DEVIN_USAGE_ORG_ID;
	if (ORIGINAL_DEVIN_API_KEY === undefined) delete Bun.env.DEVIN_API_KEY;
	else Bun.env.DEVIN_API_KEY = ORIGINAL_DEVIN_API_KEY;
});

describe("streamDevin usage", () => {
	it("includes cached tokens in totalTokens", async () => {
		const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));
		const response = create(GetChatMessageResponseSchema, {
			messageId: "msg-1",
			stopReason: StopReason.STOP_PATTERN,
			usage: create(ModelUsageStatsSchema, {
				inputTokens: 11n,
				outputTokens: 7n,
				cacheReadTokens: 100n,
				cacheWriteTokens: 13n,
			}),
		});
		const responseFrame = frameConnectMessage(toBinary(GetChatMessageResponseSchema, response));
		const fetchImpl = (async (input: string | URL | Request) => {
			if (String(input).includes("GetUserJwt")) return new Response(authPayload);
			return new Response(responseFrame);
		}) as typeof fetch;

		const result = await streamDevin(devinModel, context, { apiKey: "token", fetch: fetchImpl }).result();

		expect(result.usage).toMatchObject({
			input: 11,
			output: 7,
			cacheRead: 100,
			cacheWrite: 13,
			totalTokens: 131,
		});
	});
});

describe("devinUsageProvider", () => {
	it("fetches enterprise ACU consumption and usage metrics with bearer auth", async () => {
		delete Bun.env.DEVIN_ORG_ID;
		delete Bun.env.DEVIN_USAGE_ORG_ID;
		const calls: Array<{ path: string; authorization: string | null }> = [];
		const fetchImpl: FetchImpl = async (input, init) => {
			const url = String(input instanceof Request ? input.url : input);
			const parsed = new URL(url);
			calls.push({ path: parsed.pathname, authorization: new Headers(init?.headers).get("authorization") });
			if (parsed.pathname === "/v3/self") {
				return new Response(JSON.stringify({}), { status: 404 });
			}
			if (parsed.pathname === "/v3/enterprise/consumption/daily") {
				return new Response(
					JSON.stringify({
						total_acus: 12.5,
						consumption_by_date: [
							{ date: 1733385600, acus: 7.5, acus_by_product: { devin: 5, cascade: 2.5, terminal: 0 } },
							{ date: 1733472000, acus: 5, acus_by_product: { devin: 3, terminal: 2 } },
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (parsed.pathname === "/v3/enterprise/metrics/usage") {
				return new Response(
					JSON.stringify({ sessions_count: 4, searches_count: 3, prs_created_count: 2, prs_merged_count: 1 }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("unexpected Devin URL", { status: 404 });
		};

		const report = await devinUsageProvider.fetchUsage(
			{ provider: "devin", credential: { type: "api_key", apiKey: "cog_test-token" } },
			{ fetch: fetchImpl },
		);

		if (!report) throw new Error("expected Devin usage report");
		expect(calls).toEqual([
			{ path: "/v3/self", authorization: "Bearer cog_test-token" },
			{ path: "/v3/enterprise/consumption/daily", authorization: "Bearer cog_test-token" },
			{ path: "/v3/enterprise/metrics/usage", authorization: "Bearer cog_test-token" },
		]);
		expect(report.provider).toBe("devin");
		expect(report.limits.map(limit => [limit.id, limit.label, limit.amount.used, limit.amount.unit])).toEqual([
			["devin:acus:total", "Devin ACU consumption", 12.5, "acus"],
			["devin:acus:product:cascade", "Cascade product ACU consumption", 2.5, "acus"],
			["devin:acus:product:devin", "Devin product ACU consumption", 8, "acus"],
			["devin:acus:product:terminal", "Terminal product ACU consumption", 2, "acus"],
		]);
		expect(report.metadata).toMatchObject({
			totalAcus: 12.5,
			acusByProduct: { cascade: 2.5, devin: 8, terminal: 2 },
			metrics: { sessionsCount: 4, searchesCount: 3, prsCreatedCount: 2, prsMergedCount: 1 },
		});
		const validatedReport = usageReportSchema(report);
		expect(validatedReport).not.toBeInstanceOf(type.errors);
	});

	it("supports Devin API-key credentials before resolving their values", () => {
		const referencedApiKey: UsageFetchParams = {
			provider: "devin",
			credential: { type: "api_key", apiKey: "DEVIN_API_KEY" },
		};
		const unsupportedOauth: UsageFetchParams = {
			provider: "devin",
			credential: { type: "oauth", accessToken: "devin-oauth-token" },
		};
		const wrongProvider: UsageFetchParams = {
			provider: "anthropic",
			credential: { type: "api_key", apiKey: "cog_valid-token" },
		};

		expect(devinUsageProvider.supports?.(referencedApiKey)).toBe(true);
		expect(devinUsageProvider.supports?.(unsupportedOauth)).toBe(false);
		expect(devinUsageProvider.supports?.(wrongProvider)).toBe(false);
	});

	it("uses DEVIN_API_KEY when a stored Devin OAuth row cannot fetch usage", async () => {
		delete Bun.env.DEVIN_ORG_ID;
		delete Bun.env.DEVIN_USAGE_ORG_ID;
		Bun.env.DEVIN_API_KEY = "cog_env-usage";
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const authorization: Array<string | null> = [];
		const storage = new AuthStorage(store, {
			usageFetch: (async (input, init) => {
				authorization.push(new Headers(init?.headers).get("authorization"));
				const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
				const payload = path.endsWith("/v3/self")
					? { principal_type: "service_user", service_user_id: "service-env", org_id: null }
					: path.includes("consumption")
						? { total_acus: 4, consumption_by_date: [] }
						: { sessions_count: 1 };
				return new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}) as typeof fetch,
		});

		try {
			await storage.set("devin", [
				{
					type: "oauth",
					access: "devin-oauth-access",
					refresh: "devin-oauth-refresh",
					expires: Date.now() + 3_600_000,
				},
			]);

			const reports = await storage.fetchUsageReports();

			expect(authorization).toEqual(["Bearer cog_env-usage", "Bearer cog_env-usage", "Bearer cog_env-usage"]);
			expect(reports?.map(report => report.provider)).toEqual(["devin"]);
			expect(reports?.[0]?.limits[0]?.amount).toEqual({ used: 4, unit: "acus" });
		} finally {
			storage.close();
		}
	});

	it("resolves stored API-key config references before fetching usage", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const authorization: Array<string | null> = [];
		const storage = new AuthStorage(store, {
			configValueResolver: async value => (value === "DEVIN_API_KEY" ? "cog_resolved-token" : value),
			usageFetch: (async (input, init) => {
				authorization.push(new Headers(init?.headers).get("authorization"));
				const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
				if (path.endsWith("/v3/self")) {
					return new Response(JSON.stringify({}), { status: 404 });
				}
				const payload = path.includes("consumption")
					? { total_acus: 2, consumption_by_date: [] }
					: { sessions_count: 1 };
				return new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}) as typeof fetch,
		});

		try {
			await storage.set("devin", [{ type: "api_key", key: "DEVIN_API_KEY" }]);

			const reports = await storage.fetchUsageReports();

			expect(authorization).toEqual([
				"Bearer cog_resolved-token",
				"Bearer cog_resolved-token",
				"Bearer cog_resolved-token",
			]);
			expect(reports?.map(report => report.provider)).toEqual(["devin"]);
			expect(reports?.[0]?.limits[0]?.amount).toEqual({ used: 2, unit: "acus" });
		} finally {
			storage.close();
		}
	});

	it("deduplicates org-wide usage reported by multiple service-user keys", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store, {
			usageFetch: (async input => {
				const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
				const payload = path.endsWith("/v3/self")
					? { org_id: "org-shared" }
					: path.includes("consumption")
						? { total_acus: 12.5, consumption_by_date: [] }
						: { sessions_count: 2 };
				return new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}) as typeof fetch,
		});

		try {
			await storage.set("devin", [
				{ type: "api_key", key: "cog_service-user-one" },
				{ type: "api_key", key: "cog_service-user-two" },
			]);

			const reports = (await storage.fetchUsageReports())?.filter(report => report.provider === "devin");

			expect(reports).toHaveLength(1);
			expect(reports?.[0]?.metadata?.orgId).toBe("org-shared");
			expect(reports?.[0]?.limits).toHaveLength(1);
			expect(reports?.[0]?.limits[0]?.amount).toEqual({ used: 12.5, unit: "acus" });
		} finally {
			storage.close();
		}
	});

	it("deduplicates enterprise-wide usage only when /v3/self identifies the same principal", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store, {
			usageFetch: (async input => {
				const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
				const payload = path.endsWith("/v3/self")
					? { org_id: null, principal_type: "service_user", service_user_id: "service-shared" }
					: path.includes("consumption")
						? { total_acus: 12.5, consumption_by_date: [] }
						: { sessions_count: 2 };
				return new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}) as typeof fetch,
		});

		try {
			await storage.set("devin", [
				{ type: "api_key", key: "cog_enterprise-user-one" },
				{ type: "api_key", key: "cog_enterprise-user-two" },
			]);

			const reports = (await storage.fetchUsageReports())?.filter(report => report.provider === "devin");

			expect(reports).toHaveLength(1);
			expect(reports?.[0]?.metadata?.orgId).toBeUndefined();
			expect(reports?.[0]?.metadata?.principalId).toBe("service_user:service-shared");
			expect(reports?.[0]?.limits).toHaveLength(1);
			expect(reports?.[0]?.limits[0]?.amount).toEqual({ used: 12.5, unit: "acus" });
		} finally {
			storage.close();
		}
	});

	it("keeps org-less enterprise reports from distinct principals separate", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store, {
			usageFetch: (async (input, init) => {
				const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
				const authorization = new Headers(init?.headers).get("authorization");
				const firstPrincipal = authorization === "Bearer cog_enterprise-user-one";
				const payload = path.endsWith("/v3/self")
					? {
							org_id: null,
							principal_type: "service_user",
							service_user_id: firstPrincipal ? "service-one" : "service-two",
						}
					: path.includes("consumption")
						? { total_acus: firstPrincipal ? 7 : 9, consumption_by_date: [] }
						: { sessions_count: 2 };
				return new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}) as typeof fetch,
		});

		try {
			await storage.set("devin", [
				{ type: "api_key", key: "cog_enterprise-user-one" },
				{ type: "api_key", key: "cog_enterprise-user-two" },
			]);

			const reports = (await storage.fetchUsageReports())?.filter(report => report.provider === "devin");

			expect(reports).toHaveLength(2);
			expect(reports?.map(report => report.metadata?.principalId).sort()).toEqual([
				"service_user:service-one",
				"service_user:service-two",
			]);
			expect(
				reports?.map(report => report.limits[0]?.amount.used).sort((left, right) => (left ?? 0) - (right ?? 0)),
			).toEqual([7, 9]);
		} finally {
			storage.close();
		}
	});

	it("resolves stored API-key config references before checking credentials", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const authorization: Array<string | null> = [];
		const storage = new AuthStorage(store, {
			configValueResolver: async value => (value === "DEVIN_API_KEY" ? "cog_resolved-token" : value),
			usageFetch: (async (input, init) => {
				authorization.push(new Headers(init?.headers).get("authorization"));
				const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
				if (path.endsWith("/v3/self")) {
					return new Response(JSON.stringify({}), { status: 404 });
				}
				const payload = path.includes("consumption")
					? { total_acus: 2, consumption_by_date: [] }
					: { sessions_count: 1 };
				return new Response(JSON.stringify(payload), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}) as typeof fetch,
		});

		try {
			await storage.set("devin", [{ type: "api_key", key: "DEVIN_API_KEY" }]);

			const [result] = await storage.checkCredentials();

			expect(authorization).toEqual([
				"Bearer cog_resolved-token",
				"Bearer cog_resolved-token",
				"Bearer cog_resolved-token",
			]);
			expect(result).toMatchObject({
				provider: "devin",
				type: "api_key",
				ok: true,
			});
		} finally {
			storage.close();
		}
	});

	it("rejects non-cog Devin API-key credentials during credential check", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store, {
			configValueResolver: async value => value,
		});

		try {
			await storage.set("devin", [{ type: "api_key", key: "invalid-key-no-cog" }]);

			const [result] = await storage.checkCredentials();

			expect(result).toMatchObject({
				provider: "devin",
				type: "api_key",
				ok: null,
			});
			expect(result.reason).toMatch(/does not support api_key credentials/);
		} finally {
			storage.close();
		}
	});

	it("throws definitive auth failures so credential checks fail", async () => {
		const fetchImpl: FetchImpl = async () => new Response("unauthorized", { status: 401 });

		await expect(
			devinUsageProvider.fetchUsage(
				{ provider: "devin", credential: { type: "api_key", apiKey: "cog_bad-token" } },
				{ fetch: fetchImpl },
			),
		).rejects.toThrow("Devin consumption request failed: 401 unauthorized");
	});

	it("uses org-scoped endpoints and falls back to enterprise org endpoints", async () => {
		Bun.env.DEVIN_ORG_ID = "org-abc123";
		delete Bun.env.DEVIN_USAGE_ORG_ID;
		const paths: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			const parsed = new URL(String(input instanceof Request ? input.url : input));
			paths.push(parsed.pathname);
			if (parsed.pathname === "/v3/organizations/org-abc123/consumption/daily") {
				return new Response("org-scope denied", { status: 403 });
			}
			if (parsed.pathname === "/v3/enterprise/consumption/daily/organizations/org-abc123") {
				return new Response(JSON.stringify({ total_acus: 3, consumption_by_date: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (parsed.pathname === "/v3/organizations/org-abc123/metrics/usage") {
				return new Response("org-scope denied", { status: 403 });
			}
			if (parsed.pathname === "/v3/enterprise/organizations/org-abc123/metrics/usage") {
				return new Response(JSON.stringify({ sessions_count: 1 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("unexpected Devin URL", { status: 404 });
		};

		const report = await devinUsageProvider.fetchUsage(
			{ provider: "devin", credential: { type: "api_key", apiKey: "cog_token" } },
			{ fetch: fetchImpl },
		);

		if (!report) throw new Error("expected Devin usage report");
		expect(paths).toEqual([
			"/v3/organizations/org-abc123/consumption/daily",
			"/v3/enterprise/consumption/daily/organizations/org-abc123",
			"/v3/organizations/org-abc123/metrics/usage",
			"/v3/enterprise/organizations/org-abc123/metrics/usage",
		]);
		expect(report.metadata).toMatchObject({
			orgId: "org-abc123",
			totalAcus: 3,
			metrics: { sessionsCount: 1 },
		});
		expect(report.metadata?.endpoint).toBeUndefined();
		expect(report.metadata?.metricsEndpoint).toBeUndefined();
	});

	it("keeps ACU consumption when metrics permission is forbidden", async () => {
		delete Bun.env.DEVIN_ORG_ID;
		delete Bun.env.DEVIN_USAGE_ORG_ID;
		const paths: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			const parsed = new URL(String(input instanceof Request ? input.url : input));
			paths.push(parsed.pathname);
			if (parsed.pathname === "/v3/self") {
				return new Response(JSON.stringify({}), { status: 404 });
			}
			if (parsed.pathname === "/v3/enterprise/consumption/daily") {
				return new Response(JSON.stringify({ total_acus: 4.5, consumption_by_date: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (parsed.pathname === "/v3/enterprise/metrics/usage") {
				return new Response("forbidden", { status: 403 });
			}
			return new Response("unexpected Devin URL", { status: 404 });
		};

		const report = await devinUsageProvider.fetchUsage(
			{ provider: "devin", credential: { type: "api_key", apiKey: "cog_consumption-only" } },
			{ fetch: fetchImpl },
		);

		if (!report) throw new Error("expected Devin usage report");
		expect(paths).toEqual(["/v3/self", "/v3/enterprise/consumption/daily", "/v3/enterprise/metrics/usage"]);
		expect(report.limits.map(limit => [limit.id, limit.amount.used, limit.amount.unit])).toEqual([
			["devin:acus:total", 4.5, "acus"],
		]);
		expect(report.metadata).toMatchObject({ totalAcus: 4.5 });
		expect(report.metadata?.metrics).toBeUndefined();
	});

	it("keeps metrics when consumption permission is forbidden (metrics-only)", async () => {
		delete Bun.env.DEVIN_ORG_ID;
		delete Bun.env.DEVIN_USAGE_ORG_ID;
		const paths: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			const parsed = new URL(String(input instanceof Request ? input.url : input));
			paths.push(parsed.pathname);
			if (parsed.pathname === "/v3/self") {
				return new Response(JSON.stringify({}), { status: 404 });
			}
			if (parsed.pathname === "/v3/enterprise/consumption/daily") {
				return new Response("forbidden", { status: 403 });
			}
			if (parsed.pathname === "/v3/enterprise/metrics/usage") {
				return new Response(JSON.stringify({ sessions_count: 10, searches_count: 5 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response("unexpected Devin URL", { status: 404 });
		};

		const report = await devinUsageProvider.fetchUsage(
			{ provider: "devin", credential: { type: "api_key", apiKey: "cog_metrics-only" } },
			{ fetch: fetchImpl },
		);

		if (!report) throw new Error("expected Devin usage report");
		expect(paths).toEqual(["/v3/self", "/v3/enterprise/consumption/daily", "/v3/enterprise/metrics/usage"]);
		expect(report.limits).toEqual([]);
		expect(report.notes).toEqual(["Devin usage metrics were available, but ACU consumption was unavailable."]);
		expect(report.metadata).toMatchObject({
			metrics: { sessionsCount: 10, searchesCount: 5 },
		});
	});

	it("throws auth failure if both consumption and metrics fail with auth errors", async () => {
		delete Bun.env.DEVIN_ORG_ID;
		delete Bun.env.DEVIN_USAGE_ORG_ID;
		const paths: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			const parsed = new URL(String(input instanceof Request ? input.url : input));
			paths.push(parsed.pathname);
			if (parsed.pathname === "/v3/self") {
				return new Response(JSON.stringify({}), { status: 404 });
			}
			if (parsed.pathname === "/v3/enterprise/consumption/daily") {
				return new Response("unauthorized", { status: 401 });
			}
			if (parsed.pathname === "/v3/enterprise/metrics/usage") {
				return new Response("forbidden", { status: 403 });
			}
			return new Response("unexpected Devin URL", { status: 404 });
		};

		await expect(
			devinUsageProvider.fetchUsage(
				{ provider: "devin", credential: { type: "api_key", apiKey: "cog_bad-token" } },
				{ fetch: fetchImpl },
			),
		).rejects.toThrow("Devin consumption request failed: 401 unauthorized");

		expect(paths).toEqual(["/v3/self", "/v3/enterprise/consumption/daily", "/v3/enterprise/metrics/usage"]);
	});

	it("does not throw auth failure if both fail with non-auth errors", async () => {
		delete Bun.env.DEVIN_ORG_ID;
		delete Bun.env.DEVIN_USAGE_ORG_ID;
		const paths: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			const parsed = new URL(String(input instanceof Request ? input.url : input));
			paths.push(parsed.pathname);
			if (parsed.pathname === "/v3/self") {
				return new Response(JSON.stringify({}), { status: 404 });
			}
			return new Response("internal error", { status: 500 });
		};

		const report = await devinUsageProvider.fetchUsage(
			{ provider: "devin", credential: { type: "api_key", apiKey: "cog_server-error" } },
			{ fetch: fetchImpl },
		);

		expect(report).toBeNull();
		expect(paths).toEqual(["/v3/self", "/v3/enterprise/consumption/daily", "/v3/enterprise/metrics/usage"]);
	});

	it("determines credential support correctly (OAuth omission, API key inclusion)", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store, {
			configValueResolver: async value => (value === "DEVIN_API_KEY" ? "cog_resolved-token" : value),
		});

		try {
			// Direct cog_ API key
			const directSupported = await storage.isCredentialSupported("devin", {
				type: "api_key",
				key: "cog_direct-token",
			});
			expect(directSupported).toBe(true);

			// Resolved cog_ API key reference
			const resolvedSupported = await storage.isCredentialSupported("devin", {
				type: "api_key",
				key: "DEVIN_API_KEY",
			});
			expect(resolvedSupported).toBe(true);

			// Unresolved non-cog API key reference
			const unresolvedNonCogSupported = await storage.isCredentialSupported("devin", {
				type: "api_key",
				key: "invalid-key-no-cog",
			});
			expect(unresolvedNonCogSupported).toBe(false);

			// OAuth credential
			const oauthSupported = await storage.isCredentialSupported("devin", {
				type: "oauth",
				access: "some-access-token",
				refresh: "some-refresh-token",
				expires: 0,
			});
			expect(oauthSupported).toBe(false);
		} finally {
			storage.close();
		}
	});

	it("discovers org_id from /v3/self and queries organization endpoints", async () => {
		delete Bun.env.DEVIN_ORG_ID;
		delete Bun.env.DEVIN_USAGE_ORG_ID;
		const paths: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			const parsed = new URL(String(input instanceof Request ? input.url : input));
			paths.push(parsed.pathname);
			if (parsed.pathname === "/v3/self") {
				return new Response(JSON.stringify({ org_id: "org-discovered123" }), { status: 200 });
			}
			if (parsed.pathname === "/v3/organizations/org-discovered123/consumption/daily") {
				return new Response(JSON.stringify({ total_acus: 15.0, consumption_by_date: [] }), { status: 200 });
			}
			if (parsed.pathname === "/v3/organizations/org-discovered123/metrics/usage") {
				return new Response(JSON.stringify({ sessions_count: 5 }), { status: 200 });
			}
			return new Response("unexpected", { status: 404 });
		};

		const report = await devinUsageProvider.fetchUsage(
			{ provider: "devin", credential: { type: "api_key", apiKey: "cog_token" } },
			{ fetch: fetchImpl },
		);

		expect(report).not.toBeNull();
		expect(paths).toEqual([
			"/v3/self",
			"/v3/organizations/org-discovered123/consumption/daily",
			"/v3/organizations/org-discovered123/metrics/usage",
		]);
		expect(report?.metadata).toMatchObject({
			orgId: "org-discovered123",
			totalAcus: 15.0,
			metrics: { sessionsCount: 5 },
		});
	});

	it("prioritizes explicit env/config org ID over /v3/self discovery", async () => {
		Bun.env.DEVIN_ORG_ID = "org-env-priority";
		delete Bun.env.DEVIN_USAGE_ORG_ID;
		const paths: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			const parsed = new URL(String(input instanceof Request ? input.url : input));
			paths.push(parsed.pathname);
			if (parsed.pathname === "/v3/organizations/org-env-priority/consumption/daily") {
				return new Response(JSON.stringify({ total_acus: 5.0, consumption_by_date: [] }), { status: 200 });
			}
			if (parsed.pathname === "/v3/organizations/org-env-priority/metrics/usage") {
				return new Response(JSON.stringify({ sessions_count: 2 }), { status: 200 });
			}
			return new Response("unexpected", { status: 404 });
		};

		const report = await devinUsageProvider.fetchUsage(
			{ provider: "devin", credential: { type: "api_key", apiKey: "cog_token" } },
			{ fetch: fetchImpl },
		);

		expect(report).not.toBeNull();
		expect(paths).toEqual([
			"/v3/organizations/org-env-priority/consumption/daily",
			"/v3/organizations/org-env-priority/metrics/usage",
		]);
	});

	it("continues to enterprise usage when /v3/self permission is forbidden", async () => {
		delete Bun.env.DEVIN_ORG_ID;
		delete Bun.env.DEVIN_USAGE_ORG_ID;
		const paths: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
			paths.push(path);
			if (path === "/v3/self") {
				return new Response("forbidden", { status: 403 });
			}
			if (path === "/v3/enterprise/consumption/daily") {
				return new Response(JSON.stringify({ total_acus: 6, consumption_by_date: [] }), { status: 200 });
			}
			return new Response("forbidden", { status: 403 });
		};

		const report = await devinUsageProvider.fetchUsage(
			{ provider: "devin", credential: { type: "api_key", apiKey: "cog_usage-only" } },
			{ fetch: fetchImpl },
		);

		expect(report?.limits[0]?.amount).toEqual({ used: 6, unit: "acus" });
		expect(paths).toEqual(["/v3/self", "/v3/enterprise/consumption/daily", "/v3/enterprise/metrics/usage"]);
	});

	it("surfaces /v3/self auth failure when enterprise usage is unavailable", async () => {
		delete Bun.env.DEVIN_ORG_ID;
		delete Bun.env.DEVIN_USAGE_ORG_ID;
		const fetchImpl: FetchImpl = async input => {
			const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
			return path === "/v3/self"
				? new Response("forbidden", { status: 403 })
				: new Response("not found", { status: 404 });
		};

		await expect(
			devinUsageProvider.fetchUsage(
				{ provider: "devin", credential: { type: "api_key", apiKey: "cog_unavailable" } },
				{ fetch: fetchImpl },
			),
		).rejects.toThrow("Devin profile request failed: 403 forbidden");
	});
});

describe("fetchDevinConsumption", () => {
	it("passes date query parameters to the selected org endpoint", async () => {
		const urls: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			const url = String(input instanceof Request ? input.url : input);
			urls.push(url);
			return new Response(JSON.stringify({ total_acus: 2, consumption_by_date: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const summary = await fetchDevinConsumption({
			apiKey: "cog_token",
			baseUrl: "https://api.example.test/",
			orgId: "org-xyz",
			timeAfter: new Date("2026-01-01T00:00:00.000Z"),
			timeBefore: 1767312000,
			fetch: fetchImpl,
		});

		if (!summary) throw new Error("expected Devin consumption summary");
		expect(summary.totalAcus).toBe(2);
		expect(urls).toEqual([
			"https://api.example.test/v3/organizations/org-xyz/consumption/daily?time_after=1767225600&time_before=1767312000",
		]);
	});

	it("preserves an org endpoint auth failure when the fallback is missing", async () => {
		const paths: string[] = [];
		const fetchImpl: FetchImpl = async input => {
			const path = new URL(String(input instanceof Request ? input.url : input)).pathname;
			paths.push(path);
			if (path === "/v3/organizations/org-xyz/consumption/daily") {
				return new Response("forbidden", { status: 403 });
			}
			return new Response("not found", { status: 404 });
		};

		await expect(
			fetchDevinConsumption({
				apiKey: "cog_token",
				baseUrl: "https://api.example.test",
				orgId: "org-xyz",
				fetch: fetchImpl,
			}),
		).rejects.toThrow("Devin consumption request failed: 403 forbidden");
		expect(paths).toEqual([
			"/v3/organizations/org-xyz/consumption/daily",
			"/v3/enterprise/consumption/daily/organizations/org-xyz",
		]);
	});
});
