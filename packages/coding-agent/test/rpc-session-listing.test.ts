import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	listAllRpcSessions,
	listRpcSessions,
	resolveRpcSession,
	toRpcSessionInfo,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-listing";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	__resetProfileSnapshotForTests,
	getActiveProfile,
	getAgentDir,
	setAgentDir,
	setProfile,
} from "@oh-my-pi/pi-utils";

const USER_MESSAGE = { role: "user" as const, content: "hello from rpc listing", timestamp: 0 };

describe("RPC session listing", () => {
	it("serializes SessionInfo dates as explicit ISO strings", () => {
		const created = new Date("2026-06-25T12:00:00.000Z");
		const modified = new Date("2026-06-25T12:05:00.000Z");

		expect(
			toRpcSessionInfo({
				path: "/tmp/session.jsonl",
				id: "session-1",
				cwd: "/tmp/project",
				title: "Session One",
				parentSessionPath: "/tmp/parent.jsonl",
				created,
				modified,
				messageCount: 3,
				size: 1234,
				firstMessage: "hello",
				allMessagesText: "hello\nworld",
				status: "complete",
			}),
		).toEqual({
			path: "/tmp/session.jsonl",
			id: "session-1",
			cwd: "/tmp/project",
			title: "Session One",
			parentSessionPath: "/tmp/parent.jsonl",
			created: created.toISOString(),
			modified: modified.toISOString(),
			messageCount: 3,
			size: 1234,
			firstMessage: "hello",
			allMessagesText: "hello\nworld",
			status: "complete",
		});
	});

	it("falls back to modified when a session has an invalid created date", () => {
		const modified = new Date("2026-06-25T12:05:00.000Z");

		const result = toRpcSessionInfo({
			path: "/tmp/session.jsonl",
			id: "session-1",
			cwd: "/tmp/project",
			title: "Session One",
			created: new Date(""),
			modified,
			messageCount: 3,
			size: 1234,
			firstMessage: "hello",
			allMessagesText: "hello\nworld",
			status: "complete",
		});

		expect(result.created).toBe(modified.toISOString());
		expect(result.modified).toBe(modified.toISOString());
	});

	it("does not resolve an empty session selector", async () => {
		const fixture = await createSessionFixture();
		try {
			const result = await resolveRpcSession(fakeSession(fixture.manager), { session: "" });

			expect(result.match).toBeNull();
		} finally {
			await fixture.dispose();
		}
	});

	it("lists sessions from the current RPC session directory by default", async () => {
		const fixture = await createSessionFixture();
		try {
			const result = await listRpcSessions(fakeSession(fixture.manager));

			expect(result.cwd).toBe(fixture.cwd);
			expect(result.sessionDir).toBe(fixture.sessionDir);
			expect(result.sessions).toHaveLength(1);
			expect(result.sessions[0]?.id).toBe(fixture.manager.getSessionId());
			expect(result.sessions[0]?.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(typeof result.sessions[0]?.modified).toBe("string");
		} finally {
			await fixture.dispose();
		}
	});

	it("resolves a resumable session by id prefix", async () => {
		const fixture = await createSessionFixture();
		try {
			const idPrefix = fixture.manager.getSessionId().slice(0, 8);
			const result = await resolveRpcSession(fakeSession(fixture.manager), { session: idPrefix });

			expect(result.match?.scope).toBe("local");
			expect(result.match?.session.id).toBe(fixture.manager.getSessionId());
		} finally {
			await fixture.dispose();
		}
	});

	it("resolves a resumable session by absolute path", async () => {
		const fixture = await createSessionFixture();
		try {
			const sessionFile = fixture.manager.getSessionFile();
			expect(sessionFile).toBeDefined();
			const result = await resolveRpcSession(fakeSession(fixture.manager), { session: sessionFile! });

			expect(result.match?.scope).toBe("local");
			expect(result.match?.session.path).toBe(sessionFile);
		} finally {
			await fixture.dispose();
		}
	});

	it("ignores caller-provided sessionDir fields", async () => {
		const fixture = await createSessionFixture();
		const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-sessiondir-"));
		try {
			const outsideCwd = path.join(outsideRoot, "project");
			const outsideDir = path.join(outsideRoot, "sessions");
			await fs.mkdir(outsideCwd, { recursive: true });
			const outsideManager = SessionManager.create(outsideCwd, outsideDir);
			outsideManager.appendMessage({ ...USER_MESSAGE, content: "outside session" });
			await outsideManager.ensureOnDisk();

			const unsafeListOptions = { sessionDir: outsideDir } as unknown as Parameters<typeof listRpcSessions>[1];
			const list = await listRpcSessions(fakeSession(fixture.manager), unsafeListOptions);
			expect(list.sessionDir).toBe(fixture.sessionDir);
			expect(list.sessions.map(session => session.id)).not.toContain(outsideManager.getSessionId());

			const unsafeResolveOptions = {
				session: outsideManager.getSessionId(),
				sessionDir: outsideDir,
			} as unknown as Parameters<typeof resolveRpcSession>[1];
			const resolved = await resolveRpcSession(fakeSession(fixture.manager), unsafeResolveOptions);
			expect(resolved.match).toBeNull();
		} finally {
			await fixture.dispose();
			await fs.rm(outsideRoot, { recursive: true, force: true });
		}
	});

	it("falls back to configured global sessions after custom session directory misses", async () => {
		await withIsolatedAgentDir(async root => {
			const target = await createDefaultSessionFixture(root, "target-project");
			const currentCwd = path.join(root, "current-project");
			const currentSessionDir = path.join(root, "custom-sessions");
			await fs.mkdir(currentCwd, { recursive: true });
			const currentManager = SessionManager.create(currentCwd, currentSessionDir);
			currentManager.appendMessage({ ...USER_MESSAGE, content: "current custom session" });
			await currentManager.ensureOnDisk();

			const byId = await resolveRpcSession(fakeSession(currentManager), { session: target.manager.getSessionId() });
			expect(byId.match?.scope).toBe("global");
			expect(byId.match?.session.id).toBe(target.manager.getSessionId());

			const targetFile = target.manager.getSessionFile();
			expect(targetFile).toBeDefined();
			const byPath = await resolveRpcSession(fakeSession(currentManager), { session: targetFile! });
			expect(byPath.match?.scope).toBe("global");
			expect(byPath.match?.session.path).toBe(targetFile);
		});
	});

	it("lists all sessions from the configured agent directory", async () => {
		await withIsolatedAgentDir(async root => {
			const first = await createDefaultSessionFixture(root, "project-one");
			const second = await createDefaultSessionFixture(root, "project-two");

			const result = await listAllRpcSessions();

			expect(result.sessions.map(session => session.id).sort()).toEqual(
				[first.manager.getSessionId(), second.manager.getSessionId()].sort(),
			);
		});
	});

	it("recovers orphaned backup sessions when listing all configured sessions", async () => {
		await withIsolatedAgentDir(async root => {
			const fixture = await createDefaultSessionFixture(root, "backup-project");
			const sessionFile = fixture.manager.getSessionFile();
			expect(sessionFile).toBeDefined();
			await fs.rename(sessionFile!, `${sessionFile}.123456.bak`);

			const result = await listAllRpcSessions();

			expect(result.sessions.map(session => session.id)).toContain(fixture.manager.getSessionId());
			expect(
				await fs.stat(sessionFile!).then(
					() => true,
					() => false,
				),
			).toBe(true);
		});
	});

	it("does not clobber a recreated primary during orphaned backup recovery", async () => {
		await withIsolatedAgentDir(async root => {
			const fixture = await createDefaultSessionFixture(root, "backup-race");
			const sessionFile = fixture.manager.getSessionFile();
			expect(sessionFile).toBeDefined();
			const backupContent = await fs.readFile(sessionFile!, "utf8");
			const currentContent = backupContent.replace("backup-race", "current-primary");
			await fs.rename(sessionFile!, `${sessionFile}.123456.bak`);
			await fs.writeFile(sessionFile!, currentContent);

			await listAllRpcSessions();

			expect(await fs.readFile(sessionFile!, "utf8")).toBe(currentContent);
		});
	});

	it("resolves global sessions when using the default session directory", async () => {
		await withIsolatedAgentDir(async root => {
			const target = await createDefaultSessionFixture(root, "target-project");
			const current = await createDefaultSessionFixture(root, "current-project");
			const result = await resolveRpcSession(fakeSession(current.manager), {
				session: target.manager.getSessionId(),
			});

			expect(result.match?.scope).toBe("global");
			expect(result.match?.session.id).toBe(target.manager.getSessionId());
		});
	});
});

async function createSessionFixture(): Promise<{
	cwd: string;
	sessionDir: string;
	manager: SessionManager;
	dispose: () => Promise<void>;
}> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-session-listing-"));
	const cwd = path.join(root, "project");
	const sessionDir = path.join(root, "sessions");
	await fs.mkdir(cwd, { recursive: true });
	const manager = SessionManager.create(cwd, sessionDir);
	manager.appendMessage(USER_MESSAGE);
	await manager.ensureOnDisk();
	return {
		cwd,
		sessionDir,
		manager,
		dispose: () => fs.rm(root, { recursive: true, force: true }),
	};
}

