/**
 * Contracts: history:// protocol handler (rework-contracts.md §6), resolved
 * through `InternalUrlRouter.instance().resolve(...)` like real callers.
 *
 * - Bare `history://` renders an index listing registered agent ids.
 * - `history://<id>` with a live ref renders the in-memory transcript.
 * - A parked ref (session null, sessionFile retained) renders read-only from
 *   the JSONL session file.
 * - An unknown id fails with an error listing the known ids.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { HistoryProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/history-protocol";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { getAgentDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "history-protocol-"));
	try {
		return await fn(dir);
	} finally {
		await removeWithRetries(dir);
	}
}

function fakeLiveSession(messages: unknown[]): AgentSession {
	return { messages } as unknown as AgentSession;
}

function makeToolSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "artifacts"),
		allocateOutputArtifact: async toolType => ({
			id: "history-read",
			path: path.join(cwd, "artifacts", `history-read.${toolType}.log`),
		}),
		settings: Settings.isolated(),
	};
}

/** Minimal current-version session JSONL: header + a linear user/assistant chain. */
function sessionFixtureJsonl(id = "fixture-session", cwd = "/tmp", userText = "parked hello", title?: string): string {
	const timestamp = new Date().toISOString();
	const header = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id,
		title,
		timestamp,
		cwd,
	};
	const userEntry = {
		type: "message",
		id: "m1",
		parentId: null,
		timestamp,
		message: { role: "user", content: userText, timestamp: 1 },
	};
	const assistantEntry = {
		type: "message",
		id: "m2",
		parentId: "m1",
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "parked reply" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {},
			stopReason: "stop",
			timestamp: 2,
		},
	};
	return `${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n${JSON.stringify(assistantEntry)}\n`;
}
let originalAgentDir: string;

