import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBridgeConfig } from "../src/config";
import { type PrimeBridgeServer, startPrimeBridgeServer } from "../src/server";
import { ensureBridgeToken } from "../src/token";

const temporaryDirectories: string[] = [];
const runningServers: PrimeBridgeServer[] = [];

async function createServer(allowedOrigins: readonly string[] = []): Promise<PrimeBridgeServer> {
	const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-auth-"));
	temporaryDirectories.push(stateDir);
	const config = resolveBridgeConfig({
		stateDir,
		primeConfigFile: path.join(stateDir, "omp-bridge.json"),
		allowedOrigins,
		port: 0,
	});
	const running = await startPrimeBridgeServer({ config, peers: () => [] });
	runningServers.push(running);
	return running;
}

async function stopResources(): Promise<void> {
	await Promise.all(runningServers.splice(0).map(server => server.stop()));
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
}

afterEach(stopResources);

describe("authenticated bridge HTTP service", () => {
	it("serves health without authentication", async () => {
		const running = await createServer();

		const response = await fetch(`${running.url}/health`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});

	it("requires an exact bearer token for every v1 route", async () => {
		const running = await createServer();
		const route = `${running.url}/v1/peers`;

		expect((await fetch(route)).status).toBe(401);
		expect((await fetch(route, { headers: { Authorization: "Bearer wrong-token" } })).status).toBe(401);
		expect((await fetch(route, { headers: { Authorization: `Bearer ${running.token} extra` } })).status).toBe(401);
	});

	it("rejects non-empty origins that are not allowlisted", async () => {
		const running = await createServer();

		const response = await fetch(`${running.url}/v1/peers`, {
			headers: { Authorization: `Bearer ${running.token}`, Origin: "https://untrusted.example" },
		});

		expect(response.status).toBe(403);
	});

	it("accepts the token without an Origin header and allows configured origins", async () => {
		const running = await createServer(["https://trusted.example"]);

		expect(
			(await fetch(`${running.url}/v1/peers`, { headers: { Authorization: `Bearer ${running.token}` } })).status,
		).toBe(200);
		expect(
			(
				await fetch(`${running.url}/v1/peers`, {
					headers: { Authorization: `Bearer ${running.token}`, Origin: "https://trusted.example" },
				})
			).status,
		).toBe(200);
	});

	it("rejects requests with a Host header outside the configured loopback authority", async () => {
		const running = await createServer();

		const response = await fetch(`${running.url}/health`, {
			headers: { Host: "127.0.0.1:1" },
		});

		expect(response.status).toBe(400);
	});

	it("rejects an existing token symlink", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-token-link-"));
		temporaryDirectories.push(stateDir);
		const tokenFile = path.join(stateDir, "token");
		await fs.symlink("/tmp/prime-bridge-secret-target", tokenFile);

		await expect(ensureBridgeToken(tokenFile)).rejects.toThrow("symlink");
	});

	it("repairs existing token parent permissions", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-token-mode-"));
		temporaryDirectories.push(stateDir);
		await fs.chmod(stateDir, 0o755);

		await ensureBridgeToken(path.join(stateDir, "token"));

		expect((await fs.stat(stateDir)).mode & 0o777).toBe(0o700);
	});

	it("keeps the HTTP service bound to loopback", async () => {
		const running = await createServer();

		expect(new URL(running.url).hostname).toBe("127.0.0.1");
	});

	it("keeps token and Prime pointer stable across restart", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-restart-"));
		temporaryDirectories.push(stateDir);
		const config = resolveBridgeConfig({
			stateDir,
			primeConfigFile: path.join(stateDir, "omp-bridge.json"),
			port: 0,
		});
		const first = await startPrimeBridgeServer({ config, peers: () => [] });
		const firstToken = await fs.readFile(config.tokenFile, "utf8");
		const firstPointer = await fs.readFile(config.primeConfigFile, "utf8");
		await first.stop();

		const second = await startPrimeBridgeServer({ config, peers: () => [] });
		runningServers.push(second);
		const secondToken = await fs.readFile(config.tokenFile, "utf8");
		const secondPointer = JSON.parse(await fs.readFile(config.primeConfigFile, "utf8")) as {
			url: string;
			tokenFile: string;
		};

		expect(secondToken).toBe(firstToken);
		expect(secondPointer.tokenFile).toBe(config.tokenFile);
		expect(secondPointer.url).toBe(second.url);
		expect(firstPointer).not.toContain(firstToken.trim());
	});

	it("authorizes each request with the current token file value", async () => {
		const running = await createServer();
		const rotatedToken = "rotated-token";
		await fs.writeFile(running.config.tokenFile, rotatedToken, { encoding: "utf8", mode: 0o600 });

		expect(
			(await fetch(`${running.url}/v1/peers`, { headers: { Authorization: `Bearer ${running.token}` } })).status,
		).toBe(401);
		expect(
			(await fetch(`${running.url}/v1/peers`, { headers: { Authorization: `Bearer ${rotatedToken}` } })).status,
		).toBe(200);
	});

	it("provisions token and Prime pointer files with owner-only permissions", async () => {
		const running = await createServer();
		const tokenStat = await fs.stat(running.config.tokenFile);
		const primeConfigStat = await fs.stat(running.config.primeConfigFile);
		const pointer = JSON.parse(await fs.readFile(running.config.primeConfigFile, "utf8")) as Record<string, unknown>;

		expect(tokenStat.mode & 0o777).toBe(0o600);
		expect(primeConfigStat.mode & 0o777).toBe(0o600);
		expect(Object.keys(pointer).sort()).toEqual(["tokenFile", "url"]);
		expect(pointer.tokenFile).toBe(running.config.tokenFile);
		expect(pointer.url).toBe(running.url);
		expect(JSON.stringify(pointer)).not.toContain(running.token);
	});

	it("publishes one non-empty token under concurrent initialization", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-token-race-"));
		temporaryDirectories.push(stateDir);
		const tokenFile = path.join(stateDir, "token");
		const values = await Promise.all(Array.from({ length: 8 }, () => ensureBridgeToken(tokenFile)));
		expect(new Set(values).size).toBe(1);
		expect(await fs.readFile(tokenFile, "utf8")).toBe(values[0]);
	});
});
