import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeAuthGatewayAdminUrl } from "@oh-my-pi/pi-ai/auth-gateway";
import {
	AUTH_GATEWAY_CONNECTION_NAME_PATTERN,
	type AuthGatewayConnectionProfile,
	AuthGatewayProfileStore,
	normalizeAuthGatewayConnectionName,
} from "@oh-my-pi/pi-coding-agent/auth-gateway/profiles";
import * as configResolver from "@oh-my-pi/pi-coding-agent/config/resolve-config-value";
import {
	getAuthGatewayProfilesPath,
	getAuthGatewayTokensDir,
	getConfigRootDir,
	removeWithRetries,
	setAgentDir,
} from "@oh-my-pi/pi-utils";

const TRANSPORT_ERROR =
	"Remote auth-gateway connections must use https:// (plain http:// is allowed only for localhost)";
const SECRET = "pasted-managed-bearer-token";
const REPLACEMENT_SECRET = "replacement-managed-bearer-token";

let root = "";
let documentPath = "";
let tokenDir = "";
let originalAgentDir: string | undefined;
let fallbackAgentDir = "";
let originalSecretEnv: string | undefined;

function openStore(): AuthGatewayProfileStore {
	return AuthGatewayProfileStore.open({ documentPath, tokenDir });
}

async function readMetadata(): Promise<string> {
	return await fs.readFile(documentPath, "utf-8");
}

async function writeDocument(value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(documentPath), { recursive: true });
	await fs.writeFile(documentPath, `${JSON.stringify(value, null, 2)}\n`);
}

function failMetadataCommits(): void {
	const originalRename = fs.rename;
	spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
		if (newPath === documentPath) throw new Error("metadata commit failed");
		await originalRename(oldPath, newPath);
	});
}

async function expectSecretFreeRejection(
	promise: Promise<unknown>,
	message: string,
	forbiddenSecrets: readonly string[] = [SECRET],
): Promise<void> {
	try {
		await promise;
		throw new Error("expected rejection");
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		expect(text).toBe(message);
		for (const secret of forbiddenSecrets) expect(text).not.toContain(secret);
	}
}

function profile(name: string, url = "https://gateway.example.com/omp///"): AuthGatewayConnectionProfile {
	return { name, url, tokenSource: { type: "file" } };
}

beforeEach(async () => {
	originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	fallbackAgentDir = path.join(getConfigRootDir(), "agent");
	originalSecretEnv = process.env.OMP_GATEWAY_PROFILE_SECRET;
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-gateway-profiles-"));
	const agentDir = path.join(root, "profile-agent");
	setAgentDir(agentDir);
	documentPath = path.join(agentDir, "auth-gateways.json");
	tokenDir = path.join(agentDir, "auth-gateway-tokens");
});

afterEach(async () => {
	mock.restore();
	if (originalSecretEnv === undefined) {
		delete process.env.OMP_GATEWAY_PROFILE_SECRET;
	} else {
		process.env.OMP_GATEWAY_PROFILE_SECRET = originalSecretEnv;
	}
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	if (root) await removeWithRetries(root);
});

describe("auth-gateway profile paths", () => {
	test("profile metadata and managed tokens are rooted under the active agent dir", () => {
		const agentDir = path.join(root, "selected-profile", "agent");
		setAgentDir(agentDir);

		expect(getAuthGatewayProfilesPath()).toBe(path.join(agentDir, "auth-gateways.json"));
		expect(getAuthGatewayTokensDir()).toBe(path.join(agentDir, "auth-gateway-tokens"));
	});
});

