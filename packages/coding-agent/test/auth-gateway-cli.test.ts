import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthGatewayAccessStore, type AuthGatewayAuditEvent } from "@oh-my-pi/pi-ai/auth-gateway";
import { runAuthGatewayCommand, type AuthGatewayCommandArgs, type AuthGatewayCommandDependencies } from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-cli";
import AuthGatewayCommand from "@oh-my-pi/pi-coding-agent/commands/auth-gateway";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);
const ORIGINAL_EXIT_CODE = process.exitCode;

function captureStdout(): () => string {
	let captured = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	return () => captured;
}

async function expectJsonCommand<T>(cmd: AuthGatewayCommandArgs, deps: AuthGatewayCommandDependencies): Promise<T> {
	const restore = captureStdout();
	try {
		await runAuthGatewayCommand(cmd, deps);
		const lines = restore().trim().split(/\n+/).filter(Boolean);
		expect(lines).toHaveLength(1);
		return JSON.parse(lines[0]!) as T;
	} finally {
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
	}
}

async function expectCommandError(cmd: AuthGatewayCommandArgs, deps: AuthGatewayCommandDependencies, message: string): Promise<void> {
	const restore = captureStdout();
	try {
		await expect(runAuthGatewayCommand(cmd, deps)).rejects.toThrow(message);
		expect(restore()).not.toContain("token_hash");
	} finally {
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
	}
}

function expectExactKeys(value: Record<string, unknown>, keys: string[]): void {
	expect(Object.keys(value).sort()).toEqual([...keys].sort());
}

async function withStore<T>(dbPath: string, fn: (store: SqliteAuthGatewayAccessStore) => T | Promise<T>): Promise<T> {
	const store = await SqliteAuthGatewayAccessStore.open(dbPath);
	try {
		return await fn(store);
	} finally {
		store.close();
	}
}

function userCommand(subaction: string, target?: string, value?: string, flags: AuthGatewayCommandArgs["flags"] = {}): AuthGatewayCommandArgs {
	return { action: "user", subaction, target, value, flags: { json: true, ...flags } };
}

function poolCommand(subaction: string, target?: string, value?: string, flags: AuthGatewayCommandArgs["flags"] = {}): AuthGatewayCommandArgs {
	return { action: "pool", subaction, target, value, flags: { json: true, ...flags } };
}

