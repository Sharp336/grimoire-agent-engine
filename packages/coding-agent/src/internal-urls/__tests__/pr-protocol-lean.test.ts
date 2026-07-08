/**
 * Tests for the lean PR rendering path:
 *   - formatPrLean output shape and edge cases
 *   - pr://…?lean=1 URL parsing
 *   - PrProtocolHandler lean mode via mocked getOrFetchPrLean
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as gh from "../../tools/gh";
import { escapeLean, formatPrLean, LEAN_BODY_MAX, type PrLeanInput } from "../../tools/pr-lean-renderer";
import { parseInternalUrl } from "../parse";
import { PrProtocolHandler } from "../issue-pr-protocol";

// ── formatPrLean unit tests ───────────────────────────────────────────────────

describe("formatPrLean", () => {
	const base: PrLeanInput = {
		number: 42,
		title: "Fix the widget",
		state: "open",
		author: { login: "alice" },
		isDraft: false,
		baseRefName: "main",
		headRefName: "alice/fix-widget",
		reviewDecision: "REVIEW_REQUIRED",
		body: "Fixes #7. Small patch.",
		reviews: [],
		files: [
			{ path: "src/widget.ts", additions: 10, deletions: 3, changeType: "MODIFIED" },
			{ path: "tests/widget.test.ts", additions: 20, deletions: 0, changeType: "ADDED" },
		],
	};

	it("starts with pull_request: header", () => {
		const out = formatPrLean(base);
		expect(out).toMatch(/^pull_request:\n/);
	});

	it("emits expected scalar fields", () => {
		const out = formatPrLean(base);
		expect(out).toContain("  number: 42");
		expect(out).toContain("  state: open");
		expect(out).toContain("  author: alice");
		expect(out).toContain("  draft: no");
		expect(out).toContain("  merged: no");
		expect(out).toContain("  base: main");
		expect(out).toContain("  head: alice/fix-widget");
		expect(out).toContain("  review_decision: REVIEW_REQUIRED");
	});

	it("emits review_count and comment_count", () => {
		const out = formatPrLean(base);
		expect(out).toMatch(/\s+review_count: 0/);
		expect(out).toMatch(/\s+comment_count: 0/);
	});

	it("lists files under files: block", () => {
		const out = formatPrLean(base);
		expect(out).toContain("  files:");
		expect(out).toContain("    - path: src/widget.ts");
		expect(out).toContain("      changes: +10 -3 [MODIFIED]");
		expect(out).toContain("    - path: tests/widget.test.ts");
		expect(out).toContain("      changes: +20 -0 [ADDED]");
	});

	it("omits files: block when files array is empty", () => {
		const out = formatPrLean({ ...base, files: [] });
		expect(out).not.toContain("files:");
	});

	it("omits base/head when not present", () => {
		const out = formatPrLean({ ...base, baseRefName: undefined, headRefName: undefined });
		expect(out).not.toContain("  base:");
		expect(out).not.toContain("  head:");
	});

	it("omits review_decision when null/undefined", () => {
		const outNull = formatPrLean({ ...base, reviewDecision: null });
		const outUndef = formatPrLean({ ...base, reviewDecision: undefined });
		expect(outNull).not.toContain("review_decision:");
		expect(outUndef).not.toContain("review_decision:");
	});

	it("marks merged: yes when state is MERGED", () => {
		const out = formatPrLean({ ...base, state: "MERGED" });
		expect(out).toContain("  merged: yes");
	});

	it("marks draft: yes when isDraft is true", () => {
		const out = formatPrLean({ ...base, isDraft: true });
		expect(out).toContain("  draft: yes");
	});

	it("uses login then name then ? for author", () => {
		expect(formatPrLean({ ...base, author: { login: "bob" } })).toContain("  author: bob");
		expect(formatPrLean({ ...base, author: { name: "Carol D" } })).toContain("  author: Carol D");
		expect(formatPrLean({ ...base, author: null })).toContain("  author: ?");
	});

	it("truncates body at LEAN_BODY_MAX and adds a note", () => {
		const longBody = "x".repeat(LEAN_BODY_MAX + 100);
		const out = formatPrLean({ ...base, body: longBody });
		// The escaped body should contain the truncation message.
		expect(out).toContain("(truncated,");
		expect(out).toContain(`${LEAN_BODY_MAX + 100} chars total`);
	});

	it("does not truncate body at exactly LEAN_BODY_MAX", () => {
		const body = "y".repeat(LEAN_BODY_MAX);
		const out = formatPrLean({ ...base, body });
		expect(out).not.toContain("(truncated,");
	});

	it("counts comments + reviewComments in comment_count", () => {
		const out = formatPrLean({
			...base,
			comments: [{}, {}],
			reviewComments: [{}],
		});
		expect(out).toContain("  comment_count: 3");
	});

	it("counts reviews in review_count", () => {
		const out = formatPrLean({
			...base,
			reviews: [{ state: "APPROVED" }, { state: "CHANGES_REQUESTED" }],
		});
		expect(out).toContain("  review_count: 2");
	});
});

// ── escapeLean unit tests ─────────────────────────────────────────────────────

describe("escapeLean", () => {
	it("wraps in double quotes", () => {
		expect(escapeLean("hello")).toBe('"hello"');
	});

	it("escapes newlines as \\n", () => {
		expect(escapeLean("a\nb")).toBe('"a\\nb"');
		expect(escapeLean("a\r\nb")).toBe('"a\\nb"');
		expect(escapeLean("a\rb")).toBe('"a\\nb"');
	});

	it("escapes embedded double quotes", () => {
		expect(escapeLean('say "hi"')).toBe('"say \\"hi\\""');
	});
});

// ── URL parsing tests ─────────────────────────────────────────────────────────

describe("PrProtocolHandler URL lean param parsing", () => {
	const handler = new PrProtocolHandler();

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function mockLean(result: string = "pull_request:\n  number: 42\n") {
		const mockLookup = {
			rendered: result,
			sourceUrl: "https://github.com/owner/repo/pull/42",
			payload: {},
			status: "miss" as const,
			fetchedAt: Date.now(),
		};
		return vi.spyOn(gh, "getOrFetchPrLean").mockResolvedValue(mockLookup);
	}

	function mockFull(result: string = "# Pull Request #42") {
		const mockLookup = {
			rendered: result,
			sourceUrl: "https://github.com/owner/repo/pull/42",
			payload: {},
			status: "miss" as const,
			fetchedAt: Date.now(),
		};
		return vi.spyOn(gh, "getOrFetchPr").mockResolvedValue(mockLookup);
	}

	it("lean=1 triggers getOrFetchPrLean, not getOrFetchPr", async () => {
		const leanSpy = mockLean();
		const fullSpy = mockFull();
		await handler.resolve(parseInternalUrl("pr://owner/repo/42?lean=1"), { cwd: "/tmp" });
		expect(leanSpy).toHaveBeenCalledTimes(1);
		expect(fullSpy).not.toHaveBeenCalled();
	});

	it("lean=true triggers lean path", async () => {
		const leanSpy = mockLean();
		mockFull();
		await handler.resolve(parseInternalUrl("pr://owner/repo/42?lean=true"), { cwd: "/tmp" });
		expect(leanSpy).toHaveBeenCalledTimes(1);
	});

	it("lean without value triggers lean path", async () => {
		const leanSpy = mockLean();
		mockFull();
		// URL search params treat bare ?lean as lean=""
		await handler.resolve(parseInternalUrl("pr://owner/repo/42?lean"), { cwd: "/tmp" });
		expect(leanSpy).toHaveBeenCalledTimes(1);
	});

	it("lean=0 does NOT trigger lean path", async () => {
		mockLean();
		const fullSpy = mockFull();
		await handler.resolve(parseInternalUrl("pr://owner/repo/42?lean=0"), { cwd: "/tmp" });
		expect(fullSpy).toHaveBeenCalledTimes(1);
	});

	it("lean=false does NOT trigger lean path", async () => {
		mockLean();
		const fullSpy = mockFull();
		await handler.resolve(parseInternalUrl("pr://owner/repo/42?lean=false"), { cwd: "/tmp" });
		expect(fullSpy).toHaveBeenCalledTimes(1);
	});

	it("absent lean param does NOT trigger lean path", async () => {
		mockLean();
		const fullSpy = mockFull();
		await handler.resolve(parseInternalUrl("pr://owner/repo/42"), { cwd: "/tmp" });
		expect(fullSpy).toHaveBeenCalledTimes(1);
	});

	it("lean resource has text/plain contentType", async () => {
		mockLean("pull_request:\n  number: 42\n");
		const resource = await handler.resolve(parseInternalUrl("pr://owner/repo/42?lean=1"), { cwd: "/tmp" });
		expect(resource.contentType).toBe("text/plain");
	});

	it("lean resource notes mention lean mode", async () => {
		mockLean();
		const resource = await handler.resolve(parseInternalUrl("pr://owner/repo/42?lean=1"), { cwd: "/tmp" });
		expect(resource.notes?.some(n => n.includes("Lean mode"))).toBe(true);
	});

	it("full resource has text/markdown contentType", async () => {
		mockFull("# Pull Request #42");
		const resource = await handler.resolve(parseInternalUrl("pr://owner/repo/42"), { cwd: "/tmp" });
		expect(resource.contentType).toBe("text/markdown");
	});

	it("lean pass: getOrFetchPrLean called with repo and number", async () => {
		const leanSpy = mockLean();
		await handler.resolve(parseInternalUrl("pr://myorg/myrepo/99?lean=1"), { cwd: "/tmp" });
		expect(leanSpy).toHaveBeenCalledWith(
			expect.objectContaining({ repo: "myorg/myrepo", number: 99 }),
		);
	});

	it("diff URL with lean param still returns diff (lean only applies to single view)", async () => {
		// pr://owner/repo/42/diff should NOT hit lean path
		// It routes to fetchAndRenderPrDiff, not the lean path.
		// We just confirm it doesn't call getOrFetchPrLean.
		const leanSpy = mockLean();
		// We expect a rejection because there's no real gh available in tests.
		// The important invariant: leanSpy is never called.
		await handler.resolve(parseInternalUrl("pr://owner/repo/42/diff?lean=1"), { cwd: "/tmp" }).catch(() => {});
		expect(leanSpy).not.toHaveBeenCalled();
	});
});