describe("auth-gateway admin URL normalization", () => {
	test("accepts HTTPS and loopback HTTP while preserving path prefixes and stripping trailing slashes", () => {
		expect(normalizeAuthGatewayAdminUrl("https://gateway.example.com/omp///")).toBe(
			"https://gateway.example.com/omp",
		);
		expect(normalizeAuthGatewayAdminUrl("https://gateway.example.com///")).toBe("https://gateway.example.com");
		expect(normalizeAuthGatewayAdminUrl("http://localhost:4000/admin///")).toBe("http://localhost:4000/admin");
		expect(normalizeAuthGatewayAdminUrl("http://127.0.0.1:4000/")).toBe("http://127.0.0.1:4000");
		expect(normalizeAuthGatewayAdminUrl("http://[::1]:4000/base/")).toBe("http://[::1]:4000/base");
	});

	test("rejects unsafe transport and URL components that could leak credentials or alter requests", () => {
		expect(() => normalizeAuthGatewayAdminUrl("http://gateway.example.com")).toThrow(TRANSPORT_ERROR);
		expect(() => normalizeAuthGatewayAdminUrl("https://user:pass@gateway.example.com")).toThrow(
			"Auth-gateway admin URL must not include credentials",
		);
		expect(() => normalizeAuthGatewayAdminUrl("https://gateway.example.com?token=abc")).toThrow(
			"Auth-gateway admin URL must not include a query string",
		);
		expect(() => normalizeAuthGatewayAdminUrl("https://gateway.example.com#frag")).toThrow(
			"Auth-gateway admin URL must not include a fragment",
		);
	});
});

describe("auth-gateway connection name normalization", () => {
	test("normalizes valid names for map keys and token filenames", () => {
		expect(AUTH_GATEWAY_CONNECTION_NAME_PATTERN.test("prod_1.eu-west")).toBe(true);
		expect(normalizeAuthGatewayConnectionName("  Prod_1.EU-west  ")).toBe("prod_1.eu-west");
	});

	test("rejects malformed, trailing-dot, duplicate-prone, and Windows device names", () => {
		for (const input of ["", "1prod", "-prod", "prod/blue", "prod.", "CON", "con.prod", "com1", "LPT9"]) {
			expect(() => normalizeAuthGatewayConnectionName(input)).toThrow(
				`Invalid auth-gateway connection name: ${input}`,
			);
		}
	});
});

