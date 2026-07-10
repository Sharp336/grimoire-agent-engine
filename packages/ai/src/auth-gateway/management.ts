import type { AuthStorage } from "../auth-storage";
import type { AuthGatewayAccessStore } from "./access-store";
import {
	AUTH_GATEWAY_POOL_STRATEGIES,
	AuthGatewayAccessError,
	type AuthGatewayAclEffect,
	type AuthGatewayAclKind,
	type AuthGatewayPrincipal,
	type AuthGatewayRole,
	type AuthGatewayPoolStrategy,
} from "./access-control";
import { json } from "./http";

const USER_CREATE_FIELDS: Record<string, true> = { name: true, description: true, owner: true, role: true };
const USER_PATCH_FIELDS: Record<string, true> = { description: true, owner: true, role: true, enabled: true };
const TOKEN_CREATE_FIELDS: Record<string, true> = { label: true };
const ACL_CREATE_FIELDS: Record<string, true> = { effect: true, kind: true, pattern: true };
const POOL_BIND_FIELDS: Record<string, true> = { poolId: true };
const POOL_CREATE_FIELDS: Record<string, true> = { name: true, provider: true, model: true, strategy: true };
const POOL_PATCH_FIELDS: Record<string, true> = { name: true, strategy: true };
const POOL_MEMBER_FIELDS: Record<string, true> = { credentialId: true };
const STRATEGIES: Record<AuthGatewayPoolStrategy, true> = Object.fromEntries(AUTH_GATEWAY_POOL_STRATEGIES.map(strategy => [strategy, true])) as Record<AuthGatewayPoolStrategy, true>;

export async function handleAuthGatewayManagementRequest(
	req: Request,
	pathname: string,
	principal: AuthGatewayPrincipal,
	accessStore: AuthGatewayAccessStore,
	storage: AuthStorage,
): Promise<Response | null> {
	const parts = pathname.split("/").filter(Boolean);
	if (parts[0] !== "v1" || (parts[1] !== "users" && parts[1] !== "pools" && parts[1] !== "audit")) return null;
	if (principal.kind === "no-auth") return managementError(403, "management_auth_required", "Management routes require an authenticated admin token");
	if (principal.role !== "admin") return managementError(403, "forbidden", "Management routes require an admin token");

	try {
		if (parts[1] === "users") return await handleUsers(req, parts.slice(2), accessStore);
		if (parts[1] === "pools") return await handlePools(req, parts.slice(2), accessStore, storage);
		return handleAudit(req, accessStore);
	} catch (error) {
		if (error instanceof ManagementHttpError) return managementError(error.status, error.code, error.message);
		if (error instanceof AuthGatewayAccessError) return managementError(errorStatus(error.code), error.code, error.message);
		return managementError(500, "internal_error", "internal error");
	}
}

async function handleUsers(req: Request, parts: string[], store: AuthGatewayAccessStore): Promise<Response> {
	if (parts.length === 0) {
		if (req.method === "GET") return json(200, { users: store.listUsers() });
		if (req.method === "POST") {
			const body = await readObjectBody(req, USER_CREATE_FIELDS);
			const name = requiredString(body, "name");
			const description = optionalString(body, "description");
			const owner = optionalString(body, "owner");
			const role = optionalRole(body.role);
			const created = store.createUser({ name, description, owner, role });
			return json(201, { user: created.user, token: tokenResponse(created.token) });
		}
		throw new ManagementHttpError(404, "not_found", "management route not found");
	}
	const userId = positiveId(parts[0] ?? "", "user id");
	if (parts.length === 1) {
		if (req.method === "GET") {
			const user = store.getUser(userId);
			if (!user) throw new ManagementHttpError(404, "not_found", "user not found");
			return json(200, { user, tokens: store.listUserTokens(userId), acl: store.listAclRules(userId), pools: store.listUserPools(userId) });
		}
		if (req.method === "PATCH") {
			const body = await readObjectBody(req, USER_PATCH_FIELDS);
			return json(200, { user: store.updateUser(userId, {
				description: optionalNullableString(body, "description"),
				owner: optionalNullableString(body, "owner"),
				role: optionalRole(body.role),
				enabled: optionalBoolean(body, "enabled"),
			}) });
		}
		if (req.method === "DELETE") {
			if (!store.deleteUser(userId)) throw new ManagementHttpError(404, "not_found", "user not found");
			return new Response(null, { status: 204 });
		}
	}
	if (parts[1] === "tokens") return handleUserTokens(req, parts.slice(2), store, userId);
	if (parts[1] === "acl") return await handleUserAcl(req, parts.slice(2), store, userId);
	if (parts[1] === "pools") return await handleUserPools(req, parts.slice(2), store, userId);
	if (parts[1] === "usage" && parts.length === 2 && req.method === "GET") {
		const since = readSince(req);
		return json(200, { usage: store.getUserUsage(userId, since) });
	}
	throw new ManagementHttpError(404, "not_found", "management route not found");
}

