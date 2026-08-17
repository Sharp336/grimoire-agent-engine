/**
 * `issue://` / `pr://` protocol handler tests.
 *
 * Every test isolates `OMP_GITHUB_CACHE_DB` to a temp file and resets the
 * cache + router singletons. `git.github.json` / `git.github.text` are spied
 * per-test and restored in `afterEach`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { resetForTests as resetCacheForTests } from "@oh-my-pi/pi-coding-agent/tools/github-cache";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

let tempDir: string;
let originalEnv: string | undefined;

let originalGhToken: string | undefined;
beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-pr-protocol-"));
	originalEnv = process.env.OMP_GITHUB_CACHE_DB;
	process.env.OMP_GITHUB_CACHE_DB = path.join(tempDir, "github-cache.db");
	originalGhToken = process.env.GH_TOKEN;
	process.env.GH_TOKEN = "test-token";
	resetCacheForTests();
	InternalUrlRouter.resetForTests();
});

afterEach(async () => {
	resetCacheForTests();
	InternalUrlRouter.resetForTests();
	if (originalEnv === undefined) {
		delete process.env.OMP_GITHUB_CACHE_DB;
	} else {
		process.env.OMP_GITHUB_CACHE_DB = originalEnv;
	}
	if (originalGhToken === undefined) {
		delete process.env.GH_TOKEN;
	} else {
		process.env.GH_TOKEN = originalGhToken;
	}
	vi.restoreAllMocks();
	await removeWithRetries(tempDir);
});

function issuePayload(number: number, body: string, commentBodies: string[] = []) {
	return {
		number,
		title: `Issue #${number}`,
		state: "OPEN",
		stateReason: null,
		author: { login: "octocat" },
		assignees: [{ login: "maintainer" }, { name: "Release Manager" }],
		body,
		createdAt: "2026-04-01T09:00:00Z",
		updatedAt: "2026-04-01T10:00:00Z",
		url: `https://github.com/owner/example/issues/${number}`,
		labels: [],
		parent: null,
		subIssues: { nodes: [], totalCount: 0 },
		subIssuesSummary: { total: 0, completed: 0, percentCompleted: 0 },
		comments: commentBodies.map((cb, idx) => ({
			author: { login: `user${idx}` },
			body: cb,
			createdAt: "2026-04-01T11:00:00Z",
			url: `https://github.com/owner/example/issues/${number}#issuecomment-${idx + 1}`,
			isMinimized: false,
		})),
	};
}

interface PrPayloadReview {
	author: { login: string };
	body: string;
	commit: { oid: string };
	state: string;
	submittedAt: string;
}

function prPayload(number: number, body: string) {
	const reviews: PrPayloadReview[] = [];
	return {
		number,
		title: `PR #${number}`,
		state: "OPEN",
		isDraft: false,
		baseRefName: "main",
		headRefName: "feature/x",
		author: { login: "octocat" },
		body,
		createdAt: "2026-04-01T09:00:00Z",
		updatedAt: "2026-04-01T10:00:00Z",
		url: `https://github.com/owner/example/pull/${number}`,
		labels: [],
		files: [],
		reviews,
		comments: [],
	};
}

function requestedJsonFields(args: string[]): Set<string> {
	const jsonIndex = args.indexOf("--json");
	const fieldsArg = jsonIndex >= 0 ? args[jsonIndex + 1] : undefined;
	return new Set((fieldsArg ?? "").split(",").filter(Boolean));
}

function prPayloadWithRequestedFields(args: string[], number: number, body: string) {
	const payload = prPayload(number, body);
	const fields = requestedJsonFields(args);
	if (fields.has("reviews")) {
		payload.reviews = [
			{
				author: { login: "approver" },
				body: "Approved from the formal review flow.",
				commit: { oid: "1234567890abcdef1234567890abcdef12345678" },
				state: "APPROVED",
				submittedAt: "2026-04-01T12:00:00Z",
			},
		];
	}
	return payload;
}

interface DiffFileSpec {
	name: string;
	adds?: number;
	dels?: number;
	mode?: "modified" | "added" | "deleted";
	oldName?: string;
	binary?: boolean;
}

function makePrDiff(files: DiffFileSpec[]): string {
	return files
		.map(f => {
			const oldPath = f.oldName ?? f.name;
			const lines: string[] = [`diff --git a/${oldPath} b/${f.name}`];
			if (f.mode === "added") lines.push("new file mode 100644");
			if (f.mode === "deleted") lines.push("deleted file mode 100644");
			if (f.oldName) {
				lines.push(`rename from ${oldPath}`, `rename to ${f.name}`);
			}
			lines.push("index 0000000..1111111 100644");
			lines.push(`--- a/${oldPath}`);
			lines.push(`+++ b/${f.name}`);
			if (f.binary) {
				lines.push(`Binary files a/${oldPath} and b/${f.name} differ`);
			} else {
				lines.push("@@ -1,1 +1,1 @@");
				for (let i = 0; i < (f.dels ?? 0); i += 1) lines.push(`-old line ${i}`);
				for (let i = 0; i < (f.adds ?? 0); i += 1) lines.push(`+new line ${i}`);
			}
			return lines.join("\n");
		})
		.join("\n");
}

describe("issue:// protocol handler", () => {
	it("resolves issue://owner/repo/<n> through the shared cache", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(issuePayload(42, "issue body", ["c1"]) as never);

		const router = InternalUrlRouter.instance();
		const first = await router.resolve("issue://owner/example/42");

		expect(first.contentType).toBe("text/markdown");
		expect(first.url).toBe("issue://owner/example/42");
		expect(first.content).toContain("# Issue #42: Issue #42");
		expect(first.content).toContain("Assignees: @maintainer, Release Manager");
		expect(first.immutable).toBe(true);
		expect(first.notes?.[0]).toBe("Fetched live");
		expect(spy).toHaveBeenCalledTimes(1);

		const second = await router.resolve("issue://owner/example/42");
		expect(second.content).toBe(first.content);
		expect(second.notes?.[0]).toMatch(/^Cached:/);
		// Same key, soft TTL hit — no additional gh invocation.
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("renders hierarchy links and routes GHES follow-up reads to their source host", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue({
			...issuePayload(42, "issue body"),
			url: "https://ghe.example.test/owner/example/issues/42",
			parent: {
				number: 7,
				title: "Parent roadmap",
				state: "OPEN",
				url: "https://ghe.example.test/platform/roadmap/issues/7",
				repository: { nameWithOwner: "ignored/metadata" },
			},
			subIssues: {
				nodes: [
					{
						number: 43,
						title: "Same-repo child",
						state: "CLOSED",
						url: "https://ghe.example.test/owner/example/issues/43",
					},
					{
						number: 9,
						title: "Cross-repo child",
						state: "OPEN",
						url: "https://ghe.example.test/other/widgets/issues/9",
					},
				],
				totalCount: 2,
			},
			subIssuesSummary: { total: 2, completed: 1, percentCompleted: 49.6 },
		} as never);

		const resource = await InternalUrlRouter.instance().resolve("issue://owner/example/42");
		const hierarchyIndex = resource.content.indexOf("## Issue hierarchy");
		const bodyIndex = resource.content.indexOf("## Body");

		expect(hierarchyIndex).toBeGreaterThan(-1);
		expect(bodyIndex).toBeGreaterThan(hierarchyIndex);
		expect(resource.content).toContain("Parent: OPEN platform/roadmap#7 — Parent roadmap");
		expect(resource.content).toContain("issue://platform/roadmap/7?host=ghe.example.test");
		expect(resource.content).toContain("Sub-issues: 1/2 complete (50%)");
		expect(resource.content).toContain("- CLOSED owner/example#43 — Same-repo child");
		expect(resource.content).toMatch(/\n {2,}issue:\/\/owner\/example\/43\?host=ghe\.example\.test/);
		expect(resource.content).toContain("- OPEN other/widgets#9 — Cross-repo child");
		expect(resource.content).toMatch(/\n {2,}issue:\/\/other\/widgets\/9\?host=ghe\.example\.test/);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(requestedJsonFields(spy.mock.calls[0]?.[1] as string[])).toEqual(
			new Set([
				"author",
				"assignees",
				"body",
				"comments",
				"createdAt",
				"labels",
				"number",
				"parent",
				"state",
				"stateReason",
				"subIssues",
				"subIssuesSummary",
				"title",
				"updatedAt",
				"url",
			]),
		);

		const routedChild = "issue://other/widgets/9?host=ghe.example.test";
		const followed = await InternalUrlRouter.instance().resolve(routedChild);
		expect(followed.url).toBe(routedChild);
		expect(spy).toHaveBeenCalledTimes(2);
		expect((spy.mock.calls[1]?.[1] as string[] | undefined)?.slice(0, 5)).toEqual([
			"issue",
			"view",
			"9",
			"--repo",
			"ghe.example.test/other/widgets",
		]);

		// The routed read has its own host-qualified cache key.
		await InternalUrlRouter.instance().resolve(routedChild);
		expect(spy).toHaveBeenCalledTimes(2);
		await InternalUrlRouter.instance().resolve("issue://other/widgets/9");
		expect(spy).toHaveBeenCalledTimes(3);
		expect((spy.mock.calls[2]?.[1] as string[] | undefined)?.slice(0, 5)).toEqual([
			"issue",
			"view",
			"9",
			"--repo",
			"other/widgets",
		]);
	});

	it("omits foreign-host hierarchy links and marks the response partial", async () => {
		vi.spyOn(git.github, "json").mockResolvedValue({
			...issuePayload(44, "foreign hierarchy"),
			subIssues: {
				nodes: [
					{
						number: 45,
						title: "Same-host child",
						state: "OPEN",
						url: "https://github.com/owner/example/issues/45",
					},
					{
						number: 46,
						title: "Foreign-host child",
						state: "OPEN",
						url: "https://ghe.example.test/owner/example/issues/46",
					},
				],
				totalCount: 2,
			},
			subIssuesSummary: { total: 2, completed: 0, percentCompleted: 0 },
		} as never);

		const resource = await InternalUrlRouter.instance().resolve("issue://owner/example/44");

		expect(resource.content).toContain("- OPEN owner/example#45 — Same-host child");
		expect(resource.content).not.toContain("Foreign-host child");
		expect(resource.content).toContain(
			"> WARNING: Issue hierarchy data is partial; only valid visible relationships are shown.",
		);
	});

	it("renders an explicit supported-empty hierarchy result", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(issuePayload(44, "standalone") as never);

		const resource = await InternalUrlRouter.instance().resolve("issue://owner/example/44");

		expect(resource.content).toContain("## Issue hierarchy");
		expect(resource.content).toContain("No visible parent or direct sub-issues for the current GitHub identity.");
		expect(resource.content).not.toContain("Issue hierarchy unavailable");
		expect(resource.content).not.toContain("Issue hierarchy data is partial");
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("retains valid hierarchy links and warns when other relationships are malformed", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue({
			...issuePayload(45, "partial hierarchy"),
			parent: {
				number: 6,
				title: "Malformed parent",
				state: "OPEN",
				url: "https://github.enterprise.test/owner/example/pull/6",
			},
			subIssues: {
				nodes: [
					{
						number: 46,
						title: "Visible child",
						state: "OPEN",
						url: "https://github.com/valid/project/issues/46",
					},
					{
						number: 47,
						title: "Malformed child",
						state: "CLOSED",
						url: "not a canonical issue URL",
					},
				],
				totalCount: 2,
			},
			subIssuesSummary: { total: 2, completed: 1, percentCompleted: 50 },
		} as never);

		const resource = await InternalUrlRouter.instance().resolve("issue://owner/example/45");

		expect(resource.content).toContain("- OPEN valid/project#46 — Visible child");
		expect(resource.content).toContain("issue://valid/project/46");
		expect(resource.content).not.toContain("Malformed parent");
		expect(resource.content).not.toContain("issue://owner/example/6");
		expect(resource.content).not.toContain("Malformed child");
		expect(resource.content).not.toContain("issue://owner/example/47");
		expect(resource.content).toContain(
			"> WARNING: Issue hierarchy data is partial; only valid visible relationships are shown.",
		);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("warns when the direct-child connection is truncated", async () => {
		vi.spyOn(git.github, "json").mockResolvedValue({
			...issuePayload(46, "truncated hierarchy"),
			subIssues: {
				nodes: [
					{
						number: 47,
						title: "Visible child",
						state: "OPEN",
						url: "https://github.com/owner/example/issues/47",
					},
				],
				totalCount: 2,
			},
			subIssuesSummary: { total: 2, completed: 0, percentCompleted: 0 },
		} as never);

		const resource = await InternalUrlRouter.instance().resolve("issue://owner/example/46");

		expect(resource.content).toContain("issue://owner/example/47");
		expect(resource.content).toContain(
			"> WARNING: Issue hierarchy data is partial; only valid visible relationships are shown.",
		);
	});

	it("marks soft-expired issue fallback content as stale when live refresh fails", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(issuePayload(43, "cached body") as never);
		const settings = Settings.isolated({
			"github.cache.softTtlSec": 0,
			"github.cache.hardTtlSec": 86400,
		});

		const router = InternalUrlRouter.instance();
		await router.resolve("issue://owner/example/43");
		await Bun.sleep(1);
		spy.mockImplementation(async () => {
			throw new Error("offline");
		});

		const resource = await router.resolve("issue://owner/example/43", { settings });
		expect(resource.content.startsWith("> WARNING: Live GitHub refresh failed")).toBe(true);
		expect(resource.notes?.[0]).toMatch(/^WARNING: showing cached content/);
		expect(resource.content).toContain("cached body");
		expect(spy).toHaveBeenCalledTimes(2);
	});
	it("explicit fresh issue reads bypass and replace a soft-fresh cache row", async () => {
		const spy = vi
			.spyOn(git.github, "json")
			.mockResolvedValueOnce(issuePayload(43, "cached body") as never)
			.mockResolvedValueOnce(issuePayload(43, "live body") as never);
		const router = InternalUrlRouter.instance();

		const cached = await router.resolve("issue://owner/example/43");
		const live = await router.resolve("issue://owner/example/43?fresh=1");
		const replaced = await router.resolve("issue://owner/example/43");

		expect(cached.content).toContain("cached body");
		expect(live.content).toContain("live body");
		expect(live.notes?.[0]).toBe("Fetched live");
		expect(replaced.content).toContain("live body");
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("explicit fresh issue read failures reject instead of returning stale content", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValueOnce(issuePayload(43, "cached body") as never);
		const router = InternalUrlRouter.instance();
		await router.resolve("issue://owner/example/43");
		spy.mockRejectedValue(new Error("live issue unavailable") as never);

		await expect(router.resolve("issue://owner/example/43?fresh=true")).rejects.toThrow("live issue unavailable");
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("rejects unsupported or repeated fresh values before invoking gh", async () => {
		const spy = vi.spyOn(git.github, "json");
		const router = InternalUrlRouter.instance();

		for (const url of [
			"issue://owner/example/43?fresh=0",
			"issue://owner/example/43?fresh=false",
			"issue://owner/example/43?fresh=TRUE",
			"issue://owner/example/43?fresh=1&fresh=true",
			"pr://owner/example/77?fresh=",
		]) {
			await expect(router.resolve(url)).rejects.toThrow(/Invalid (?:issue|pr):\/\/ fresh value/);
		}
		expect(spy).not.toHaveBeenCalled();
	});

	it("retries issue://owner/repo/<n> without stateReason when gh does not support it", async () => {
		const spy = vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
			if (requestedJsonFields(args).has("stateReason")) {
				throw new Error('Unknown JSON field: "stateReason"');
			}
			return issuePayload(42, "issue body") as never;
		});

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("issue://owner/example/42");

		expect(resource.content).toContain("# Issue #42: Issue #42");
		expect(resource.content).not.toContain("State reason");
		expect(spy).toHaveBeenCalledTimes(2);
		expect(requestedJsonFields(spy.mock.calls[0]?.[1] as string[]).has("stateReason")).toBe(true);
		expect(requestedJsonFields(spy.mock.calls[1]?.[1] as string[]).has("stateReason")).toBe(false);
		for (const hierarchyField of ["parent", "subIssues", "subIssuesSummary"]) {
			expect(requestedJsonFields(spy.mock.calls[0]?.[1] as string[]).has(hierarchyField)).toBe(true);
			expect(requestedJsonFields(spy.mock.calls[1]?.[1] as string[]).has(hierarchyField)).toBe(true);
		}
	});

	it("retries old local gh once without hierarchy fields and renders the CLI version notice", async () => {
		const spy = vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
			const fields = requestedJsonFields(args);
			if (fields.has("parent") || fields.has("subIssues") || fields.has("subIssuesSummary")) {
				throw new Error('Unknown JSON field: "parent"');
			}
			return {
				...issuePayload(48, "old gh"),
				parent: undefined,
				subIssues: undefined,
				subIssuesSummary: undefined,
			} as never;
		});

		const resource = await InternalUrlRouter.instance().resolve("issue://owner/example/48");

		expect(resource.content).toContain("Issue hierarchy unavailable: GitHub CLI 2.94.0 or later is required.");
		expect(resource.content).not.toContain("No visible parent or direct sub-issues for the current GitHub identity.");
		expect(spy).toHaveBeenCalledTimes(2);
		expect(requestedJsonFields(spy.mock.calls[0]?.[1] as string[])).toEqual(
			new Set([
				"author",
				"assignees",
				"body",
				"comments",
				"createdAt",
				"labels",
				"number",
				"parent",
				"state",
				"stateReason",
				"subIssues",
				"subIssuesSummary",
				"title",
				"updatedAt",
				"url",
			]),
		);
		expect(requestedJsonFields(spy.mock.calls[1]?.[1] as string[])).toEqual(
			new Set([
				"author",
				"assignees",
				"body",
				"comments",
				"createdAt",
				"labels",
				"number",
				"state",
				"stateReason",
				"title",
				"updatedAt",
				"url",
			]),
		);
	});

	it("retries a GHES hierarchy schema mismatch once and renders the server notice", async () => {
		const spy = vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
			const fields = requestedJsonFields(args);
			if (fields.has("parent") || fields.has("subIssues") || fields.has("subIssuesSummary")) {
				throw new Error("GraphQL: Field 'subIssues' doesn't exist on type 'Issue'");
			}
			return {
				...issuePayload(49, "old server"),
				parent: undefined,
				subIssues: undefined,
				subIssuesSummary: undefined,
			} as never;
		});

		const resource = await InternalUrlRouter.instance().resolve("issue://owner/example/49");

		expect(resource.content).toContain("Issue hierarchy unavailable on this GitHub server.");
		expect(resource.content).not.toContain("No visible parent or direct sub-issues for the current GitHub identity.");
		expect(spy).toHaveBeenCalledTimes(2);
		for (const hierarchyField of ["parent", "subIssues", "subIssuesSummary"]) {
			expect(requestedJsonFields(spy.mock.calls[0]?.[1] as string[]).has(hierarchyField)).toBe(true);
			expect(requestedJsonFields(spy.mock.calls[1]?.[1] as string[]).has(hierarchyField)).toBe(false);
		}
	});

	it.each([
		["network", new Error("network unreachable")],
		["authentication", new Error("GraphQL: authentication required")],
		["rate limit", new Error("GraphQL: API rate limit exceeded")],
		["hierarchy runtime", new Error("GraphQL: subIssues resolver returned an undefined field value")],
		["abort", new ToolAbortError("cancelled issue request")],
	])("does not retry or misclassify a generic %s failure", async (_kind: string, failure: Error) => {
		const spy = vi.spyOn(git.github, "json").mockRejectedValue(failure as never);

		try {
			await InternalUrlRouter.instance().resolve("issue://owner/example/50");
			expect.unreachable("Expected issue resolution to reject");
		} catch (error: unknown) {
			expect(error).toBeInstanceOf(Error);
			if (!(error instanceof Error)) throw error;
			expect(error.message).toContain(failure.message);
			expect(error.message).not.toContain("GitHub CLI 2.94.0");
			expect(error.message).not.toContain("Issue hierarchy unavailable");
			expect(error.message).not.toContain("No visible parent or direct sub-issues");
		}
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("?comments=0 selects a separate cache row with comments suppressed", async () => {
		const spy = vi
			.spyOn(git.github, "json")
			.mockResolvedValue(issuePayload(9, "body9", ["visible comment"]) as never);

		const router = InternalUrlRouter.instance();
		const withComments = await router.resolve("issue://owner/example/9");
		const without = await router.resolve("issue://owner/example/9?comments=0");

		// Two distinct keys → two underlying fetches.
		expect(spy).toHaveBeenCalledTimes(2);
		expect(withComments.content).toContain("visible comment");
		expect(without.content).not.toContain("visible comment");
		// Note metadata reflects the toggle on the comments-off variant.
		expect(without.notes).toContain("Comments disabled");
		expect(requestedJsonFields(spy.mock.calls[0]?.[1] as string[])).toEqual(
			new Set([
				"author",
				"assignees",
				"body",
				"comments",
				"createdAt",
				"labels",
				"number",
				"parent",
				"state",
				"stateReason",
				"subIssues",
				"subIssuesSummary",
				"title",
				"updatedAt",
				"url",
			]),
		);
		expect(requestedJsonFields(spy.mock.calls[1]?.[1] as string[])).toEqual(
			new Set([
				"author",
				"assignees",
				"body",
				"createdAt",
				"labels",
				"number",
				"parent",
				"state",
				"stateReason",
				"subIssues",
				"subIssuesSummary",
				"title",
				"updatedAt",
				"url",
			]),
		);
	});

	it("rejects invalid issue:// URLs and host selectors with a friendly message", async () => {
		const router = InternalUrlRouter.instance();
		// 4-or-more segments fall through to the catch-all "Invalid …" error.
		await expect(router.resolve("issue://owner/example/foo/bar")).rejects.toThrow(/Invalid issue:\/\/ URL/);
		// Non-numeric single segment fails the number check.
		await expect(router.resolve("issue://abc")).rejects.toThrow(/Invalid issue:\/\/ number/);
		await expect(router.resolve("issue://123?host=ghe.example.test")).rejects.toThrow(
			/Invalid issue:\/\/ host option/,
		);
		await expect(router.resolve("issue://owner/example/123?host=ghe.example.test&host=github.com")).rejects.toThrow(
			/Invalid issue:\/\/ host value/,
		);
		await expect(router.resolve("issue://owner/example/123?host=ghe.example.test%2Fpath")).rejects.toThrow(
			/Invalid issue:\/\/ host value/,
		);
	});
});

describe("pr:// protocol handler", () => {
	it("resolves pr://owner/repo/<n> through the shared cache", async () => {
		const spy = vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
			if (args.includes("/repos/owner/example/pulls/77/comments")) {
				return [] as never;
			}
			return prPayload(77, "pr body") as never;
		});

		const router = InternalUrlRouter.instance();
		const first = await router.resolve("pr://owner/example/77");

		expect(first.contentType).toBe("text/markdown");
		expect(first.content).toContain("# Pull Request #77: PR #77");
		expect(first.immutable).toBe(true);
		expect(first.notes).toContain("Diff: pr://owner/example/77/diff");
		// First call hits gh twice (view JSON + review-comments page).
		expect(spy).toHaveBeenCalledTimes(2);

		const second = await router.resolve("pr://owner/example/77");
		expect(second.content).toBe(first.content);
		expect(second.notes?.[0]).toMatch(/^Cached:/);
		// Second call is a soft-TTL hit — no further gh invocations.
		expect(spy).toHaveBeenCalledTimes(2);
	});

	it("requests and renders formal reviews when comments are enabled", async () => {
		vi.spyOn(git.github, "json").mockImplementation(async (_cwd, args) => {
			if (args.includes("/repos/owner/example/pulls/78/comments")) {
				return [] as never;
			}
			return prPayloadWithRequestedFields(args, 78, "pr body") as never;
		});

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("pr://owner/example/78");

		expect(resource.content).toContain("## Reviews (1)");
		expect(resource.content).toContain("### @approver - 2026-04-01T12:00:00Z [APPROVED]");
		expect(resource.content).toContain("Approved from the formal review flow.");
	});

	it("rejects invalid pr:// URLs and issue-only host selectors with a friendly message", async () => {
		const router = InternalUrlRouter.instance();
		await expect(router.resolve("pr://owner/example/foo/bar")).rejects.toThrow(/Invalid pr:\/\/ URL/);
		await expect(router.resolve("pr://owner/example/abc")).rejects.toThrow(/Invalid pr:\/\/ number/);
		await expect(router.resolve("pr://owner/example/77?host=ghe.example.test")).rejects.toThrow(
			/Invalid pr:\/\/ host option/,
		);
	});

	it("rejects empty / dot / dotdot path segments", async () => {
		const router = InternalUrlRouter.instance();
		await expect(router.resolve("pr://owner//77")).rejects.toThrow(
			/Invalid pr:\/\/ URL: empty or unsafe path segment/,
		);
		await expect(router.resolve("pr://owner/repo/77/diff//2")).rejects.toThrow(
			/Invalid pr:\/\/ URL: empty or unsafe path segment/,
		);
		await expect(router.resolve("pr://owner/../77/diff")).rejects.toThrow(
			/Invalid pr:\/\/ URL: empty or unsafe path segment/,
		);
		await expect(router.resolve("issue://owner/./repo/1")).rejects.toThrow(
			/Invalid issue:\/\/ URL: empty or unsafe path segment/,
		);
	});
	it("explicit fresh PR reads bypass and replace cache rows without stale fallback", async () => {
		const spy = vi
			.spyOn(git.github, "json")
			.mockResolvedValueOnce(prPayload(77, "cached PR body") as never)
			.mockResolvedValueOnce(prPayload(77, "live PR body") as never);
		const router = InternalUrlRouter.instance();

		const cached = await router.resolve("pr://owner/example/77?comments=0");
		const live = await router.resolve("pr://owner/example/77?comments=0&fresh=true");
		const replaced = await router.resolve("pr://owner/example/77?comments=0");

		expect(cached.content).toContain("cached PR body");
		expect(live.content).toContain("live PR body");
		expect(live.notes?.[0]).toBe("Fetched live");
		expect(replaced.content).toContain("live PR body");
		expect(spy).toHaveBeenCalledTimes(2);

		spy.mockRejectedValue(new Error("live PR unavailable") as never);
		await expect(router.resolve("pr://owner/example/77?comments=0&fresh=1")).rejects.toThrow("live PR unavailable");
		expect(spy).toHaveBeenCalledTimes(3);
	});
});

describe("pr://.../diff family", () => {
	const diffText = makePrDiff([
		{ name: "src/one.ts", adds: 3, dels: 1 },
		{ name: "src/two.ts", adds: 2, dels: 0, mode: "added" },
	]);

	it("pr://owner/repo/<n>/diff lists files with per-file hint URLs", async () => {
		const textSpy = vi.spyOn(git.github, "text").mockResolvedValue(diffText);

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("pr://owner/example/77/diff");

		expect(resource.contentType).toBe("text/markdown");
		expect(resource.content).toContain("# Pull Request Diff: owner/example#77 (2 files)");
		expect(resource.content).toContain("1. src/one.ts  +3 -1  [modified]");
		expect(resource.content).toContain("pr://owner/example/77/diff/1");
		expect(resource.content).toContain("2. src/two.ts  +2 -0  [added]");
		expect(resource.content).toContain("pr://owner/example/77/diff/2");
		expect(resource.notes?.[0]).toBe("Fetched live");
		expect(textSpy).toHaveBeenCalledTimes(1);
	});

	it("pr://owner/repo/<n>/diff renders an empty-file body when the PR has no changes", async () => {
		vi.spyOn(git.github, "text").mockResolvedValue("");

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("pr://owner/example/77/diff");
		expect(resource.content).toContain("# Pull Request Diff: owner/example#77 (0 files)");
		expect(resource.content).toContain("_No file changes._");
	});

	it("pr://owner/repo/<n>/diff/all returns the verbatim unified diff as text/plain", async () => {
		vi.spyOn(git.github, "text").mockResolvedValue(diffText);

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("pr://owner/example/77/diff/all");
		expect(resource.contentType).toBe("text/plain");
		expect(resource.content).toBe(diffText);
	});

	it("pr://owner/repo/<n>/diff/<i> slices the i-th file (1-indexed) as text/plain", async () => {
		vi.spyOn(git.github, "text").mockResolvedValue(diffText);

		const router = InternalUrlRouter.instance();
		const first = await router.resolve("pr://owner/example/77/diff/1");
		expect(first.contentType).toBe("text/plain");
		expect(first.content.startsWith("diff --git a/src/one.ts b/src/one.ts")).toBe(true);
		expect(first.content).not.toContain("src/two.ts");
		expect(first.notes).toEqual(
			expect.arrayContaining(["Showing file 1/2: src/one.ts", "Read all: pr://owner/example/77/diff/all"]),
		);

		const second = await router.resolve("pr://owner/example/77/diff/2");
		expect(second.content.startsWith("diff --git a/src/two.ts b/src/two.ts")).toBe(true);
		expect(second.content).not.toContain("src/one.ts");
	});

	it("rejects out-of-range and non-decimal diff indices with friendly errors", async () => {
		vi.spyOn(git.github, "text").mockResolvedValue(diffText);

		const router = InternalUrlRouter.instance();
		await expect(router.resolve("pr://owner/example/77/diff/9")).rejects.toThrow(/out of range/);
		await expect(router.resolve("pr://owner/example/77/diff/foo")).rejects.toThrow(/Invalid pr:\/\/ diff sub-path/);
	});

	it("shares one `gh pr diff` invocation across /diff, /diff/all, and /diff/<i> reads", async () => {
		const textSpy = vi.spyOn(git.github, "text").mockResolvedValue(diffText);

		const router = InternalUrlRouter.instance();
		await router.resolve("pr://owner/example/77/diff");
		await router.resolve("pr://owner/example/77/diff/all");
		await router.resolve("pr://owner/example/77/diff/1");
		// One row services all three variants — `gh pr diff` runs once.
		expect(textSpy).toHaveBeenCalledTimes(1);
	});
});

describe("issue://.../diff rejection", () => {
	it("issue://owner/example/9/diff rejects with 'Invalid issue:// URL'", async () => {
		const router = InternalUrlRouter.instance();
		await expect(router.resolve("issue://owner/example/9/diff")).rejects.toThrow(/Invalid issue:\/\/ URL/);
	});

	it("issue://<N>/diff short form rejects with the same 'no diff' error (not a repo lookup)", async () => {
		// Regression: previously fell through to the `host && parts.length === 1`
		// branch and was misparsed as a repo named `<N>/diff`, producing a
		// confusing GraphQL "Could not resolve to a Repository" error instead.
		const router = InternalUrlRouter.instance();
		await expect(router.resolve("issue://9/diff")).rejects.toThrow(/Issue views do not have a diff/);
		await expect(router.resolve("issue://9/diff/all")).rejects.toThrow(/Issue views do not have a diff/);
		await expect(router.resolve("issue://9/diff/3")).rejects.toThrow(/Issue views do not have a diff/);
	});
});

describe("issue:// / pr:// listing", () => {
	it("issue://owner/repo issues a live `gh issue list` and renders entries", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue([
			{
				number: 1,
				title: "Hello",
				state: "OPEN",
				author: { login: "alice" },
				labels: [{ name: "bug" }],
				createdAt: "2026-04-01T08:00:00Z",
				updatedAt: "2026-04-01T09:00:00Z",
				url: "https://github.com/owner/example/issues/1",
			},
			{
				number: 2,
				title: "Second",
				state: "OPEN",
				author: { login: "bob" },
				labels: [],
				createdAt: "2026-04-02T08:00:00Z",
				updatedAt: "2026-04-02T09:00:00Z",
				url: "https://github.com/owner/example/issues/2",
			},
		] as never);

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("issue://owner/example");

		expect(resource.contentType).toBe("text/markdown");
		expect(resource.content).toContain("# Issues in owner/example");
		expect(resource.content).toContain("#1");
		expect(resource.content).toContain("Hello");
		expect(resource.content).toContain("labels: bug");
		expect(resource.content).toContain("issue://owner/example/1");
		expect(resource.notes?.[0]).toContain("Live listing for owner/example");

		expect(spy).toHaveBeenCalledTimes(1);
		const args = spy.mock.calls[0]?.[1] as string[];
		expect(args[0]).toBe("issue");
		expect(args[1]).toBe("list");
		expect(args).toEqual(expect.arrayContaining(["--repo", "owner/example"]));
		expect(args).toEqual(expect.arrayContaining(["--state", "open"]));
		expect(requestedJsonFields(args).has("stateReason")).toBe(false);
	});

	it("pr://owner/repo passes state and limit query params through to gh", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue([] as never);

		const router = InternalUrlRouter.instance();
		const resource = await router.resolve("pr://owner/example?state=merged&limit=5&author=alice&label=bug");

		expect(resource.content).toContain("# Pull Requests in owner/example (merged, up to 5)");
		expect(resource.content).toContain("_No matches._");

		const args = spy.mock.calls[0]?.[1] as string[];
		expect(args).toEqual(expect.arrayContaining(["--state", "merged"]));
		expect(args).toEqual(expect.arrayContaining(["--limit", "5"]));
		expect(args).toEqual(expect.arrayContaining(["--author", "alice"]));
		expect(args).toEqual(expect.arrayContaining(["--label", "bug"]));
	});

	it("invalid state errors instead of silently falling back to 'open'", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue([] as never);

		const router = InternalUrlRouter.instance();
		await expect(router.resolve("issue://owner/example?state=banana")).rejects.toThrow(
			/Invalid issue:\/\/ list state 'banana'/,
		);
		await expect(router.resolve("pr://owner/example?limit=abc")).rejects.toThrow(/Invalid pr:\/\/ list limit 'abc'/);
		expect(spy).not.toHaveBeenCalled();
	});

	it("treats `diff` as a repository name in repo-scoped listing URLs", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue([] as never);

		const router = InternalUrlRouter.instance();
		await router.resolve("issue://owner/diff");
		await router.resolve("pr://owner/diff");

		const issueArgs = spy.mock.calls[0]?.[1] as string[];
		const prArgs = spy.mock.calls[1]?.[1] as string[];
		expect(issueArgs.slice(0, 2)).toEqual(["issue", "list"]);
		expect(prArgs.slice(0, 2)).toEqual(["pr", "list"]);
		expect(issueArgs).toEqual(expect.arrayContaining(["--repo", "owner/diff"]));
		expect(prArgs).toEqual(expect.arrayContaining(["--repo", "owner/diff"]));
	});

	it("issue:// (no repo, no session) surfaces a friendly resolution error", async () => {
		// resolveDefaultRepoMemoized calls `gh repo view`; intercept it.
		vi.spyOn(git.github, "text").mockRejectedValue(new Error("not a git repository"));
		const router = InternalUrlRouter.instance();
		await expect(router.resolve("issue://")).rejects.toThrow(/could not resolve a default repo/);
	});
});

describe("cross-handler cache sharing", () => {
	it("identical markdown is served whether the protocol handler or a second handler call resolves it", async () => {
		const spy = vi.spyOn(git.github, "json").mockResolvedValue(issuePayload(101, "shared body") as never);

		const router = InternalUrlRouter.instance();
		const r1 = await router.resolve("issue://owner/example/101");
		const r2 = await router.resolve("issue://owner/example/101");
		expect(r2.content).toBe(r1.content);
		expect(spy).toHaveBeenCalledTimes(1);
	});
});