describe("AuthGatewayProfileStore document contract", () => {
	test("missing profile file returns an empty version-1 document", async () => {
		await expect(openStore().load()).resolves.toEqual({ version: 1, activeConnection: null, connections: [] });
		await expect(openStore().list()).resolves.toEqual([]);
		await expect(openStore().get()).resolves.toBeNull();
	});

	test("upsert, edit, set-active, rename, and delete round trip with sorted active selection", async () => {
		const store = openStore();

		await store.upsert(profile("Prod", "https://gateway.example.com/base///"), SECRET);
		await expect(store.load()).resolves.toEqual({
			version: 1,
			activeConnection: "prod",
			connections: [{ name: "prod", url: "https://gateway.example.com/base", tokenSource: { type: "file" } }],
		});
		expect(await fs.readFile(path.join(tokenDir, "prod.token"), "utf-8")).toBe(SECRET);

		await store.upsert({
			name: "alpha",
			url: "http://localhost:4000/",
			tokenSource: { type: "env", variable: "OMP_GATEWAY_PROFILE_SECRET" },
		});
		await expect(store.list()).resolves.toEqual([
			{
				name: "alpha",
				url: "http://localhost:4000",
				tokenSource: { type: "env", variable: "OMP_GATEWAY_PROFILE_SECRET" },
			},
			{ name: "prod", url: "https://gateway.example.com/base", tokenSource: { type: "file" } },
		]);
		await expect(store.get()).resolves.toEqual({
			name: "prod",
			url: "https://gateway.example.com/base",
			tokenSource: { type: "file" },
		});

		await store.setActive("alpha");
		await expect(store.get()).resolves.toEqual({
			name: "alpha",
			url: "http://localhost:4000",
			tokenSource: { type: "env", variable: "OMP_GATEWAY_PROFILE_SECRET" },
		});

		await store.rename("alpha", "Beta");
		await expect(store.load()).resolves.toEqual({
			version: 1,
			activeConnection: "beta",
			connections: [
				{
					name: "beta",
					url: "http://localhost:4000",
					tokenSource: { type: "env", variable: "OMP_GATEWAY_PROFILE_SECRET" },
				},
				{ name: "prod", url: "https://gateway.example.com/base", tokenSource: { type: "file" } },
			],
		});

		expect(await store.delete("beta")).toBe(true);
		await expect(store.load()).resolves.toEqual({
			version: 1,
			activeConnection: "prod",
			connections: [{ name: "prod", url: "https://gateway.example.com/base", tokenSource: { type: "file" } }],
		});
		expect(await store.delete("prod")).toBe(true);
		await expect(store.load()).resolves.toEqual({ version: 1, activeConnection: null, connections: [] });
		expect(await store.delete("missing")).toBe(false);
	});

	test("upsert preserves an explicitly cleared active connection across later edits and additions", async () => {
		const store = openStore();

		await store.upsert(profile("prod"), SECRET);
		await store.upsert({
			name: "alpha",
			url: "http://localhost:4000",
			tokenSource: { type: "env", variable: "OMP_GATEWAY_PROFILE_SECRET" },
		});
		await store.setActive(null);

		await store.upsert({ name: "prod", url: "https://gateway.example.com/edited", tokenSource: { type: "file" } });
		await expect(store.load()).resolves.toMatchObject({ activeConnection: null });

		await store.upsert({
			name: "gamma",
			url: "https://gamma.example.com",
			tokenSource: { type: "env", variable: "OMP_GATEWAY_PROFILE_SECRET" },
		});
		await expect(store.load()).resolves.toMatchObject({ activeConnection: null });
		await expect(store.resolve()).rejects.toThrow("No auth-gateway connection is configured");
	});

	test("rejects duplicate stored names after normalization", async () => {
		await writeDocument({
			version: 1,
			activeConnection: "prod",
			connections: [
				{ name: "prod", url: "https://gateway.example.com", tokenSource: { type: "file" } },
				{ name: "PROD", url: "https://gateway.example.com", tokenSource: { type: "file" } },
			],
		});

		await expect(openStore().load()).rejects.toThrow("Duplicate auth-gateway connection name: prod");
	});

	test("metadata never stores file token values and file token lifecycle follows profile mutations", async () => {
		const store = openStore();
		await store.upsert(profile("prod"), SECRET);
		expect(await readMetadata()).not.toContain(SECRET);

		await store.upsert({ name: "prod", url: "https://gateway.example.com/renamed", tokenSource: { type: "file" } });
		expect(await fs.readFile(path.join(tokenDir, "prod.token"), "utf-8")).toBe(SECRET);

		await store.rename("prod", "renamed");
		await expect(fs.stat(path.join(tokenDir, "prod.token"))).rejects.toThrow();
		expect(await fs.readFile(path.join(tokenDir, "renamed.token"), "utf-8")).toBe(SECRET);

		await store.upsert({
			name: "renamed",
			url: "https://gateway.example.com/renamed",
			tokenSource: { type: "env", variable: "OMP_GATEWAY_PROFILE_SECRET" },
		});
		await expect(fs.stat(path.join(tokenDir, "renamed.token"))).rejects.toThrow();

		await expect(
			store.upsert({ name: "renamed", url: "https://gateway.example.com/renamed", tokenSource: { type: "file" } }),
		).rejects.toThrow("A managed file token is required for auth-gateway connection renamed");
	});

	test("failed metadata commits preserve managed token files for destructive mutations", async () => {
		let store = openStore();
		await store.upsert(profile("prod"), SECRET);
		failMetadataCommits();
		await expect(
			store.upsert({
				name: "prod",
				url: "https://gateway.example.com/renamed",
				tokenSource: { type: "env", variable: "OMP_GATEWAY_PROFILE_SECRET" },
			}),
		).rejects.toThrow("metadata commit failed");
		expect(await readMetadata()).toContain('"name": "prod"');
		expect(await fs.readFile(path.join(tokenDir, "prod.token"), "utf-8")).toBe(SECRET);

		mock.restore();
		documentPath = path.join(root, "rename-agent", "auth-gateways.json");
		tokenDir = path.join(root, "rename-agent", "tokens");
		store = openStore();
		await store.upsert(profile("prod"), SECRET);
		failMetadataCommits();
		await expect(store.rename("prod", "renamed")).rejects.toThrow("metadata commit failed");
		expect(await readMetadata()).toContain('"name": "prod"');
		expect(await fs.readFile(path.join(tokenDir, "prod.token"), "utf-8")).toBe(SECRET);
		await expect(fs.stat(path.join(tokenDir, "renamed.token"))).rejects.toThrow();

		mock.restore();
		documentPath = path.join(root, "delete-agent", "auth-gateways.json");
		tokenDir = path.join(root, "delete-agent", "tokens");
		store = openStore();
		await store.upsert(profile("prod"), SECRET);
		failMetadataCommits();
		await expect(store.delete("prod")).rejects.toThrow("metadata commit failed");
		expect(await readMetadata()).toContain('"name": "prod"');
		expect(await fs.readFile(path.join(tokenDir, "prod.token"), "utf-8")).toBe(SECRET);
	});

	test("failed metadata commit during file-token replacement preserves the old managed token", async () => {
		const store = openStore();
		await store.upsert(profile("prod"), SECRET);
		failMetadataCommits();

		await expectSecretFreeRejection(
			store.upsert(profile("prod", "https://gateway.example.com/replacement"), REPLACEMENT_SECRET),
			"metadata commit failed",
			[SECRET, REPLACEMENT_SECRET],
		);

		expect(await readMetadata()).toContain('"url": "https://gateway.example.com/omp"');
		expect(await fs.readFile(path.join(tokenDir, "prod.token"), "utf-8")).toBe(SECRET);
	});

	test("malformed, unsupported-version, unknown-field, and dangling-active documents fail without overwrite", async () => {
		for (const value of [
			"not json",
			JSON.stringify({ version: 2, activeConnection: null, connections: [] }),
			JSON.stringify({ version: 1, activeConnection: null, connections: [], extra: true }),
			JSON.stringify({ version: 1, activeConnection: "missing", connections: [] }),
		]) {
			await fs.mkdir(path.dirname(documentPath), { recursive: true });
			await fs.writeFile(documentPath, value);
			await expect(openStore().load()).rejects.toThrow();
			await expect(openStore().upsert(profile("prod"), SECRET)).rejects.toThrow();
			expect(await fs.readFile(documentPath, "utf-8")).toBe(value);
		}
	});

	test("concurrent mutations serialize without lost connections", async () => {
		const store = openStore();
		await store.upsert({
			name: "conn-00",
			url: "https://gateway0.example.com",
			tokenSource: { type: "env", variable: "OMP_GATEWAY_PROFILE_SECRET" },
		});
		await Promise.all(
			Array.from({ length: 11 }, (_, index) => {
				const connectionIndex = index + 1;
				return store.upsert({
					name: `conn-${String(connectionIndex).padStart(2, "0")}`,
					url: `https://gateway${connectionIndex}.example.com`,
					tokenSource: { type: "env", variable: "OMP_GATEWAY_PROFILE_SECRET" },
				});
			}),
		);

		const loaded = await store.load();
		expect(loaded.connections.map(connection => connection.name)).toEqual(
			Array.from({ length: 12 }, (_, index) => `conn-${String(index).padStart(2, "0")}`),
		);
		expect(loaded.activeConnection).toBe("conn-00");
	});
});

