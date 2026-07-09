import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const STOP = "stop after session options";

/** Snapshot + restore the global PI_NO_PTY env mutation main.ts performs at startup. */
async function withPreservedNoPty<T>(fn: () => Promise<T>): Promise<T> {
	const saved = Bun.env.PI_NO_PTY;
	try {
		return await fn();
	} finally {
		if (saved === undefined) {
			delete Bun.env.PI_NO_PTY;
		} else {
			Bun.env.PI_NO_PTY = saved;
		}
	}
}

/**
 * Drive runRootCommand far enough to capture the CreateAgentSessionOptions, then
 * abort by throwing the sentinel inside the injected createAgentSession (mirrors
 * cli-max-time-flag.test.ts). Returns the options main.ts assembled for the mode.
 */
async function captureSessionOptions(argv: string[]): Promise<CreateAgentSessionOptions> {
	using tempDir = TempDir.createSync("@omp-rpc-ask-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
	const parsed = parseArgs(argv);
	parsed.noExtensions = true;
	parsed.noSkills = true;
	parsed.noRules = true;
	parsed.noTools = true;
	parsed.noLsp = true;
	parsed.sessionDir = tempDir.path();

	let observedOptions: CreateAgentSessionOptions | undefined;
	try {
		await runRootCommand(parsed, argv, {
			discoverAuthStorage: async () => authStorage,
			settings,
			createAgentSession: async options => {
				observedOptions = options;
				throw new Error(STOP);
			},
		});
	} catch (error) {
		if (!(error instanceof Error) || error.message !== STOP) {
			throw error;
		}
	} finally {
		authStorage.close();
	}

	if (!observedOptions) {
		throw new Error("createAgentSession was never reached");
	}
	return observedOptions;
}

describe("rpc ask startup wiring", () => {
	it("marks plain --mode rpc as prompt-capable without flipping hasUI, and forces PI_NO_PTY", async () => {
		await withPreservedNoPty(async () => {
			const options = await captureSessionOptions(["--mode", "rpc"]);
			expect(options.supportsUserPrompt).toBe(true);
			expect(options.hasUI).toBe(false);
			expect(Bun.env.PI_NO_PTY).toBe("1");
		});
	});

	it("leaves --mode json non-prompt-capable", async () => {
		await withPreservedNoPty(async () => {
			const options = await captureSessionOptions(["--mode", "json", "hello"]);
			expect(options.supportsUserPrompt).toBeFalsy();
			expect(options.hasUI).toBeFalsy();
		});
	});

	it("leaves --print non-prompt-capable", async () => {
		await withPreservedNoPty(async () => {
			const options = await captureSessionOptions(["--print", "hello"]);
			expect(options.supportsUserPrompt).toBeFalsy();
			expect(options.hasUI).toBeFalsy();
		});
	});

	it("passes the real setToolUIContext into runRpcMode for plain --mode rpc", async () => {
		await withPreservedNoPty(async () => {
			using tempDir = TempDir.createSync("@omp-rpc-ask-seam-");
			const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
			const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
			const parsed = parseArgs(["--mode", "rpc"]);
			parsed.noExtensions = true;
			parsed.noSkills = true;
			parsed.noRules = true;
			parsed.noTools = true;
			parsed.noLsp = true;
			parsed.sessionDir = tempDir.path();

			// The exact setter instance createAgentSession hands back; the seam must
			// forward THIS reference to runRpcMode (proving plain rpc no longer passes
			// undefined). Only `.model` is read on the path to the rpc branch.
			const sentinel = (() => {}) as unknown as (uiContext: never, hasUI: boolean) => void;
			const fakeSession = { model: { provider: "test", id: "test" } };

			let captured: ((uiContext: never, hasUI: boolean) => void) | undefined;
			try {
				await runRootCommand(parsed, ["--mode", "rpc"], {
					discoverAuthStorage: async () => authStorage,
					settings,
					createAgentSession: async () =>
						({
							session: fakeSession,
							setToolUIContext: sentinel,
							modelFallbackMessage: undefined,
							lspServers: undefined,
							mcpManager: undefined,
						}) as unknown as CreateAgentSessionResult,
					// Capture the forwarded setter, then throw to abort the run. An
					// always-throwing async body infers Promise<never>, matching the
					// RunRpcMode signature (a normal return would type as Promise<void>).
					runRpcMode: async (_session, setToolUIContext) => {
						captured = setToolUIContext;
						throw new Error(STOP);
					},
				});
			} catch (error) {
				if (!(error instanceof Error) || error.message !== STOP) {
					throw error;
				}
			} finally {
				authStorage.close();
			}

			expect(captured).toBe(sentinel);
		});
	});
});
