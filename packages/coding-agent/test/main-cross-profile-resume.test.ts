/**
 * `--session-profile <name>` resolves the `--resume`/`--fork` target from
 * another profile's session store while the process keeps running the active
 * profile. Covers the happy path (found in the named profile and opened in
 * place), the isolation guarantee (not found without the flag), and the
 * validation that the flag needs a resume/fork target.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Args } from "@oh-my-pi/pi-coding-agent/cli/args";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSessionManager } from "@oh-my-pi/pi-coding-agent/main";
import { getProfileSessionsDir } from "@oh-my-pi/pi-utils";

const stubSettings = { get: () => undefined } as unknown as Settings;

function buildArgs(overrides: Partial<Args>): Args {
	return {
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
		...overrides,
	};
}

function writeSession(dir: string, id: string, headerCwd: string): string {
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, `2025-01-01T00-00-00-000Z_${id}.jsonl`);
	fs.writeFileSync(
		filePath,
		`${[
			JSON.stringify({ type: "session", id, timestamp: "2025-01-01T00:00:00Z", cwd: headerCwd }),
			JSON.stringify({
				type: "message",
				id: "msg-1",
				parentId: null,
				timestamp: "2025-01-01T00:00:01Z",
				message: { role: "user", content: "hello", timestamp: 1 },
			}),
		].join("\n")}\n`,
	);
	return filePath;
}

describe("createSessionManager — --session-profile", () => {
	const originalHome = process.env.HOME;
	const id = "019e84ed-b4cc-7000-9c87-5afe6df992c1";
	let home: string;
	let projectCwd: string;
	let foreignFile: string;

	beforeEach(async () => {
		home = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-home-"));
		process.env.HOME = home;
		projectCwd = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-proj-"));
		// A session that exists only in the "work" profile's session store.
		foreignFile = writeSession(path.join(getProfileSessionsDir("work"), "-project"), id, projectCwd);
	});

	afterEach(async () => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		await fsp.rm(home, { recursive: true, force: true });
		await fsp.rm(projectCwd, { recursive: true, force: true });
	});

	it("resolves and opens a session from the named profile's store", async () => {
		const result = await createSessionManager(
			buildArgs({ resume: id.slice(0, 8), sessionProfile: "work" }),
			projectCwd,
			stubSettings,
		);

		if (!result) throw new Error("Expected resumed session manager");
		try {
			expect(result.getSessionFile()).toBe(foreignFile);
			expect(result.getEntries().length).toBeGreaterThan(0);
		} finally {
			await result.close();
		}
	});

	it("does not find the foreign-profile session without --session-profile", async () => {
		await expect(
			createSessionManager(buildArgs({ resume: id.slice(0, 8) }), projectCwd, stubSettings),
		).rejects.toThrow(/not found/);
	});

	it("rejects --session-profile without a resume/fork target", async () => {
		await expect(
			createSessionManager(buildArgs({ sessionProfile: "work" }), projectCwd, stubSettings),
		).rejects.toThrow(/session-profile/);
	});

	it("rejects --session-profile with a path-based target", async () => {
		await expect(
			createSessionManager(buildArgs({ resume: foreignFile, sessionProfile: "work" }), projectCwd, stubSettings),
		).rejects.toThrow(/not a path/);
	});
});
