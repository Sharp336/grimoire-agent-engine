import { describe, expect, it, spyOn } from "bun:test";
import {
	listSessionCatalog,
	projectSessionCatalogLifecycle,
	projectSessionTree,
	resolveSessionCatalogReference,
	type SessionCatalogError,
	setSessionCatalogSnapshotEntryLimitForTesting,
} from "@oh-my-pi/pi-coding-agent/session/session-catalog";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";

const CWD = "/workspace/catalog";

function seedSession(
	storage: MemorySessionStorage,
	file: string,
	id: string,
	title: string,
	firstMessage: string,
): void {
	storage.writeTextSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id, cwd: CWD, title, timestamp: "2026-08-01T00:00:00.000Z" }),
			JSON.stringify({
				type: "message",
				id: `${id}-message`,
				timestamp: "2026-08-01T00:00:01.000Z",
				message: { role: "user", content: firstMessage },
			}),
			"",
		].join("\n"),
	);
}
function seededCatalog(): { storage: MemorySessionStorage; paths: string[] } {
	const storage = new MemorySessionStorage();
	const dir = SessionManager.getDefaultSessionDir(CWD, undefined, storage);
	const paths = [`${dir}/a.jsonl`, `${dir}/b.jsonl`, `${dir}/c.jsonl`];
	const now = spyOn(Date, "now").mockReturnValue(1_754_006_400_000);
	try {
		seedSession(storage, paths[0]!, "0190aaaa-1111", "Alpha", "first alpha prompt");
		seedSession(storage, paths[1]!, "0190aaaa-2222", "Beta", "second beta prompt");
		seedSession(storage, paths[2]!, "0190cccc-3333", "Gamma", "third gamma prompt");
	} finally {
		now.mockRestore();
	}
	return { storage, paths };
}

describe("session catalog authority projections", () => {
	it("separates live activity from durable continuation state", () => {
		expect(projectSessionCatalogLifecycle("complete", true)).toEqual({
			activity: "active",
			continuation: "complete",
			resumable: true,
			recoverable: false,
			reconnectable: true,
		});
		expect(projectSessionCatalogLifecycle("interrupted", false)).toEqual({
			activity: "closed",
			continuation: "incomplete",
			resumable: true,
			recoverable: true,
			reconnectable: false,
		});
		expect(projectSessionCatalogLifecycle("error", false)).toEqual({
			activity: "closed",
			continuation: "failed",
			resumable: true,
			recoverable: true,
			reconnectable: false,
		});
		expect(projectSessionCatalogLifecycle("unknown", false)).toEqual({
			activity: "closed",
			continuation: "ambiguous",
			resumable: true,
			recoverable: false,
			reconnectable: false,
		});
	});

	it("projects the real tree without copying journal payloads", () => {
		const roots = projectSessionTree(
			[
				{
					entry: {
						type: "message",
						id: "root",
						parentId: null,
						timestamp: "2026-08-01T00:00:00.000Z",
						message: { role: "user", content: "private root prompt", timestamp: 1 },
					},
					children: [
						{
							entry: {
								type: "message",
								id: "leaf",
								parentId: "root",
								timestamp: "2026-08-01T00:00:01.000Z",
								message: {
									role: "assistant",
									content: [],
									api: "anthropic-messages",
									provider: "anthropic",
									model: "claude-sonnet-4-5",
									usage: {
										input: 0,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										totalTokens: 0,
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
									},
									stopReason: "stop",
									timestamp: 2,
								},
							},
							children: [],
							label: "selected",
						},
					],
				},
			],
			"leaf",
		);

		expect(roots).toEqual([
			{
				id: "root",
				parentId: null,
				timestamp: "2026-08-01T00:00:00.000Z",
				entryType: "message",
				messageRole: "user",
				activeBranch: true,
				activeLeaf: false,
				children: [
					{
						id: "leaf",
						parentId: "root",
						timestamp: "2026-08-01T00:00:01.000Z",
						entryType: "message",
						messageRole: "assistant",
						label: "selected",
						activeBranch: true,
						activeLeaf: true,
						children: [],
					},
				],
			},
		]);
		expect(JSON.stringify(roots)).not.toContain("private root prompt");
	});
	it("marks only the authoritative live session reconnectable", async () => {
		const { storage } = seededCatalog();
		const page = await listSessionCatalog({ scope: "cwd", cwd: CWD }, storage, { activeSessionId: "0190aaaa-2222" });

		expect(
			page.sessions.map(session => ({
				id: session.id,
				activity: session.lifecycle.activity,
				reconnectable: session.lifecycle.reconnectable,
			})),
		).toEqual([
			{ id: "0190aaaa-1111", activity: "closed", reconnectable: false },
			{ id: "0190aaaa-2222", activity: "active", reconnectable: true },
			{ id: "0190cccc-3333", activity: "closed", reconnectable: false },
		]);
	});
});