describe("auth-gateway CLI access management", () => {
	let agentDir = "";
	let dbPath = "";
	let originalAgentDir: string | undefined;
	let fallbackAgentDir = "";
	let deps: AuthGatewayCommandDependencies;
	let tokenFile = "";
	let originalTokenContent: string | null = null;

	beforeEach(async () => {
		process.exitCode = 0;
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		fallbackAgentDir = path.join(getConfigRootDir(), "agent");
		tokenFile = path.join(getConfigRootDir(), "auth-gateway.token");
		originalTokenContent = await Bun.file(tokenFile).text().catch(() => null);
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-gateway-cli-"));
		setAgentDir(agentDir);
		dbPath = path.join(agentDir, "auth-gateway.db");
		deps = {
			accessDbPath: dbPath,
			loadBrokerCredentials: async () => [
				{ id: 42, provider: "anthropic", type: "oauth" },
				{ id: 43, provider: "anthropic", type: "api_key" },
				{ id: 7, provider: "openai", type: "api_key" },
			],
		};
	});

	afterEach(async () => {
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
		process.exitCode = ORIGINAL_EXIT_CODE;
		if (originalTokenContent === null) {
			await fs.rm(tokenFile, { force: true }).catch(() => undefined);
		} else {
			await fs.mkdir(path.dirname(tokenFile), { recursive: true });
			await fs.writeFile(tokenFile, originalTokenContent);
		}

		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		Bun.gc(true);
		if (agentDir) await removeWithRetries(agentDir);
	});

	test("exposes management command examples", () => {
		expect(AuthGatewayCommand.examples.some(example => example.includes("auth-gateway user create"))).toBe(true);
		expect(AuthGatewayCommand.examples.some(example => example.includes("auth-gateway pool add-account"))).toBe(true);
		expect(AuthGatewayCommand.examples.some(example => example.includes("auth-gateway audit list"))).toBe(true);
	});

	test("manages users, tokens, ACLs, pools, usage, audit, and status without exposing secrets", async () => {
		const created = await expectJsonCommand<{
			user: Record<string, unknown>;
			token: Record<string, unknown>;
		}>(userCommand("create", "alice", undefined, { description: "team account", owner: "platform", role: "user", label: "initial" }), deps);
		expectExactKeys(created, ["user", "token"]);
		expectExactKeys(created.user, ["id", "name", "description", "owner", "role", "enabled", "createdAt", "updatedAt", "lastUsedAt"]);
		expectExactKeys(created.token, ["id", "userId", "publicId", "label", "createdAt", "lastUsedAt", "revokedAt", "value"]);
		expect(created.user).toMatchObject({ name: "alice", description: "team account", owner: "platform", role: "user", enabled: true });
		expect(created.token).toMatchObject({ userId: created.user.id, label: "initial", revokedAt: null });
		expect(String(created.token.value)).toStartWith("omp_gw_");
		expect(JSON.stringify(created)).not.toContain("token_hash");
		const aliceId = created.user.id as number;
		const initialTokenId = created.token.id as number;
		const initialTokenValue = created.token.value as string;

		const admin = await expectJsonCommand<{ user: Record<string, unknown>; token: Record<string, unknown> }>(
			userCommand("create", "admin1", undefined, { role: "admin" }),
			deps,
		);
		expect(admin.user).toMatchObject({ name: "admin1", role: "admin", enabled: true });
		expect(admin.token.value).not.toBe(initialTokenValue);

		const listed = await expectJsonCommand<{ users: Array<Record<string, unknown>> }>(userCommand("list"), deps);
		expectExactKeys(listed, ["users"]);
		expect(listed.users.map(user => user.name)).toEqual(["alice", "admin1"]);
		expect(JSON.stringify(listed)).not.toContain(initialTokenValue);

		const shown = await expectJsonCommand<{
			user: Record<string, unknown>;
			tokens: Array<Record<string, unknown>>;
			acl: unknown[];
			pools: unknown[];
		}>(userCommand("show", "alice"), deps);
		expectExactKeys(shown, ["user", "tokens", "acl", "pools"]);
		expectExactKeys(shown.tokens[0]!, ["id", "userId", "publicId", "label", "createdAt", "lastUsedAt", "revokedAt"]);
		expect(JSON.stringify(shown)).not.toContain(initialTokenValue);
		expect(JSON.stringify(shown)).not.toContain("token_hash");

		const updated = await expectJsonCommand<{ user: Record<string, unknown> }>(
			userCommand("update", String(aliceId), undefined, { description: "", owner: "", role: "admin" }),
			deps,
		);
		expect(updated.user).toMatchObject({ id: aliceId, description: null, owner: null, role: "admin" });

		const disabled = await expectJsonCommand<{ user: Record<string, unknown> }>(userCommand("disable", "alice"), deps);
		expect(disabled.user).toMatchObject({ id: aliceId, enabled: false });
		const enabled = await expectJsonCommand<{ user: Record<string, unknown> }>(userCommand("enable", "alice"), deps);
		expect(enabled.user).toMatchObject({ id: aliceId, enabled: true });
		await expectJsonCommand(userCommand("update", "alice", undefined, { role: "user" }), deps);

		const addedToken = await expectJsonCommand<{ token: Record<string, unknown> }>(userCommand("token", "alice", undefined, { label: "ci" }), deps);
		expectExactKeys(addedToken.token, ["id", "userId", "publicId", "label", "createdAt", "lastUsedAt", "revokedAt", "value"]);
		expect(addedToken.token).toMatchObject({ userId: aliceId, label: "ci", revokedAt: null });
		expect(addedToken.token.value).not.toBe(initialTokenValue);

		const rotated = await expectJsonCommand<{ token: Record<string, unknown> }>(userCommand("token", "alice", undefined, { regenerate: true, label: "rotated" }), deps);
		expect(rotated.token).toMatchObject({ userId: aliceId, label: "rotated", revokedAt: null });
		await withStore(dbPath, store => {
			const aliceTokens = store.listUserTokens(aliceId);
			expect(aliceTokens.filter(token => token.revokedAt === null).map(token => token.id)).toEqual([rotated.token.id]);
			const adminUser = store.getUser("admin1");
			expect(adminUser).toBeDefined();
			const adminTokens = store.listUserTokens(adminUser!.id);
			expect(adminTokens).toHaveLength(1);
			expect(adminTokens[0]!.revokedAt).toBeNull();
		});

		const revoked = await expectJsonCommand<{ revoked: true; tokenId: number }>(userCommand("token-revoke", "alice", String(rotated.token.id)), deps);
		expect(revoked).toEqual({ revoked: true, tokenId: rotated.token.id });
		await expectCommandError(userCommand("token-revoke", "alice", String(initialTokenId)), deps, "token not found");

		const allow = await expectJsonCommand<{ rule: Record<string, unknown>; created: boolean }>(userCommand("allow", "alice", undefined, { provider: "anthropic" }), deps);
		expectExactKeys(allow, ["rule", "created"]);
		expect(allow).toMatchObject({ created: true, rule: { userId: aliceId, effect: "allow", kind: "provider", pattern: "anthropic" } });
		const deny = await expectJsonCommand<{ rule: Record<string, unknown>; created: boolean }>(userCommand("deny", "alice", undefined, { model: "anthropic/claude-3-5-sonnet" }), deps);
		expect(deny).toMatchObject({ created: true, rule: { effect: "deny", kind: "model", pattern: "anthropic/claude-3-5-sonnet" } });
		const route = await expectJsonCommand<{ rule: Record<string, unknown>; created: boolean }>(userCommand("allow", "alice", undefined, { route: "chat" }), deps);
		expect(route).toMatchObject({ created: true, rule: { effect: "allow", kind: "route", pattern: "chat" } });
		await expectCommandError(userCommand("allow", "alice", undefined, { provider: "anthropic", route: "chat" }), deps, "Exactly one of --provider, --model, or --route is required");
		await expectCommandError(userCommand("deny", "alice"), deps, "Exactly one of --provider, --model, or --route is required");

		const acl = await expectJsonCommand<{ acl: Array<Record<string, unknown>> }>(userCommand("acl", "alice"), deps);
		expect(acl.acl.map(rule => `${rule.effect}:${rule.kind}:${rule.pattern}`)).toEqual([
			"allow:provider:anthropic",
			"deny:model:anthropic/claude-3-5-sonnet",
			"allow:route:chat",
		]);
		const deletedAcl = await expectJsonCommand<{ deleted: true; ruleId: number }>(userCommand("acl-delete", "alice", String(deny.rule.id)), deps);
		expect(deletedAcl).toEqual({ deleted: true, ruleId: deny.rule.id });

		await expectCommandError(poolCommand("create", "missingprovider"), deps, "--provider is required");
		await expectCommandError(poolCommand("create", "blankprovider", undefined, { provider: "   " }), deps, "--provider is required");
		const pool = await expectJsonCommand<{ pool: Record<string, unknown> }>(
			poolCommand("create", "primary", undefined, { provider: "anthropic", model: "claude-3-5-sonnet", strategy: "round-robin" }),
			deps,
		);
		expectExactKeys(pool.pool, ["id", "name", "provider", "model", "strategy", "createdAt", "updatedAt", "members"]);
		expect(pool.pool).toMatchObject({ name: "primary", provider: "anthropic", model: "anthropic/claude-3-5-sonnet", strategy: "round-robin", members: [] });
		const poolId = pool.pool.id as number;

		await expectCommandError(poolCommand("add-account", "primary", "99"), deps, "credential id 99 was not found in broker snapshot");
		await expectCommandError(poolCommand("add-account", "primary", "7"), deps, "credential id 7 belongs to provider openai, not anthropic");
		const member = await expectJsonCommand<{ pool: Record<string, unknown>; created: boolean }>(poolCommand("add-account", "primary", "42"), deps);
		expect(member).toMatchObject({ created: true, pool: { id: poolId, members: [{ credentialId: 42, position: 0 }] } });
		expect(JSON.stringify(member)).not.toContain("api_key");
		expect(JSON.stringify(member)).not.toContain("oauth");

		const secondMember = await expectJsonCommand<{ pool: Record<string, unknown>; created: boolean }>(poolCommand("add-account", "primary", "43"), deps);
		expect(secondMember).toMatchObject({ created: true, pool: { id: poolId, members: [{ credentialId: 42, position: 0 }, { credentialId: 43, position: 1 }] } });
		const strategy = await expectJsonCommand<{ pool: Record<string, unknown> }>(poolCommand("set-strategy", "primary", "failover"), deps);
		expect(strategy.pool).toMatchObject({ id: poolId, strategy: "failover" });
		const poolList = await expectJsonCommand<{ pools: Array<Record<string, unknown>> }>(poolCommand("list"), deps);
		expect(poolList.pools).toHaveLength(1);
		expect(poolList.pools[0]).toMatchObject({ id: poolId, name: "primary" });
		const poolShow = await expectJsonCommand<{ pool: Record<string, unknown> }>(poolCommand("show", "primary"), deps);
		expect(poolShow.pool).toMatchObject({ id: poolId, members: [{ credentialId: 42, position: 0 }, { credentialId: 43, position: 1 }] });

		const setPool = await expectJsonCommand<{ created: boolean; user: Record<string, unknown>; pool: Record<string, unknown> }>(userCommand("set-pool", "alice", "primary"), deps);
		expect(setPool).toMatchObject({ created: true, user: { id: aliceId, name: "alice" }, pool: { id: poolId, name: "primary" } });
		const shownWithPool = await expectJsonCommand<{ pools: Array<Record<string, unknown>> }>(userCommand("show", "alice"), deps);
		expect(shownWithPool.pools).toHaveLength(1);
		expect(shownWithPool.pools[0]).toMatchObject({ id: poolId, name: "primary" });
		const unsetPool = await expectJsonCommand<{ removed: true; user: Record<string, unknown>; pool: Record<string, unknown> }>(userCommand("unset-pool", "alice", "primary"), deps);
		expect(unsetPool).toMatchObject({ removed: true, user: { id: aliceId }, pool: { id: poolId } });

		const removedMember = await expectJsonCommand<{ removed: true; credentialId: number; pool: Record<string, unknown> }>(poolCommand("remove-account", "primary", "42"), deps);
		expect(removedMember).toMatchObject({ removed: true, credentialId: 42, pool: { id: poolId, members: [{ credentialId: 43, position: 0 }] } });

		const auditEvent = await withStore(dbPath, store => store.recordAudit({
			requestId: "req-1",
			startedAt: 1234,
			completedAt: 1244,
			userId: aliceId,
			userName: "alice",
			tokenId: null,
			method: "POST",
			path: "/v1/chat/completions",
			routeFamily: "chat",
			requestedModel: "claude-3-5-sonnet",
			resolvedProvider: "anthropic",
			resolvedModel: "anthropic/claude-3-5-sonnet",
			credentialId: 43,
			outcome: "success",
			statusCode: 200,
			inputTokens: 11,
			outputTokens: 13,
			cacheReadTokens: 2,
			cacheWriteTokens: 3,
			totalTokens: 29,
			costUsd: 0.25,
			errorCode: null,
		} satisfies Omit<AuthGatewayAuditEvent, "id">));

		const usage = await expectJsonCommand<{ usage: Record<string, unknown> }>(userCommand("usage", "alice", undefined, { since: "1000" }), deps);
		expect(usage.usage).toMatchObject({
			userId: aliceId,
			since: 1000,
			totals: { requests: 1, inputTokens: 11, outputTokens: 13, cacheReadTokens: 2, cacheWriteTokens: 3, totalTokens: 29, costUsd: 0.25 },
			byProviderModel: [{ provider: "anthropic", model: "anthropic/claude-3-5-sonnet", requests: 1, totalTokens: 29, costUsd: 0.25 }],
		});
		expect(usage.usage).toHaveProperty("generatedAt");

		const audit = await expectJsonCommand<{ events: Array<Record<string, unknown>>; nextBefore: number | null }>({ action: "audit", subaction: "list", flags: { json: true, user: "alice", limit: "1" } }, deps);
		expectExactKeys(audit, ["events", "nextBefore"]);
		expect(audit.events).toHaveLength(1);
		expect(audit.events[0]).toMatchObject({ id: auditEvent.id, userId: aliceId, userName: "alice", resolvedProvider: "anthropic", credentialId: 43, totalTokens: 29 });
		expect(audit.nextBefore).toBe(auditEvent.id);
		await expectCommandError({ action: "audit", subaction: "list", flags: { json: true, limit: "0" } }, deps, "--limit must be between 1 and 1000");

		const status = await expectJsonCommand<Record<string, unknown>>({ action: "status", flags: { json: true } }, deps);
		expect(status).toMatchObject({
			accessDb: dbPath,
			managedUserCount: 2,
			activeManagedTokenCount: 1,
			poolCount: 1,
			credentialCount: 3,
		});
		expect(status).toHaveProperty("ready");
		expect(status).toHaveProperty("tokenFile");

		const deletedPool = await expectJsonCommand<{ deleted: true; pool: Record<string, unknown> }>(poolCommand("delete", "primary"), deps);
		expect(deletedPool).toMatchObject({ deleted: true, pool: { id: poolId, name: "primary" } });
		const deletedUser = await expectJsonCommand<{ deleted: true; user: Record<string, unknown> }>(userCommand("delete", "alice"), deps);
		expect(deletedUser).toMatchObject({ deleted: true, user: { id: aliceId, name: "alice" } });
	});

	test("preserves legacy gateway token JSON contract and reports zero managed counts before creating a database", async () => {
		const absentDb = path.join(agentDir, "missing-auth-gateway.db");
		const status = await expectJsonCommand<Record<string, unknown>>({ action: "status", flags: { json: true } }, { ...deps, accessDbPath: absentDb });
		expect(status).toMatchObject({ accessDb: absentDb, managedUserCount: 0, activeManagedTokenCount: 0, poolCount: 0 });
		expect(await fs.stat(absentDb).then(() => true).catch(() => false)).toBe(false);

		const token = await expectJsonCommand<Record<string, unknown>>({ action: "token", flags: { json: true } }, deps);
		expectExactKeys(token, ["token", "path"]);
		expect(typeof token.token).toBe("string");
		expect(token.path).toBe(path.join(getConfigRootDir(), "auth-gateway.token"));

		const rotated = await expectJsonCommand<Record<string, unknown>>({ action: "token", flags: { json: true, regenerate: true } }, deps);
		expectExactKeys(rotated, ["token", "path"]);
		expect(rotated.token).not.toBe(token.token);
		expect(rotated.path).toBe(token.path);
	});
});
