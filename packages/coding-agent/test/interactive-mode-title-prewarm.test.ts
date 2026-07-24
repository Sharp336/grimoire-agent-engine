import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { tinyTitleClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { type RenderScheduler, TUI } from "@oh-my-pi/pi-tui";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

describe("InteractiveMode title worker prewarm", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode | undefined;
	let session: AgentSession | undefined;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-interactive-mode-title-prewarm-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		Settings.instance.set("startup.quiet", true);
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		mode = undefined;
		session = undefined;
		resetSettingsForTest();
		await tinyTitleClient.terminate();
	});

	function createMode(): InteractiveMode {
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.instance,
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		return mode;
	}

	function orderingScheduler(order: string[]): RenderScheduler {
		return {
			now: () => performance.now(),
			scheduleImmediate: callback => {
				setImmediate(() => {
					order.push("frame");
					callback();
				});
			},
			scheduleRender: (callback, delayMs) => {
				const timer = setTimeout(callback, delayMs);
				return {
					cancel: () => {
						clearTimeout(timer);
					},
				};
			},
		};
	}

	async function flushImmediates(times = 4): Promise<void> {
		for (let i = 0; i < times; i++) {
			await new Promise<void>(resolve => {
				setImmediate(resolve);
			});
		}
	}

	it("paints the initial forced frame before the title worker factory runs", async () => {
		Settings.instance.set("providers.tinyModel", "lfm2-350m");
		const created = createMode();
		const order: string[] = [];
		const term = new VirtualTerminal(80, 24);
		created.ui = new TUI(term, undefined, { renderScheduler: orderingScheduler(order) });

		const prewarm = vi.spyOn(tinyTitleClient, "prewarm").mockImplementation(() => {
			order.push("prewarm");
		});

		await created.init({ suppressWelcomeIntro: true });
		await flushImmediates();

		expect(prewarm).toHaveBeenCalled();
		const frameAt = order.indexOf("frame");
		const prewarmAt = order.indexOf("prewarm");
		expect(frameAt).toBeGreaterThanOrEqual(0);
		expect(prewarmAt).toBeGreaterThan(frameAt);
	});

	it("skips prewarm when Tiny Model is Online", async () => {
		Settings.instance.set("providers.tinyModel", "online");
		const created = createMode();
		const term = new VirtualTerminal(80, 24);
		created.ui = new TUI(term);
		const prewarm = vi.spyOn(tinyTitleClient, "prewarm");

		await created.init({ suppressWelcomeIntro: true });
		await flushImmediates();

		expect(prewarm).not.toHaveBeenCalled();
	});

	it("queued prewarm after shutdown does not spawn a worker", async () => {
		Settings.instance.set("providers.tinyModel", "lfm2-350m");
		const created = createMode();
		const term = new VirtualTerminal(80, 24);
		created.ui = new TUI(term);

		const queued: Array<() => void> = [];
		vi.spyOn(globalThis, "setImmediate").mockImplementation(((
			callback: (...args: unknown[]) => void,
			...args: unknown[]
		) => {
			const run = () => {
				callback(...args);
			};
			queued.push(run);
			return run as unknown as ReturnType<typeof setImmediate>;
		}) as typeof setImmediate);
		// Leave clearImmediate as a no-op so a queued prewarm survives stop()
		// and the #isShuttingDown guard is what must suppress respawn.
		vi.spyOn(globalThis, "clearImmediate").mockImplementation(() => {});
		vi.spyOn(postmortem, "quit").mockResolvedValue(undefined);

		const prewarm = vi.spyOn(tinyTitleClient, "prewarm");

		await created.init({ suppressWelcomeIntro: true });
		expect(queued.length).toBeGreaterThan(0);

		await created.shutdown();
		expect(created.isShuttingDown).toBe(true);

		for (const run of [...queued]) run();

		expect(prewarm).not.toHaveBeenCalled();
	});
});