describe("session catalog", () => {
	it("uses an opaque snapshot cursor and never leaks transcript text", async () => {
		const { storage, paths } = seededCatalog();
		const first = await listSessionCatalog({ scope: "cwd", cwd: CWD, limit: 2 }, storage);
		expect(first.nextCursor).toBeDefined();
		expect(first.nextCursor).not.toBe("2");

		seedSession(
			storage,
			`${SessionManager.getDefaultSessionDir(CWD, undefined, storage)}/0.jsonl`,
			"new-session",
			"New",
			"secret inserted prompt",
		);
		const second = await listSessionCatalog({ scope: "cwd", cwd: CWD, limit: 2, cursor: first.nextCursor }, storage);
		const combined = [...first.sessions, ...second.sessions];

		expect(first.total).toBe(3);
		expect(combined.map(session => session.path)).toEqual(paths);
		const serialized = JSON.stringify(combined);
		expect(serialized).not.toContain("prompt");
		expect(serialized).not.toContain("secret");
		expect(serialized).not.toContain("allMessagesText");
	});

	it("searches title and id without searching transcript text", async () => {
		const { storage } = seededCatalog();
		const byTitle = await listSessionCatalog({ scope: "cwd", cwd: CWD, search: "beta" }, storage);
		const byId = await listSessionCatalog({ scope: "cwd", cwd: CWD, search: "cccc" }, storage);
		const byPrompt = await listSessionCatalog({ scope: "cwd", cwd: CWD, search: "second beta prompt" }, storage);

		expect(byTitle.sessions.map(session => session.title)).toEqual(["Beta"]);
		expect(byId.sessions.map(session => session.title)).toEqual(["Gamma"]);
		expect(byPrompt.sessions).toEqual([]);
	});

	it("resolves cataloged paths and rejects arbitrary absolute paths", async () => {
		const { storage, paths } = seededCatalog();
		const resolved = await resolveSessionCatalogReference(paths[0]!, { scope: "cwd", cwd: CWD }, storage);
		expect(resolved.entry.id).toBe("0190aaaa-1111");

		await expect(
			resolveSessionCatalogReference("/tmp/not-a-session.jsonl", { scope: "cwd", cwd: CWD }, storage),
		).rejects.toMatchObject({ code: "path_not_in_catalog" } satisfies Partial<SessionCatalogError>);
	});

	it("rejects ambiguous id prefixes instead of selecting the first match", async () => {
		const { storage } = seededCatalog();
		await expect(
			resolveSessionCatalogReference("0190aaaa", { scope: "cwd", cwd: CWD }, storage),
		).rejects.toMatchObject({ code: "session_ambiguous" } satisfies Partial<SessionCatalogError>);
	});

	it("reports an invalid limit independently from cursor errors", async () => {
		const { storage } = seededCatalog();
		await expect(listSessionCatalog({ scope: "cwd", cwd: CWD, limit: 201 }, storage)).rejects.toMatchObject({
			code: "invalid_limit",
		} satisfies Partial<SessionCatalogError>);
	});

	it("bounds retained entries by snapshot identity while chained cursors remain reusable", async () => {
		const { storage } = seededCatalog();
		const restore = setSessionCatalogSnapshotEntryLimitForTesting(4);
		try {
			const oldest = await listSessionCatalog({ scope: "cwd", cwd: CWD, limit: 1 }, storage);
			const newest = await listSessionCatalog({ scope: "cwd", cwd: CWD, limit: 1 }, storage);
			expect(oldest.nextCursor).toBeDefined();
			expect(newest.nextCursor).toBeDefined();

			await expect(
				listSessionCatalog({ scope: "cwd", cwd: CWD, cursor: oldest.nextCursor }, storage),
			).rejects.toMatchObject({ code: "invalid_cursor" } satisfies Partial<SessionCatalogError>);

			const second = await listSessionCatalog({ scope: "cwd", cwd: CWD, cursor: newest.nextCursor }, storage);
			const repeated = await listSessionCatalog({ scope: "cwd", cwd: CWD, cursor: newest.nextCursor }, storage);
			expect(repeated.sessions).toEqual(second.sessions);
			expect(repeated.nextCursor).toBe(second.nextCursor);
			const third = await listSessionCatalog({ scope: "cwd", cwd: CWD, cursor: second.nextCursor }, storage);
			expect(third.sessions).toHaveLength(1);
		} finally {
			restore();
		}
	});
});