describe("AuthGatewayProfileStore token resolution", () => {
	test("resolve selects active or requested connections and trims file/env/command tokens", async () => {
		const store = openStore();
		process.env.OMP_GATEWAY_PROFILE_SECRET = `  ${SECRET}  `;
		const commandSpy = spyOn(configResolver, "resolveConfigValue").mockResolvedValue(`\n${SECRET}-command\n`);

		await store.upsert(profile("file"), `  ${SECRET}-file  `);
		await store.upsert({
			name: "env",
			url: "http://127.0.0.1:4100",
			tokenSource: { type: "env", variable: "OMP_GATEWAY_PROFILE_SECRET" },
		});
		await store.upsert({
			name: "cmd",
			url: "http://[::1]:4100/base",
			tokenSource: { type: "command", command: "printf token" },
		});
		await store.setActive("env");

		await expect(store.resolve()).resolves.toEqual({
			profile: {
				name: "env",
				url: "http://127.0.0.1:4100",
				tokenSource: { type: "env", variable: "OMP_GATEWAY_PROFILE_SECRET" },
			},
			token: SECRET,
		});
		await expect(store.resolve("file")).resolves.toEqual({
			profile: { name: "file", url: "https://gateway.example.com/omp", tokenSource: { type: "file" } },
			token: `${SECRET}-file`,
		});
		await expect(store.resolve("cmd")).resolves.toEqual({
			profile: {
				name: "cmd",
				url: "http://[::1]:4100/base",
				tokenSource: { type: "command", command: "printf token" },
			},
			token: `${SECRET}-command`,
		});
		expect(commandSpy).toHaveBeenCalledWith("!printf token");
	});

	test("missing active, unknown names, and empty token sources fail with safe exact errors", async () => {
		const store = openStore();
		await expectSecretFreeRejection(store.resolve(), "No auth-gateway connection is configured");
		await expectSecretFreeRejection(store.resolve("missing"), "Unknown auth-gateway connection: missing");

		await store.upsert({
			name: "env",
			url: "https://gateway.example.com",
			tokenSource: { type: "env", variable: "OMP_GATEWAY_PROFILE_SECRET" },
		});
		delete process.env.OMP_GATEWAY_PROFILE_SECRET;
		await expectSecretFreeRejection(store.resolve("env"), "No token resolved for auth-gateway connection env");
		process.env.OMP_GATEWAY_PROFILE_SECRET = "   ";
		await expectSecretFreeRejection(store.resolve("env"), "No token resolved for auth-gateway connection env");

		await store.upsert({
			name: "cmd",
			url: "https://gateway.example.com",
			tokenSource: { type: "command", command: "empty" },
		});
		spyOn(configResolver, "resolveConfigValue").mockResolvedValue("   ");
		await expectSecretFreeRejection(store.resolve("cmd"), "No token resolved for auth-gateway connection cmd");
	});

	test("unsafe tampered HTTP profiles fail closed before touching token sources", async () => {
		for (const tokenSource of [
			{ type: "file" } as const,
			{ type: "env", variable: "OMP_GATEWAY_PROFILE_SECRET" } as const,
			{ type: "command", command: "printf should-not-run" } as const,
		]) {
			await removeWithRetries(root);
			root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-gateway-profiles-"));
			documentPath = path.join(root, "auth-gateways.json");
			tokenDir = path.join(root, "tokens");
			process.env.OMP_GATEWAY_PROFILE_SECRET = SECRET;
			await fs.mkdir(tokenDir, { recursive: true });
			await fs.writeFile(path.join(tokenDir, "prod.token"), SECRET);
			const commandSpy = spyOn(configResolver, "resolveConfigValue").mockResolvedValue(SECRET);
			await writeDocument({
				version: 1,
				activeConnection: "prod",
				connections: [{ name: "prod", url: "http://gateway.example.com", tokenSource }],
			});

			await expectSecretFreeRejection(openStore().load(), TRANSPORT_ERROR);
			await expectSecretFreeRejection(openStore().get(), TRANSPORT_ERROR);
			await expectSecretFreeRejection(openStore().resolve(), TRANSPORT_ERROR);
			expect(commandSpy).not.toHaveBeenCalled();
		}
	});
});