function handleUserTokens(req: Request, parts: string[], store: AuthGatewayAccessStore, userId: number): Response | Promise<Response> {
	if (parts.length === 0 && req.method === "POST") {
		return readObjectBody(req, TOKEN_CREATE_FIELDS).then(body => json(201, { token: tokenResponse(store.addUserToken(userId, optionalString(body, "label"))) }));
	}
	if (parts.length === 1 && parts[0] === "rotate" && req.method === "POST") {
		return json(200, { token: tokenResponse(store.rotateUserTokens(userId)) });
	}
	if (parts.length === 1 && req.method === "DELETE") {
		const tokenId = positiveId(parts[0] ?? "", "token id");
		if (!store.revokeUserToken(userId, tokenId)) throw new ManagementHttpError(404, "not_found", "token not found");
		return new Response(null, { status: 204 });
	}
	throw new ManagementHttpError(404, "not_found", "management route not found");
}

async function handleUserAcl(req: Request, parts: string[], store: AuthGatewayAccessStore, userId: number): Promise<Response> {
	if (parts.length === 0 && req.method === "GET") return json(200, { acl: store.listAclRules(userId) });
	if (parts.length === 0 && req.method === "POST") {
		const body = await readObjectBody(req, ACL_CREATE_FIELDS);
		const effect = body.effect;
		const kind = body.kind;
		const pattern = requiredString(body, "pattern");
		if (effect !== "allow" && effect !== "deny") throw new ManagementHttpError(400, "invalid_request", "ACL effect must be allow or deny");
		if (kind !== "provider" && kind !== "model" && kind !== "route") throw new ManagementHttpError(400, "invalid_request", "ACL kind must be provider, model, or route");
		const result = store.addAclRule(userId, { effect: effect as AuthGatewayAclEffect, kind: kind as AuthGatewayAclKind, pattern });
		return json(result.created ? 201 : 200, { rule: result.rule });
	}
	if (parts.length === 1 && req.method === "DELETE") {
		const ruleId = positiveId(parts[0] ?? "", "rule id");
		if (!store.deleteAclRule(userId, ruleId)) throw new ManagementHttpError(404, "not_found", "ACL rule not found");
		return new Response(null, { status: 204 });
	}
	throw new ManagementHttpError(404, "not_found", "management route not found");
}

async function handleUserPools(req: Request, parts: string[], store: AuthGatewayAccessStore, userId: number): Promise<Response> {
	if (parts.length === 0 && req.method === "GET") return json(200, { pools: store.listUserPools(userId) });
	if (parts.length === 0 && req.method === "POST") {
		const body = await readObjectBody(req, POOL_BIND_FIELDS);
		const result = store.bindUserPool(userId, numericField(body, "poolId"));
		return json(result.created ? 201 : 200, result);
	}
	if (parts.length === 1 && req.method === "DELETE") {
		const poolId = positiveId(parts[0] ?? "", "pool id");
		if (!store.unbindUserPool(userId, poolId)) throw new ManagementHttpError(404, "not_found", "pool binding not found");
		return new Response(null, { status: 204 });
	}
	throw new ManagementHttpError(404, "not_found", "management route not found");
}

async function handlePools(req: Request, parts: string[], store: AuthGatewayAccessStore, storage: AuthStorage): Promise<Response> {
	if (parts.length === 0) {
		if (req.method === "GET") return json(200, { pools: store.listPools() });
		if (req.method === "POST") {
			const body = await readObjectBody(req, POOL_CREATE_FIELDS);
			return json(201, { pool: store.createPool({
				name: requiredString(body, "name"),
				provider: requiredString(body, "provider"),
				model: optionalString(body, "model"),
				strategy: optionalStrategy(body.strategy),
			}) });
		}
	}
	const poolId = positiveId(parts[0] ?? "", "pool id");
	if (parts.length === 1) {
		if (req.method === "GET") {
			const pool = store.getPool(poolId);
			if (!pool) throw new ManagementHttpError(404, "not_found", "pool not found");
			return json(200, { pool });
		}
		if (req.method === "PATCH") {
			const body = await readObjectBody(req, POOL_PATCH_FIELDS);
			return json(200, { pool: store.updatePool(poolId, { name: optionalString(body, "name"), strategy: optionalStrategy(body.strategy) }) });
		}
		if (req.method === "DELETE") {
			if (!store.deletePool(poolId)) throw new ManagementHttpError(404, "not_found", "pool not found");
			return new Response(null, { status: 204 });
		}
	}
	if (parts[1] === "members") return await handlePoolMembers(req, parts.slice(2), store, storage, poolId);
	throw new ManagementHttpError(404, "not_found", "management route not found");
}

