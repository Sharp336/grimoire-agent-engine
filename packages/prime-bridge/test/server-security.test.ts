import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveBridgeConfig } from "../src/config";
import { type PrimeBridgeServer, startPrimeBridgeServer } from "../src/server";

const temporaryDirectories: string[] = [];
const runningServers: PrimeBridgeServer[] = [];

function payload(): Record<string, string> {
	return {
		meshMessageId: "mesh-log",
		idempotencyKey: "idem-log",
		originHarness: "omp",
		originSessionId: "omp-session",
		targetHarness: "prime",
		targetId: "prime-session",
		body: "hello",
		projectRoot: "/project",
		createdAt: "2026-08-11T00:00:00.000Z",
	};
}

afterEach(async () => {
	await Promise.all(runningServers.splice(0).map(server => server.stop()));
	await Promise.all(
		temporaryDirectories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
	);
});

describe("Prime bridge server logging", () => {
	it("sanitizes bearer and key material in logged errors", async () => {
		const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "prime-bridge-log-"));
		temporaryDirectories.push(stateDir);
		const logs: Array<Record<string, unknown> | undefined> = [];
		const config = resolveBridgeConfig({
			stateDir,
			primeConfigFile: path.join(stateDir, "omp-bridge.json"),
			port: 0,
		});
		const server = await startPrimeBridgeServer({
			config,
			primeClient: {
				sendMessage: async () => {
					throw new Error("Bearer secret-token api_key=private-key");
				},
			} as never,
			peers: () => [],
			logger: { error: (_message, context) => logs.push(context) },
		});
		runningServers.push(server);

		const response = await fetch(`${server.url}/v1/messages`, {
			method: "POST",
			headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
			body: JSON.stringify(payload()),
		});

		expect(response.status).toBe(500);
		const logged = JSON.stringify(logs);
		expect(logged).not.toContain("secret-token");
		expect(logged).not.toContain("private-key");
		expect(logged).toContain("[REDACTED]");
	});
});
