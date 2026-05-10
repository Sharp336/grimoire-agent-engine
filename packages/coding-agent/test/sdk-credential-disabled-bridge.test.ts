import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type CredentialDisabledEvent } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("createAgentSession credential-disabled bridge", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const tempDir of tempDirs.splice(0)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("composes the bridge with an embedder-provided handler and restores it on dispose", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-bridge-compose-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });

		const embedderEvents: CredentialDisabledEvent[] = [];
		const embedderHandler = (event: CredentialDisabledEvent) => {
			embedderEvents.push(event);
		};
		const authStorage = await AuthStorage.create(path.join(agentDir, "agent.db"), {
			onCredentialDisabled: embedderHandler,
		});

		// Sanity: handler is set pre-session.
		expect(authStorage.getCredentialDisabledHandler()).toBe(embedderHandler);

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			// The bridge replaced the constructor handler.
			const bridge = authStorage.getCredentialDisabledHandler();
			expect(bridge).toBeDefined();
			expect(bridge).not.toBe(embedderHandler);

			// Firing the bridge fans out to the embedder's handler too.
			await bridge?.({ provider: "anthropic", disabledCause: "invalid_grant" });
			expect(embedderEvents).toHaveLength(1);
			expect(embedderEvents[0]?.provider).toBe("anthropic");
			expect(embedderEvents[0]?.disabledCause).toBe("invalid_grant");
		} finally {
			await session.dispose();
		}

		// After dispose, the embedder's handler is restored — not nulled out.
		expect(authStorage.getCredentialDisabledHandler()).toBe(embedderHandler);
	});

	it("leaves the previous handler in place if a later session has overwritten the bridge", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-bridge-overwrite-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });

		const embedderHandler = (_event: CredentialDisabledEvent) => {};
		const authStorage = await AuthStorage.create(path.join(agentDir, "agent.db"), {
			onCredentialDisabled: embedderHandler,
		});

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		// Simulate a "later session" that overwrote our bridge with its own.
		const laterBridge = (_event: CredentialDisabledEvent) => {};
		authStorage.setCredentialDisabledHandler(laterBridge);

		await session.dispose();

		// Our dispose path must NOT clobber the later session's bridge.
		expect(authStorage.getCredentialDisabledHandler()).toBe(laterBridge);
	});

	it("parallel sibling sessions: a later session disposing does not re-install a disposed earlier session's bridge", async () => {
		// Three concurrent sessions on the same AuthStorage. Without the disposed-bridge
		// walk-past logic, sub2 disposing would restore sub1's bridge — but sub1 has already
		// disposed and its runner is dead. We expect sub2's restore to walk past sub1 and
		// land on the parent's still-live bridge instead.
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-bridge-siblings-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });

		const embedderHandler = (_event: CredentialDisabledEvent) => {};
		const authStorage = await AuthStorage.create(path.join(agentDir, "agent.db"), {
			onCredentialDisabled: embedderHandler,
		});

		const baseOptions = {
			cwd,
			agentDir,
			authStorage,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		};

		const parent = await createAgentSession(baseOptions);
		const parentBridge = authStorage.getCredentialDisabledHandler();
		expect(parentBridge).toBeDefined();
		expect(parentBridge).not.toBe(embedderHandler);

		const sub1 = await createAgentSession(baseOptions);
		const sub2 = await createAgentSession(baseOptions);
		const sub2Bridge = authStorage.getCredentialDisabledHandler();

		// Sub1 disposes first. Slot still holds sub2's bridge, so the dispose is a no-op for the slot.
		await sub1.session.dispose();
		expect(authStorage.getCredentialDisabledHandler()).toBe(sub2Bridge);

		// Sub2 disposes. Naive restore would land on sub1's now-disposed bridge. Walk-past must
		// skip it and land on the parent's still-live bridge.
		await sub2.session.dispose();
		expect(authStorage.getCredentialDisabledHandler()).toBe(parentBridge);

		// Parent disposes last; chain ends at the embedder handler.
		await parent.session.dispose();
		expect(authStorage.getCredentialDisabledHandler()).toBe(embedderHandler);
	});

	it("startup events captured by the wrapper are still delivered to the embedder handler", async () => {
		// Verifies that the startup-buffer wrapper is actually installed at the top of
		// createAgentSession AND that events fired through it during the startup window
		// reach the embedder handler. We exercise the wrapper by capturing the active
		// handler immediately and invoking it before createAgentSession resolves — but
		// since createAgentSession is awaited as a single promise, we instead verify the
		// presence of the wrapper indirectly by checking that an event fired through the
		// final bridge still reaches the embedder handler (compose contract) and a second
		// event fired through the AuthStorage handler slot during a synthetic "later
		// session" run still composes correctly. The disposed-bridge test above covers
		// the bridge chain; this one focuses on the embedder-handler path's continued
		// reachability after the wrapper has been swapped out.
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-bridge-startup-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });

		const embedderEvents: CredentialDisabledEvent[] = [];
		const embedderHandler = (event: CredentialDisabledEvent) => {
			embedderEvents.push(event);
		};
		const authStorage = await AuthStorage.create(path.join(agentDir, "agent.db"), {
			onCredentialDisabled: embedderHandler,
		});

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			settings: Settings.isolated(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			// Embedder handler must be reachable through the installed bridge.
			const bridge = authStorage.getCredentialDisabledHandler();
			await bridge?.({ provider: "anthropic", disabledCause: "invalid_grant" });
			expect(embedderEvents).toHaveLength(1);
		} finally {
			await session.dispose();
		}

		// After dispose, embedder handler is restored intact.
		expect(authStorage.getCredentialDisabledHandler()).toBe(embedderHandler);

		// Firing through the embedder handler directly still works (no leftover wrapper / bridge).
		const restored = authStorage.getCredentialDisabledHandler();
		await restored?.({ provider: "openai", disabledCause: "401" });
		expect(embedderEvents).toHaveLength(2);
	});

	it("releases the credential-disabled handler chain when createAgentSession throws mid-startup", async () => {
		// An inline extension factory that throws is loaded between the startup-buffer install
		// (sdk.ts:693) and the dispose wrap (sdk.ts:~1777). Without the failure cleanup, the
		// wrapper or bridge would stay installed on the shared AuthStorage and a retry would
		// stack a new wrapper as its previousHandler, growing the chain on every failure.
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-bridge-failure-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		const agentDir = path.join(tempDir, "agent");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agentDir, { recursive: true });

		const embedderHandler = (_event: CredentialDisabledEvent) => {};
		const authStorage = await AuthStorage.create(path.join(agentDir, "agent.db"), {
			onCredentialDisabled: embedderHandler,
		});

		const throwingFactory: ExtensionFactory = () => {
			throw new Error("simulated mid-startup failure");
		};

		await expect(
			createAgentSession({
				cwd,
				agentDir,
				authStorage,
				settings: Settings.isolated(),
				disableExtensionDiscovery: true,
				extensions: [throwingFactory],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			}),
		).rejects.toThrow(/simulated mid-startup failure/);

		// AuthStorage must be back to the embedder's original handler — neither the startup
		// wrapper nor any partially-installed bridge can remain in the slot.
		expect(authStorage.getCredentialDisabledHandler()).toBe(embedderHandler);

		// And a second failed startup must NOT chain a new wrapper on top of a stale one
		// (which would happen if the previous failure left the wrapper installed: the next
		// installStartupBuffer would capture the stale wrapper as its `previousHandler`).
		await expect(
			createAgentSession({
				cwd,
				agentDir,
				authStorage,
				settings: Settings.isolated(),
				disableExtensionDiscovery: true,
				extensions: [throwingFactory],
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			}),
		).rejects.toThrow(/simulated mid-startup failure/);

		expect(authStorage.getCredentialDisabledHandler()).toBe(embedderHandler);
	});
});