async function handlePoolMembers(req: Request, parts: string[], store: AuthGatewayAccessStore, storage: AuthStorage, poolId: number): Promise<Response> {
	if (parts.length === 0 && req.method === "POST") {
		const body = await readObjectBody(req, POOL_MEMBER_FIELDS);
		const credentialId = numericField(body, "credentialId");
		const pool = store.getPool(poolId);
		if (!pool) throw new ManagementHttpError(404, "not_found", "pool not found");
		const live = storage.listStoredCredentials(pool.provider).some(row => row.id === credentialId);
		if (!live) throw new ManagementHttpError(400, "invalid_request", "credential must be an active credential for the pool provider");
		const result = store.addPoolCredential(poolId, credentialId);
		return json(result.created ? 201 : 200, { pool: result.pool });
	}
	if (parts.length === 1 && req.method === "DELETE") {
		const credentialId = positiveId(parts[0] ?? "", "credential id");
		if (!store.removePoolCredential(poolId, credentialId)) throw new ManagementHttpError(404, "not_found", "pool member not found");
		return new Response(null, { status: 204 });
	}
	throw new ManagementHttpError(404, "not_found", "management route not found");
}

function handleAudit(req: Request, store: AuthGatewayAccessStore): Response {
	if (req.method !== "GET") throw new ManagementHttpError(404, "not_found", "management route not found");
	const url = new URL(req.url);
	const userIdParam = url.searchParams.get("userId");
	const limitParam = url.searchParams.get("limit");
	const beforeParam = url.searchParams.get("before");
	const userId = userIdParam ? positiveId(userIdParam, "userId") : undefined;
	const limit = limitParam ? boundedLimit(limitParam) : undefined;
	const before = beforeParam ? positiveId(beforeParam, "before") : undefined;
	return json(200, store.listAudit({ userId, limit, before }));
}

async function readObjectBody(req: Request, allowedFields: Record<string, true>): Promise<Record<string, unknown>> {
	let parsed: unknown;
	try {
		parsed = await req.json();
	} catch {
		throw new ManagementHttpError(400, "invalid_request", "Malformed JSON body");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ManagementHttpError(400, "invalid_request", "JSON body must be an object");
	const body = parsed as Record<string, unknown>;
	for (const key of Object.keys(body)) {
		if (!allowedFields[key]) throw new ManagementHttpError(400, "invalid_request", `Unknown field: ${key}`);
	}
	return body;
}

function requiredString(body: Record<string, unknown>, field: string): string {
	const value = body[field];
	if (typeof value !== "string" || value.trim().length === 0) throw new ManagementHttpError(400, "invalid_request", `${field} is required`);
	return value;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
	const value = body[field];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new ManagementHttpError(400, "invalid_request", `${field} must be a string`);
	return value;
}

function optionalNullableString(body: Record<string, unknown>, field: string): string | null | undefined {
	const value = body[field];
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== "string") throw new ManagementHttpError(400, "invalid_request", `${field} must be a string or null`);
	return value;
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
	const value = body[field];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new ManagementHttpError(400, "invalid_request", `${field} must be boolean`);
	return value;
}

function optionalRole(value: unknown): AuthGatewayRole | undefined {
	if (value === undefined) return undefined;
	if (value === "user" || value === "admin") return value;
	throw new ManagementHttpError(400, "invalid_request", "role must be user or admin");
}

function optionalStrategy(value: unknown): AuthGatewayPoolStrategy | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" && STRATEGIES[value as AuthGatewayPoolStrategy]) return value as AuthGatewayPoolStrategy;
	throw new ManagementHttpError(400, "invalid_request", "invalid pool strategy");
}

function numericField(body: Record<string, unknown>, field: string): number {
	const value = body[field];
	if (!Number.isInteger(value) || typeof value !== "number" || value <= 0) throw new ManagementHttpError(400, "invalid_request", `${field} must be a positive integer`);
	return value;
}

function positiveId(raw: string, label: string): number {
	if (!/^\d+$/.test(raw)) throw new ManagementHttpError(400, "invalid_request", `${label} must be a positive integer`);
	const id = Number(raw);
	if (!Number.isSafeInteger(id) || id <= 0) throw new ManagementHttpError(400, "invalid_request", `${label} must be a positive integer`);
	return id;
}

function boundedLimit(raw: string): number {
	const limit = positiveId(raw, "limit");
	if (limit > 1000) throw new ManagementHttpError(400, "invalid_request", "limit must be at most 1000");
	return limit;
}

function readSince(req: Request): number {
	const raw = new URL(req.url).searchParams.get("since");
	if (raw === null) return 0;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) throw new ManagementHttpError(400, "invalid_request", "since must be a non-negative millisecond timestamp");
	return value;
}

function tokenResponse(token: { id: number; value: string; label: string | null }): Record<string, unknown> {
	return token.label === null ? { id: token.id, value: token.value } : { id: token.id, value: token.value, label: token.label };
}

function errorStatus(code: "invalid_request" | "not_found" | "conflict"): number {
	if (code === "invalid_request") return 400;
	if (code === "not_found") return 404;
	return 409;
}

function managementError(status: number, code: string, message: string): Response {
	return json(status, { error: { code, message } });
}

class ManagementHttpError extends Error {
	constructor(readonly status: number, readonly code: string, message: string) {
		super(message);
	}
}