async function withIsolatedAgentDir<T>(run: (root: string) => Promise<T>): Promise<T> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-agent-dir-"));
	const originalAgentDir = getAgentDir();
	const originalProfile = getActiveProfile();
	const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
	const originalOmpProfileEnv = process.env.OMP_PROFILE;
	const originalPiProfileEnv = process.env.PI_PROFILE;
	setAgentDir(path.join(root, "agent"));
	try {
		return await run(root);
	} finally {
		if (originalProfile) {
			setProfile(originalProfile);
		} else {
			setAgentDir(originalAgentDir);
		}
		restoreEnv("OMP_PROFILE", originalOmpProfileEnv);
		restoreEnv("PI_PROFILE", originalPiProfileEnv);
		restoreEnv("PI_CODING_AGENT_DIR", originalAgentDirEnv);
		__resetProfileSnapshotForTests();
		await fs.rm(root, { recursive: true, force: true });
	}
}

async function createDefaultSessionFixture(
	root: string,
	projectName: string,
): Promise<{ cwd: string; manager: SessionManager }> {
	const cwd = path.join(root, projectName);
	await fs.mkdir(cwd, { recursive: true });
	const manager = SessionManager.create(cwd);
	manager.appendMessage({ ...USER_MESSAGE, content: `${USER_MESSAGE.content} ${projectName}` });
	await manager.ensureOnDisk();
	return { cwd, manager };
}

function restoreEnv(name: "OMP_PROFILE" | "PI_PROFILE" | "PI_CODING_AGENT_DIR", value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

function fakeSession(manager: SessionManager): Pick<AgentSession, "sessionManager"> {
	return { sessionManager: manager };
}
