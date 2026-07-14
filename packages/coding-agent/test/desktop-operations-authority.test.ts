import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SecureFsAdapter } from "@oh-my-pi/pi-coding-agent/session/desktop-operations-authority";
import { CodingAgentDesktopAuthority } from "@oh-my-pi/pi-coding-agent/session/desktop-operations-authority";
import * as piNatives from "@oh-my-pi/pi-natives";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	while (roots.length > 0) await fs.rm(roots.pop()!, { recursive: true, force: true });
});
async function authority(): Promise<{ root: string; value: CodingAgentDesktopAuthority }> {
	const root = await fs.mkdtemp(path.join(process.cwd(), ".desktop-authority-"));
	roots.push(root);
	return {
		root,
		value: new CodingAgentDesktopAuthority({
			sessionManager: { getCwd: () => root, getSessionId: () => "session-test" },
			projectRootForSession: sessionId => {
				if (sessionId !== "session-test") throw new Error("unknown session");
				return root;
			},
		}),
	};
}

describe("CodingAgentDesktopAuthority jailed files", () => {
	test("reads nested utf8 and binary files and lists bounded sorted entries", async () => {
		const { root, value } = await authority();
		await fs.mkdir(path.join(root, "nested"));
		await fs.writeFile(path.join(root, "nested", "hello.txt"), "hello");
		await fs.writeFile(path.join(root, "nested", "bin"), Buffer.from([0, 1, 255]));
		const read = await value.filesRead({ path: "nested/hello.txt" });
		expect(read.content).toBe("hello");
		expect(read.encoding).toBe("utf8");
		expect(read.path).toBe("nested/hello.txt");
		expect(read.revision).toMatch(/^[a-f0-9]{64}$/);
		const binary = await value.filesRead({ path: "nested/bin", encoding: "base64" });
		expect(binary.content).toBe(Buffer.from([0, 1, 255]).toString("base64"));
		const listing = await value.filesList({ path: "nested" });
		expect(listing.entries).toEqual([
			{ path: "nested/bin", kind: "file", size: 3 },
			{ path: "nested/hello.txt", kind: "file", size: 5 },
		]);
	});
	test("omits native entries that cannot cross the app-wire listing protocol", async () => {
		const root = await fs.mkdtemp(path.join(process.cwd(), ".desktop-authority-"));
		roots.push(root);
		const secureFs: SecureFsAdapter = {
			secureReadFile: () => {
				throw new Error("unused");
			},
			secureWriteFileAtomic: () => {
				throw new Error("unused");
			},
			secureListDirectory: () => ({
				entries: [
					{ name: "ok.txt", path: "ok.txt", kind: "file", size: 1 },
					{ name: "~", path: "~", kind: "file", size: 1 },
					{ name: "~name", path: "~name", kind: "file", size: 1 },
					{ name: "bad\nname", path: "bad\nname", kind: "file", size: 1 },
				],
			}),
		};
		const value = new CodingAgentDesktopAuthority({
			sessionManager: { getCwd: () => root, getSessionId: () => "session-test" },
			projectRootForSession: () => root,
			secureFs,
		});
		await expect(value.filesList()).resolves.toEqual({ entries: [{ path: "ok.txt", kind: "file", size: 1 }] });
	});
	test("rejects absolute, drive, traversal, symlink, and root escape paths without exposing paths", async () => {
		const { root, value } = await authority();
		const outside = await fs.mkdtemp(path.join(process.cwd(), ".desktop-outside-"));
		roots.push(outside);
		await fs.writeFile(path.join(outside, "secret"), "secret");
		await fs.symlink(path.join(outside, "secret"), path.join(root, "link"));
		for (const path of ["../secret", "/etc/passwd", "C:/secret", "C:secret", "link"])
			await expect(value.filesRead({ path })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(value.filesRead({ path: "../secret" })).rejects.not.toThrow(root);
		await expect(value.filesRead({ path: "../secret" })).rejects.not.toThrow("secret");
	});
	test("enforces one MiB bounds, create versus overwrite, and file CAS", async () => {
		const { root, value } = await authority();
		const created = await value.filesWrite({ path: "new.txt", content: "one" });
		expect(created.size).toBe(3);
		const revision = String(created.revision);
		const replaced = await value.filesWrite({ path: "new.txt", content: "two", expectedRevision: revision });
		expect(replaced.revision).not.toBe(revision);
		await expect(
			value.filesWrite({ path: "new.txt", content: "bad", expectedRevision: revision }),
		).rejects.toMatchObject({ code: "STALE_REVISION" });
		await expect(value.filesWrite({ path: "large", content: "x".repeat(1024 * 1024 + 1) })).rejects.toMatchObject({
			code: "BOUNDS",
		});
		expect(await fs.readFile(path.join(root, "new.txt"), "utf8")).toBe("two");
	});
	test("allows only one concurrent write for a revision and never partially writes", async () => {
		const { root, value } = await authority();
		const created = await value.filesWrite({ path: "race.txt", content: "base" });
		const revision = String(created.revision);
		const outcomes = await Promise.allSettled([
			value.filesWrite({ path: "race.txt", content: "a", expectedRevision: revision }),
			value.filesWrite({ path: "race.txt", content: "b", expectedRevision: revision }),
		]);
		expect(outcomes.filter(item => item.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter(item => item.status === "rejected")[0]).toMatchObject({
			reason: { code: "STALE_REVISION" },
		});
		expect(["a", "b"]).toContain(await fs.readFile(path.join(root, "race.txt"), "utf8"));
		const before = await value.filesRead({ path: "race.txt" });
		await expect(
			value.filesPatch({ path: "race.txt", patch: "not a patch", expectedRevision: before.revision }),
		).rejects.toMatchObject({ code: "OPERATION_FAILED" });
		expect((await value.filesRead({ path: "race.txt" })).revision).toBe(before.revision);
	});
	test("applies one exact unified patch against a file revision and rejects malformed or multi-file patches", async () => {
		const { root, value } = await authority();
		await fs.writeFile(path.join(root, "patch.txt"), "one\ntwo\n");
		const before = await value.filesRead({ path: "patch.txt" });
		const patch = "*** Begin Patch\n*** Update File: patch.txt\n@@\n-one\n+ONE\n two\n*** End Patch";
		const result = await value.filesPatch({ path: "patch.txt", patch, expectedRevision: before.revision });
		expect(result.path).toBe("patch.txt");
		expect(await fs.readFile(path.join(root, "patch.txt"), "utf8")).toBe("ONE\ntwo\n");
		const after = await value.filesRead({ path: "patch.txt" });
		const multi =
			"*** Begin Patch\n*** Update File: patch.txt\n@@\n-ONE\n+bad\n*** Update File: other.txt\n@@\n-x\n+y\n*** End Patch";
		await expect(
			value.filesPatch({ path: "patch.txt", patch: multi, expectedRevision: after.revision }),
		).rejects.toMatchObject({ code: "UNSUPPORTED" });
		expect((await value.filesRead({ path: "patch.txt" })).revision).toBe(after.revision);
	});
	test("diff requires an explicit comparison, and abort is fail-closed", async () => {
		const { root, value } = await authority();
		await fs.writeFile(path.join(root, "diff.txt"), "old\n");
		await expect(value.filesDiff({ path: "diff.txt" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
		const current = await value.filesRead({ path: "diff.txt" });
		const diff = await value.filesDiff({ path: "diff.txt", content: "new\n", fromRevision: current.revision });
		expect(diff.diff).toContain("-old");
		expect(diff.diff).toContain("+new");
		const controller = new AbortController();
		controller.abort();
		await expect(value.filesRead({ path: "diff.txt", signal: controller.signal })).rejects.toMatchObject({
			code: "ABORTED",
		});
	});
	test("preserves fail-closed settings and review behavior", async () => {
		const { value } = await authority();
		await expect(value.settingsRead()).rejects.toThrow("settings authority unavailable");
		await expect(value.reviewRead({ reviewId: "review-1" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
		await expect(value.reviewApply({ reviewId: "review-1", expectedRevision: "r" })).rejects.toMatchObject({
			code: "UNSUPPORTED",
		});
	});
	test("emits the complete ordered PTY stream in UTF-8-safe 256 KiB frames", async () => {
		const { value } = await authority();
		const maxFrameBytes = 256 * 1024,
			imagePrefix = "\u001b_Gf=100,a=T;",
			boundaryChunk = `${imagePrefix}${"A".repeat(maxFrameBytes - Buffer.byteLength(imagePrefix, "utf8") - 1)}🙂`,
			orderedChunks = [
				boundaryChunk,
				"\u001b\\stdout-before-stderr|",
				`stderr-image:\u001bPq${"β".repeat(maxFrameBytes / 2)}\u001b\\|`,
				"stdout-after-stderr:\u001b]1337;File=name=test:YWJj\u0007",
			],
			expected = orderedChunks.join(""),
			completed = Promise.withResolvers<{ exitCode?: number; cancelled: boolean; timedOut: boolean }>(),
			frames: Array<{ sequence: number; stream: "stdout" | "stderr"; data: string }> = [];
		vi.spyOn(piNatives.PtySession.prototype, "start").mockImplementation((_options, onChunk) => {
			for (const chunk of orderedChunks) onChunk?.(null, chunk);
			return Promise.resolve({ exitCode: 0, cancelled: false, timedOut: false });
		});

		await value.openTerminal({
			shell: "/bin/sh",
			onOutput: (stream, data) => frames.push({ sequence: frames.length + 1, stream, data }),
			onExit: completed.resolve,
		});
		expect(await completed.promise).toEqual({ exitCode: 0, cancelled: false, timedOut: false });
		expect(frames.length).toBeGreaterThan(orderedChunks.length);
		expect(frames.map(frame => frame.sequence)).toEqual(frames.map((_, index) => index + 1));
		expect(frames.every(frame => frame.stream === "stdout")).toBe(true);
		expect(frames.every(frame => Buffer.byteLength(frame.data, "utf8") <= maxFrameBytes)).toBe(true);
		expect(frames.map(frame => frame.data).join("")).toBe(expected);
	});
	test("kills a child and grandchild process group on timeout", async () => {
		if (process.platform === "win32") return;
		const { value } = await authority();
		const result = await value.runBash({
			command: 'sh -c \'trap "" TERM; sleep 30\' & echo $!; trap "" TERM; sleep 30',
			timeout: 30,
		});
		const childPid = Number.parseInt(result.output.trim().split(/\s+/u)[0] ?? "", 10);
		expect(result.timedOut).toBe(true);
		expect(Number.isSafeInteger(childPid)).toBe(true);
		for (let attempt = 0; attempt < 20; attempt++) {
			try {
				process.kill(childPid, 0);
				await Bun.sleep(10);
			} catch {
				break;
			}
		}
		expect(() => process.kill(childPid, 0)).toThrow();
	});
});