describe("history:// protocol", () => {
	beforeEach(() => {
		originalAgentDir = getAgentDir();
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
		resetRegisteredArtifactDirsForTests();
	});

	afterEach(() => {
		setAgentDir(originalAgentDir);
		InternalUrlRouter.resetForTests();
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
	});

	it("bare history:// renders an index listing registered agents", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([]),
			status: "idle",
		});

		const resource = await InternalUrlRouter.instance().resolve("history://");

		expect(resource.contentType).toBe("text/markdown");
		expect(resource.content).toContain("# Agents");
		expect(resource.content).toContain("| HubAgent | idle | sub |");
	});

	it("history://<id> renders a live ref's in-memory transcript", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([{ role: "user", content: "hello from live", timestamp: 1 }]),
			status: "idle",
		});

		const resource = await InternalUrlRouter.instance().resolve("history://HubAgent");

		expect(resource.content).toContain("# HubAgent (idle)");
		expect(resource.content).toContain("## user");
		expect(resource.content).toContain("hello from live");
		expect(resource.notes).toContain("Source: live session");
	});

	it("read applies line selectors to history transcripts", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([{ role: "user", content: "hello from live", timestamp: 1 }]),
			status: "idle",
		});
		const tool = new ReadTool(makeToolSession(os.tmpdir()));

		const result = await tool.execute("history-range", { path: "history://HubAgent:1-1" });
		const output = result.content.find(content => content.type === "text");

		expect(output?.type).toBe("text");
		if (output?.type !== "text") throw new Error("Expected text output");
		expect(output.text).toContain("# HubAgent (idle)");
		expect(output.text).not.toContain("hello from live");
	});

	it("resolves agent ids case-insensitively", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([{ role: "user", content: "hello from live", timestamp: 1 }]),
			status: "idle",
		});

		const resource = await InternalUrlRouter.instance().resolve("history://hubagent");
		expect(resource.content).toContain("# HubAgent (idle)");
	});

	it("history://<id> renders a parked ref read-only from its session file", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "parked.jsonl");
			await Bun.write(sessionFile, sessionFixtureJsonl());
			AgentRegistry.global().register({
				id: "Sleeper",
				displayName: "task",
				kind: "sub",
				session: null,
				sessionFile,
				status: "parked",
			});

			const resource = await InternalUrlRouter.instance().resolve("history://Sleeper");

			expect(resource.content).toContain("# Sleeper (parked)");
			expect(resource.content).toContain("parked hello");
			expect(resource.content).toContain("parked reply");
			expect(resource.sourcePath).toBe(sessionFile);
			expect(resource.notes?.join("\n")).toContain("read-only");
		});
	});

	it("rejects an unknown id with the list of known agents", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([]),
			status: "idle",
		});

		const error = await InternalUrlRouter.instance()
			.resolve("history://Nope")
			.then(
				() => null,
				err => err as Error,
			);

		expect(error).toBeInstanceOf(Error);
		expect(error?.message).toContain("Unknown agent: Nope");
		expect(error?.message).toContain("HubAgent");
	});

	it("rejects a ref with neither session nor session file", async () => {
		AgentRegistry.global().register({
			id: "Husk",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: null,
			status: "aborted",
		});

		const error = await InternalUrlRouter.instance()
			.resolve("history://Husk")
			.then(
				() => null,
				err => err as Error,
			);

		expect(error?.message).toContain("no transcript");
	});

	it("hides advisor transcripts from the index and direct lookup", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([]),
			status: "idle",
		});
		AgentRegistry.global().register({
			id: "Main/advisor",
			displayName: "advisor",
			kind: "advisor",
			session: fakeLiveSession([{ role: "user", content: "should stay hidden", timestamp: 1 }]),
			status: "parked",
		});
		AgentRegistry.global().register({
			id: "AdvisorProbe",
			displayName: "advisor",
			kind: "advisor",
			session: fakeLiveSession([{ role: "user", content: "should stay hidden", timestamp: 1 }]),
			status: "parked",
		});

		// Index lists the subagent but never the advisor.
		const index = await InternalUrlRouter.instance().resolve("history://");
		expect(index.content).toContain("HubAgent");
		expect(index.content).not.toContain("advisor");

		// Direct lookup of an advisor-kind ref is reported as unknown — the driving
		// agent must not be able to read it via history://.
		const error = await InternalUrlRouter.instance()
			.resolve("history://AdvisorProbe")
			.then(
				() => null,
				err => err as Error,
			);
		expect(error).toBeInstanceOf(Error);
		expect(error?.message).toContain("Unknown agent");
	});

	it("omits advisor refs from history:// completions", async () => {
		AgentRegistry.global().register({
			id: "HubAgent",
			displayName: "task",
			kind: "sub",
			session: fakeLiveSession([]),
			status: "idle",
		});
		AgentRegistry.global().register({
			id: "AdvisorProbe",
			displayName: "advisor",
			kind: "advisor",
			session: null,
			sessionFile: "/tmp/x/__advisor.jsonl",
			status: "parked",
		});

		const completions = await new HistoryProtocolHandler().complete();
		const values = completions.map(c => c.value);
		expect(values).toContain("HubAgent");
		expect(values).not.toContain("AdvisorProbe");
	});

	it("history://<id> serves an unregistered subagent's transcript from disk", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "session.jsonl");
			const artifactsDir = sessionFile.slice(0, -6);
			await fs.mkdir(artifactsDir, { recursive: true });
			await Bun.write(path.join(artifactsDir, "Sub1.jsonl"), sessionFixtureJsonl());
			// Only Main is registered; Sub1 exists solely on disk.
			AgentRegistry.global().register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: {
					messages: [],
					sessionManager: { getArtifactsDir: () => artifactsDir },
				} as unknown as AgentSession,
				sessionFile,
				status: "idle",
			});

			const resource = await InternalUrlRouter.instance().resolve("history://Sub1");
			expect(resource.content).toContain("# Sub1 (on disk)");
			expect(resource.content).toContain("parked hello");
			expect(resource.sourcePath).toBe(path.join(artifactsDir, "Sub1.jsonl"));
			expect(resource.notes?.join("\n")).toContain("unregistered");
		});
	});

	it("resolves an on-disk-only transcript case-insensitively", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "session.jsonl");
			const artifactsDir = sessionFile.slice(0, -6);
			await fs.mkdir(artifactsDir, { recursive: true });
			await Bun.write(path.join(artifactsDir, "AuthLoader.jsonl"), sessionFixtureJsonl());
			AgentRegistry.global().register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: {
					messages: [],
					sessionManager: { getArtifactsDir: () => artifactsDir },
				} as unknown as AgentSession,
				sessionFile,
				status: "idle",
			});

			const resource = await InternalUrlRouter.instance().resolve("history://authloader");
			expect(resource.content).toContain("# AuthLoader (on disk)");
		});
	});

	it("bare history:// and completions include on-disk agents but never advisor transcripts", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "session.jsonl");
			const artifactsDir = sessionFile.slice(0, -6);
			await fs.mkdir(artifactsDir, { recursive: true });
			await Bun.write(path.join(artifactsDir, "Sub1.jsonl"), sessionFixtureJsonl());
			await Bun.write(path.join(artifactsDir, "__advisor.jsonl"), sessionFixtureJsonl());
			AgentRegistry.global().register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: {
					messages: [],
					sessionManager: { getArtifactsDir: () => artifactsDir },
				} as unknown as AgentSession,
				sessionFile,
				status: "idle",
			});

			const index = await InternalUrlRouter.instance().resolve("history://");
			expect(index.content).toContain("| Sub1 | on disk |");
			expect(index.content).not.toContain("__advisor");

			const completions = await new HistoryProtocolHandler().complete();
			const values = completions.map(c => c.value);
			expect(values).toContain("Sub1");
			expect(values).not.toContain("__advisor");
		});
	});

	it("resolves a nested child transcript one level deeper on disk", async () => {
		await withTempDir(async dir => {
			const sessionFile = path.join(dir, "session.jsonl");
			const artifactsDir = sessionFile.slice(0, -6);
			const childDir = path.join(artifactsDir, "Parent");
			await fs.mkdir(childDir, { recursive: true });
			await Bun.write(path.join(childDir, "Parent.Child.jsonl"), sessionFixtureJsonl());
			AgentRegistry.global().register({
				id: "Main",
				displayName: "main",
				kind: "main",
				session: {
					messages: [],
					sessionManager: { getArtifactsDir: () => artifactsDir },
				} as unknown as AgentSession,
				sessionFile,
				status: "idle",
			});

			const resource = await InternalUrlRouter.instance().resolve("history://Parent.Child");
			expect(resource.content).toContain("# Parent.Child (on disk)");
		});
	});

	it("skips a registered artifact candidate that is a file", async () => {
		await withTempDir(async dir => {
			const candidate = path.join(dir, "not-a-directory");
			await Bun.write(candidate, "not a directory");
			registerArtifactsDir(candidate);

			await expect(new HistoryProtocolHandler().complete()).resolves.toEqual([
				{ value: "agent/", description: "explicit agent transcript namespace" },
				{ value: "session/", description: "archived top-level session namespace" },
			]);
		});
	});
	it("separates agent and archived-session IDs and rejects ambiguous prefixes", async () => {
		await withTempDir(async dir => {
			const agentDir = path.join(dir, "agent");
			const sessionsDir = path.join(agentDir, "sessions", "project");
			await fs.mkdir(sessionsDir, { recursive: true });

			const firstId = "019f0000-aaaa-7000-8000-000000000001";
			const secondId = "019f0000-bbbb-7000-8000-000000000002";
			const firstFile = path.join(sessionsDir, `2026-07-21T12-00-00-000Z_${firstId}.jsonl`);
			await Bun.write(firstFile, sessionFixtureJsonl(firstId, "/tmp/project", "archived hello"));
			await Bun.write(
				path.join(sessionsDir, `2026-07-21T13-00-00-000Z_${secondId}.jsonl`),
				sessionFixtureJsonl(secondId, "/tmp/project", "second archive"),
			);
			setAgentDir(agentDir);
			AgentRegistry.global().register({
				id: firstId,
				displayName: "task",
				kind: "sub",
				session: fakeLiveSession([{ role: "user", content: "live agent", timestamp: 1 }]),
				status: "idle",
			});

			const legacyAgent = await InternalUrlRouter.instance().resolve(`history://${firstId}`);
			expect(legacyAgent.content).toContain("live agent");
			const explicitAgent = await InternalUrlRouter.instance().resolve(`history://agent/${firstId}`);
			expect(explicitAgent.content).toContain("live agent");

			const archived = await InternalUrlRouter.instance().resolve(`history://session/${firstId}`);
			expect(archived.content).toContain("archived hello");
			expect(archived.sourcePath).toBe(firstFile);
			const uniquePrefix = await InternalUrlRouter.instance().resolve("history://session/019f0000-a");
			expect(uniquePrefix.sourcePath).toBe(firstFile);

			await expect(InternalUrlRouter.instance().resolve("history://session/019f0000")).rejects.toThrow(
				"Ambiguous archived session prefix",
			);
		});
	});

	it("lists archived sessions with project scope, filtering, pagination, and no alias duplicates", async () => {
		await withTempDir(async dir => {
			const agentDir = path.join(dir, "agent");
			const projectDir = path.join(agentDir, "sessions", "project");
			const otherDir = path.join(agentDir, "sessions", "other");
			await fs.mkdir(projectDir, { recursive: true });
			await fs.mkdir(otherDir, { recursive: true });
			const firstId = "019f1000-aaaa-7000-8000-000000000001";
			const secondId = "019f1000-aaaa-7000-8000-000000000002";
			const otherId = "019f1000-aaaa-7000-8000-000000000003";
			const firstFile = path.join(projectDir, `2026-07-21T12-00-00-000Z_${firstId}.jsonl`);
			const secondFile = path.join(projectDir, `2026-07-21T13-00-00-000Z_${secondId}.jsonl`);
			const otherFile = path.join(otherDir, `2026-07-21T14-00-00-000Z_${otherId}.jsonl`);
			await Bun.write(firstFile, sessionFixtureJsonl(firstId, "/tmp/project-a", "alpha prompt", "Alpha"));
			await Bun.write(secondFile, sessionFixtureJsonl(secondId, "/tmp/project-a", "beta prompt", "Beta"));
			await Bun.write(otherFile, sessionFixtureJsonl(otherId, "/tmp/project-b", "gamma prompt", "Gamma"));
			await fs.utimes(firstFile, new Date(1_000), new Date(1_000));
			await fs.utimes(secondFile, new Date(2_000), new Date(2_000));
			await fs.utimes(otherFile, new Date(3_000), new Date(3_000));
			setAgentDir(agentDir);

			const firstPage = await InternalUrlRouter.instance().resolve("history://session?limit=1", {
				cwd: "/tmp/project-a",
			});
			expect(firstPage.content).toContain("Showing 1–1 of 2");
			expect(firstPage.content).toContain(secondId);
			expect(firstPage.content).not.toContain(firstId);
			expect(firstPage.content).not.toContain(otherId);
			expect(firstPage.content).toContain("offset=1");

			const secondPage = await InternalUrlRouter.instance().resolve("history://session?limit=1&offset=1", {
				cwd: "/tmp/project-a",
			});
			expect(secondPage.content).toContain(firstId);
			expect(secondPage.content).not.toContain(secondId);

			const filtered = await InternalUrlRouter.instance().resolve("history://session?q=alpha", {
				cwd: "/tmp/project-a",
			});
			expect(filtered.content).toContain(firstId);
			expect(filtered.content).not.toContain(secondId);

			const global = await InternalUrlRouter.instance().resolve("history://session?scope=all", {
				cwd: "/tmp/project-a",
			});
			expect(global.content).toContain(otherId);
			expect(global.content.split("\n").filter(line => line.includes(`history://session/${firstId}`))).toHaveLength(
				1,
			);
		});
	});
	it("rejects direct transcript paths and invalid archive pagination", async () => {
		await expect(InternalUrlRouter.instance().resolve("history:///tmp/session.jsonl")).rejects.toThrow(
			"Direct transcript paths are not supported",
		);
		await expect(InternalUrlRouter.instance().resolve("history://session?limit=0")).rejects.toThrow(
			"Expected an integer 1–100",
		);
	});
});
