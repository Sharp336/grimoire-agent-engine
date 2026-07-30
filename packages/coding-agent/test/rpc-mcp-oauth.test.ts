import { afterEach, describe, expect, test, vi } from "bun:test";
import * as mcpCommands from "../src/modes/controllers/mcp-command-controller";
import {
	beginRpcMCPReauth,
	completeRpcMCPReauth,
	invalidateRpcMCPAuthorizations,
} from "../src/modes/rpc/rpc-mcp";
import type { AgentSession } from "../src/session/agent-session";
import type { SessionTransitionRunner } from "../src/session/agent-session-types";

const session = {} as AgentSession;
const manager = {} as never;

afterEach(() => {
	vi.restoreAllMocks();
});

describe("RPC MCP OAuth lifecycle", () => {
	test("removal and session transitions cancel stale OAuth flows before they can complete", async () => {
		for (const invalidation of ["remove", "session transition"] as const) {
			const authorization = Promise.withResolvers<never>();
			let signal: AbortSignal | undefined;
			vi.spyOn(mcpCommands, "prepareMCPReauth").mockResolvedValue({
				name: "demo",
				found: { filePath: "mcp.json", scope: "project", config: { type: "http", url: "https://demo.test" }, discovered: false },
				baseConfig: { type: "http", url: "https://demo.test" },
				oauth: { authorizationUrl: "https://auth.demo.test", tokenUrl: "https://auth.demo.test/token" },
				flowClientId: "",
				flowClientSecret: "",
				oauthResourceIsFallback: false,
			} as never);
			vi.spyOn(mcpCommands, "authorizeMCP").mockImplementation(async (_session, _request, callbacks) => {
				signal = callbacks.signal;
				callbacks.onAuth({ url: "https://auth.demo.test/authorize" });
				return await authorization.promise;
			});

			const begun = await beginRpcMCPReauth(session, manager, "demo");
			const cancelled = invalidateRpcMCPAuthorizations(session, invalidation === "remove" ? "demo" : undefined);

			expect(signal?.aborted).toBe(true);
			await expect(completeRpcMCPReauth(session, manager, begun.flowId)).rejects.toThrow("Unknown or expired MCP OAuth flow");
			authorization.reject(new Error("cancelled"));
			await cancelled;
			vi.restoreAllMocks();
		}
	});

	test("waits for an occupied session transition before persisting completed OAuth", async () => {
		const authorization = Promise.withResolvers<unknown>();
		const transitionEntered = Promise.withResolvers<void>();
		const releaseTransition = Promise.withResolvers<void>();
		const transitionRejected = Promise.withResolvers<void>();
		const acquireSessionTransition = vi.fn(() => {
			transitionRejected.resolve();
			throw new Error("Another RPC session transition is already in progress.");
		});
		let runSessionTransitionCalls = 0;
		const runSessionTransition: SessionTransitionRunner = async transition => {
			runSessionTransitionCalls++;
			transitionEntered.resolve();
			await releaseTransition.promise;
			return (await transition({})).result;
		};
		const concurrentSession = {
			acquireSessionTransition,
			runSessionTransition,
		} as unknown as AgentSession;
		const concurrentManager = {
			getConnectionStatus: () => "disconnected",
			getTools: () => [],
		} as never;
		const persistAndReload = vi.spyOn(mcpCommands, "completeMCPReauth").mockResolvedValue({
			type: "http",
			url: "https://demo.test",
		} as never);
		vi.spyOn(mcpCommands, "prepareMCPReauth").mockResolvedValue({
			name: "demo",
			found: { filePath: "mcp.json", scope: "project", config: { type: "http", url: "https://demo.test" }, discovered: false },
			baseConfig: { type: "http", url: "https://demo.test" },
			oauth: { authorizationUrl: "https://auth.demo.test", tokenUrl: "https://auth.demo.test/token" },
			flowClientId: "",
			flowClientSecret: "",
			oauthResourceIsFallback: false,
		} as never);
		vi.spyOn(mcpCommands, "authorizeMCP").mockImplementation(async (_session, _request, callbacks) => {
			callbacks.onAuth({ url: "https://auth.demo.test/authorize" });
			return (await authorization.promise) as never;
		});

		const begun = await beginRpcMCPReauth(concurrentSession, concurrentManager, "demo");
		const completion = completeRpcMCPReauth(concurrentSession, concurrentManager, begun.flowId);
		authorization.resolve({ credentialId: "fresh-credential" });
		void completion.catch(() => {});
		await expect(
			Promise.race([
				transitionEntered.promise.then(() => "queued"),
				transitionRejected.promise.then(() => "rejected"),
			]),
		).resolves.toBe("queued");
		let completed = false;
		void completion.then(() => {
			completed = true;
		});
		await Promise.resolve();
		expect(completed).toBe(false);
		expect(persistAndReload).not.toHaveBeenCalled();
		expect(acquireSessionTransition).not.toHaveBeenCalled();

		releaseTransition.resolve();
		await expect(completion).resolves.toMatchObject({ credentialStored: true, name: "demo" });
		expect(persistAndReload).toHaveBeenCalledTimes(1);
		expect(runSessionTransitionCalls).toBe(2);
	});
});
