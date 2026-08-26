import { describe, expect, it } from "bun:test";
import * as vm from "node:vm";
import { $which } from "@oh-my-pi/pi-utils";
import { JAVASCRIPT_PRELUDE_SOURCE } from "../../src/eval/js/shared/prelude";
import { PYTHON_PRELUDE } from "../../src/eval/py/prelude";

/**
 * The RLM decomposition helpers (llm_query/llm_query_batched, rlm_query/
 * rlm_query_batched, chunk, search, metadata) live inside the eval preludes and
 * are not directly importable into Bun. We exercise the real shipped source
 * with the two existing prelude-test harnesses:
 *
 *  - JS: execute JAVASCRIPT_PRELUDE_SOURCE verbatim in a throwaway VM context
 *    with only the host bridge (`__omp_call_tool__`) stubbed (mirrors
 *    test/eval/prelude-agent.test.ts), so llm/rlm delegation is asserted via a
 *    spy on the loopback bridge rather than a re-implementation.
 *  - Python: run PYTHON_PRELUDE in a python3 subprocess with the `__omp_display`
 *    stub injected (mirrors test/eval/py/prelude.test.ts).
 */

function loadJsPrelude(callTool: (name: string, args: unknown) => Promise<unknown>): Record<string, unknown> {
	const sandbox: Record<string, unknown> = { __omp_call_tool__: callTool };
	vm.createContext(sandbox);
	vm.runInContext(JAVASCRIPT_PRELUDE_SOURCE, sandbox);
	return sandbox;
}

type ChunkFn = (text: string, opts?: Record<string, unknown>) => string[];
type SearchFn = (
	text: string,
	pattern: string,
	flags?: string | Record<string, unknown>,
	...rest: unknown[]
) => string[];
type MetadataFn = (text: unknown) => Record<string, unknown>;
type LlmQueryFn = (snippet: string, opts?: Record<string, unknown>) => Promise<unknown>;
type RlmQueryFn = (prompt: string, opts?: Record<string, unknown>) => Promise<unknown>;

/** A bridge stub that records calls and answers `__concurrency__` so parallel() fans out immediately. */
function recordingBridge() {
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	let counter = 0;
	const stub = async (name: string, args: unknown) => {
		calls.push({ name, args: (args ?? {}) as Record<string, unknown> });
		if (name === "__concurrency__") return { limit: 0 };
		counter += 1;
		return { text: `reply-${counter}` };
	};
	return { calls, stub };
}

describe("eval JS RLM helpers", () => {
	it("chunk splits by lines and joins with \\n", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const chunk = sandbox.chunk as ChunkFn;
		expect(chunk("a\nb\nc")).toEqual(["a\nb\nc"]); // size defaults to 100 > input
		expect(chunk("a\nb\nc", { size: 2 })).toEqual(["a\nb", "c"]);
		expect(chunk("a\nb\nc", { size: 1 })).toEqual(["a", "b", "c"]);
	});

	it("chunk by lines preserves __splitlines semantics on CRLF, trailing newlines, and uneven sizes", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const chunk = sandbox.chunk as ChunkFn;
		// The incremental line scan must match the previous
		// __splitlines() + slice/join behavior exactly: \r\n|\r|\n are the
		// only boundaries, and a trailing terminator yields no empty last line.
		expect(chunk("a\r\nb\r\nc", { size: 2 })).toEqual(["a\nb", "c"]);
		expect(chunk("a\nb\n", { size: 1 })).toEqual(["a", "b"]); // trailing \n dropped
		expect(chunk("a\r\nb\r\n", { size: 1 })).toEqual(["a", "b"]); // trailing CRLF dropped
		expect(chunk("a\rb\nc", { size: 2 })).toEqual(["a\nb", "c"]); // lone \r boundary
		expect(chunk("\n\n", { size: 1 })).toEqual(["", ""]); // internal blank lines kept
		expect(chunk("a\n\nb", { size: 1 })).toEqual(["a", "", "b"]);
	});

	it("chunk splits 'tokens' mode into character-bounded windows (~4 chars/token)", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const chunk = sandbox.chunk as ChunkFn;
		// size=2 -> maxChars=8; each window is a hard character slice, not a
		// word-boundary split, so it stays bounded regardless of whitespace.
		expect(chunk("a b c d", { by: "tokens", size: 2 })).toEqual(["a b c d"]);
		expect(chunk("a b c d e f g h", { by: "tokens", size: 2 })).toEqual(["a b c d ", "e f g h"]);
	});

	it("chunk 'tokens' mode bounds a single unbroken run with no whitespace", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const chunk = sandbox.chunk as ChunkFn;
		// The exact failure mode this bounds: one giant minified/base64 line
		// that word-splitting would leave as a single unbounded chunk.
		const unbroken = "x".repeat(1000);
		const chunks = chunk(unbroken, { by: "tokens", size: 10 });
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
		expect(chunks.join("")).toBe(unbroken);
	});

	it("chunk 'tokens' mode never splits a surrogate pair", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const chunk = sandbox.chunk as ChunkFn;
		// U+1F600 (😀) is a non-BMP code point encoded as a UTF-16 surrogate
		// pair. Pad so a naive maxChars=8 (size=2) UTF-16-unit slice would land
		// mid-pair; code-point-aware splitting must keep every emoji intact.
		const text = `ab${"\u{1F600}".repeat(6)}cd`;
		const chunks = chunk(text, { by: "tokens", size: 2 });
		expect(chunks.join("")).toBe(text);
		for (const c of chunks)
			expect(c).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
	});

	it("chunk returns [] for empty text and rejects invalid by/size", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const chunk = sandbox.chunk as ChunkFn;
		expect(chunk("")).toEqual([]);
		expect(chunk("", { by: "tokens" })).toEqual([]);
		expect(() => chunk("a\nb", { by: "bogus" })).toThrow();
		expect(() => chunk("a\nb", { size: 0 })).toThrow();
		expect(() => chunk("a\nb", { size: -3 })).toThrow();
	});

	it("search returns L<lineno>: <rstripped line> for matches and [] when none match", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const search = sandbox.search as SearchFn;
		expect(search("foo bar\nbaz\nfoo baz  ", "foo")).toEqual(["L1: foo bar", "L3: foo baz"]);
		expect(search("abc", "zzz")).toEqual([]);
		expect(search("Foo\nfoo", "foo")).toEqual(["L2: foo"]); // case-sensitive by default
		expect(search("Foo\nfoo", "foo", "i")).toEqual(["L1: Foo", "L2: foo"]); // flags honored
	});

	it("search scans lines incrementally with split semantics on CRLF, blank lines, and trailing newlines", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const search = sandbox.search as SearchFn;
		expect(search("", "x")).toEqual([]); // empty payload
		expect(search("no newline", "newline")).toEqual(["L1: no newline"]);
		expect(search("a\r\nb\rc\nd\n", "b")).toEqual(["L2: b"]); // CRLF, lone \r, trailing \n
		expect(search("foo\n\nfoo", "foo")).toEqual(["L1: foo", "L3: foo"]); // blank line keeps numbering
		expect(search("same same\nsame", "same")).toEqual(["L1: same same", "L2: same"]); // one entry per matching line
		expect(search("  pad  \n\t", "pad")).toEqual(["L1:   pad"]); // trailing whitespace trimmed, leading kept
	});

	it("search resets lastIndex per line for stateful g/y flags", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const search = sandbox.search as SearchFn;
		// Without a per-line reset, the stateful pattern resumes after the
		// first match position and misses the match on the next line entirely.
		expect(search("aaa\na", "a", "g")).toEqual(["L1: aaa", "L2: a"]);
		expect(search("aaa\na", "a", "y")).toEqual(["L1: aaa", "L2: a"]);
	});

	it("search caps results at limit and stops scanning once the cap is hit", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const search = sandbox.search as SearchFn;
		// Below the cap the result is identical to the unbounded behavior.
		expect(search("a\nb\nc\nd\ne", "a|c", { limit: 5 })).toEqual(["L1: a", "L3: c"]);
		// Over the cap: first `limit` matches plus a truncation marker; the
		// scan stops the moment the cap is hit, so the result list cannot
		// grow past limit+1 entries no matter how many lines match.
		expect(search("a\nb\nc\nd\ne", "a|c|e", { limit: 2 })).toEqual([
			"L1: a",
			"L3: c",
			"... (truncated, more matches may exist)",
		]);
		// A scan that ends exactly at the cap (no lines left unexamined) is
		// not truncated, so no marker is appended.
		expect(search("a\nb\n", "a|b", { limit: 2 })).toEqual(["L1: a", "L2: b"]);
		expect(search("a\nb", "a|b", { limit: 2 })).toEqual(["L1: a", "L2: b"]);
		// Positional flags still work; limit can ride along positionally too.
		expect(search("Foo\nfoo", "foo", "i", 1)).toEqual(["L1: Foo", "... (truncated, more matches may exist)"]);
		// Invalid limits are rejected like chunk()'s size.
		expect(() => search("a\nb", "a", { limit: 0 })).toThrow();
		expect(() => search("a\nb", "a", { limit: -1 })).toThrow();
		expect(() => search("a\nb", "a", { limit: 1.5 })).toThrow();
		expect(() => search("a\nb", "a", { limit: "5" })).toThrow();
	});

	it("metadata reports str shape", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const metadata = sandbox.metadata as MetadataFn;
		expect(metadata("hi there\nworld")).toEqual({
			type: "str",
			chars: 14,
			lines: 2,
			words: 3,
			approx_tokens: 3, // 14 // 4
		});
	});

	it("metadata sizes iterable and array-like list inputs in one pass", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const metadata = sandbox.metadata as MetadataFn;
		function* gen() {
			yield "ab";
			yield "cde";
		}
		// No Array.from: generators are consumed once (items counted as they
		// stream) and array-likes are indexed by numeric length — both must
		// report the same shape as a plain array.
		expect(metadata(["ab", "cde"])).toEqual({ type: "list", items: 2, chars: 5, approx_tokens: 1 });
		expect(metadata(gen())).toEqual({ type: "list", items: 2, chars: 5, approx_tokens: 1 });
		expect(metadata({ length: 2, 0: "ab", 1: "cde" })).toEqual({ type: "list", items: 2, chars: 5, approx_tokens: 1 });
		expect(metadata([])).toEqual({ type: "list", items: 0, chars: 0, approx_tokens: 0 });
	});

	it("llm_query delegates to completion, prefixing instructions when given", async () => {
		const { calls, stub } = recordingBridge();
		const sandbox = loadJsPrelude(stub);
		const out = await (sandbox.llm_query as LlmQueryFn)("the code", { instructions: "explain this" });
		expect(out).toBe("reply-1");
		const completion = calls.filter(c => c.name === "__completion__");
		expect(completion).toHaveLength(1);
		expect(completion[0]!.args).toEqual({ prompt: "explain this\n\nthe code", model: "default" });
	});

	it("llm_query sends bare snippet when instructions are omitted", async () => {
		const { calls, stub } = recordingBridge();
		const sandbox = loadJsPrelude(stub);
		await (sandbox.llm_query as LlmQueryFn)("just code");
		expect(calls.filter(c => c.name === "__completion__")[0]!.args).toEqual({
			prompt: "just code",
			model: "default",
		});
	});

	it("llm_query_batched fans out through parallel and preserves order", async () => {
		const { calls, stub } = recordingBridge();
		const sandbox = loadJsPrelude(stub);
		const out = await (sandbox.llm_query_batched as (p: string[], o?: Record<string, unknown>) => Promise<unknown[]>)(
			["a", "b"],
			{ model: "smol" },
		);
		expect(out).toEqual(["reply-1", "reply-2"]);
		const completions = calls.filter(c => c.name === "__completion__");
		expect(completions.map(c => c.args.prompt)).toEqual(["a", "b"]);
		for (const c of completions) expect(c.args.model).toBe("smol");
	});

	it("rlm_query delegates to agent() with no agent field, resolving the session's spawn-policy default", async () => {
		const { calls, stub } = recordingBridge();
		const sandbox = loadJsPrelude(stub);
		const out = await (sandbox.rlm_query as RlmQueryFn)("solve this");
		expect(out).toBe("reply-1");
		const agentCall = calls.filter(c => c.name === "__agent__");
		expect(agentCall).toHaveLength(1);
		expect(agentCall[0]!.args).toEqual({ prompt: "solve this", handle: false });
	});

	it("rlm_query forwards an explicit agent override", async () => {
		const { calls, stub } = recordingBridge();
		const sandbox = loadJsPrelude(stub);
		await (sandbox.rlm_query as RlmQueryFn)("solve this", { agent: "scout" });
		const agentCall = calls.filter(c => c.name === "__agent__");
		expect(agentCall[0]!.args).toEqual({ prompt: "solve this", agent: "scout", handle: false });
	});

	it("rlm_query_batched fans out through parallel and preserves order", async () => {
		const { calls, stub } = recordingBridge();
		const sandbox = loadJsPrelude(stub);
		const out = await (sandbox.rlm_query_batched as (p: string[], o?: Record<string, unknown>) => Promise<unknown[]>)(
			["q1", "q2"],
			{ agent: "scout" },
		);
		expect(out).toEqual(["reply-1", "reply-2"]);
		const agentCalls = calls.filter(c => c.name === "__agent__");
		expect(agentCalls.map(c => c.args.prompt)).toEqual(["q1", "q2"]);
		for (const c of agentCalls) expect(c.args.agent).toBe("scout");
	});
});

describe("eval Python RLM helpers", () => {
	const pythonPath = Bun.env.PYTHON ?? ($which("python3") ? "python3" : "python");

	async function run(code: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const prelude = PYTHON_PRELUDE.replace(
			"from __future__ import annotations",
			"from __future__ import annotations\n__omp_display = lambda *args, **kwargs: None",
		);
		const proc = Bun.spawn([pythonPath, "-c", `${prelude}\n${code}`], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env },
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout: stdout.replaceAll("\r\n", "\n"), stderr: stderr.replaceAll("\r\n", "\n"), exitCode };
	}

	it("chunk splits by lines and tokens with the documented boundaries", async () => {
		const r = await run(`
import json
print(json.dumps(chunk("a\\nb\\nc")))
print(json.dumps(chunk("a\\nb\\nc", size=2)))
print(json.dumps(chunk("a b c d", by="tokens", size=2)))
print(json.dumps(chunk("")))
print(json.dumps(chunk("", by="tokens")))
`);
		expect(r.exitCode).toBe(0);
		const lines = r.stdout.trim().split("\n");
		expect(JSON.parse(lines[0]!)).toEqual(["a\nb\nc"]);
		expect(JSON.parse(lines[1]!)).toEqual(["a\nb", "c"]);
		// "a b c d" is 7 chars; size=2 -> max_chars=8, so it fits one window.
		expect(JSON.parse(lines[2]!)).toEqual(["a b c d"]);
		expect(JSON.parse(lines[3]!)).toEqual([]);
		expect(JSON.parse(lines[4]!)).toEqual([]);
	});

	it("chunk by lines preserves splitlines semantics on CRLF, Unicode separators, and uneven sizes", async () => {
		const r = await run(`
import json
print(json.dumps(chunk("a\\r\\nb\\r\\nc", size=2)))
print(json.dumps(chunk("a\\nb\\n", size=1)))
print(json.dumps(chunk("\\n\\n", size=1)))
print(json.dumps(chunk("a\\n\\nb", size=1)))
print(json.dumps(chunk("a\\u2028b\\u2029c", size=2)))
print(json.dumps(chunk("a\\v\\fb\\x85c", size=2)))
`);
		expect(r.exitCode).toBe(0);
		const lines = r.stdout.trim().split("\n");
		expect(JSON.parse(lines[0]!)).toEqual(["a\nb", "c"]);
		expect(JSON.parse(lines[1]!)).toEqual(["a", "b"]);
		expect(JSON.parse(lines[2]!)).toEqual(["", ""]);
		expect(JSON.parse(lines[3]!)).toEqual(["a", "", "b"]);
		expect(JSON.parse(lines[4]!)).toEqual(["a\nb", "c"]);
		expect(JSON.parse(lines[5]!)).toEqual(["a\n", "b\nc"]); // \v and \f are adjacent boundaries -> blank line
	});

	it("chunk 'tokens' mode bounds a single unbroken run with no whitespace", async () => {
		const r = await run(`
import json
print(json.dumps(chunk("x" * 1000, by="tokens", size=10)))
`);
		expect(r.exitCode).toBe(0);
		const chunks = JSON.parse(r.stdout.trim().split("\n")[0]!) as string[];
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
		expect(chunks.join("")).toBe("x".repeat(1000));
	});

	it("chunk rejects invalid by and non-positive size", async () => {
		const badBy = await run(`chunk("a\\nb", by="bogus")`);
		expect(badBy.exitCode).not.toBe(0);
		expect(badBy.stderr).toContain("ValueError");

		const badSize = await run(`chunk("a\\nb", size=0)`);
		expect(badSize.exitCode).not.toBe(0);
		expect(badSize.stderr).toContain("ValueError");
	});

	it("search returns 1-indexed L<lineno>: <rstripped line> matches and [] otherwise", async () => {
		const r = await run(`
import json
print(json.dumps(search("foo bar\\nbaz\\nfoo baz  ", "foo")))
print(json.dumps(search("abc", "zzz")))
print(json.dumps(search("Foo\\nfoo", "foo", re.IGNORECASE)))
`);
		expect(r.exitCode).toBe(0);
		const lines = r.stdout.trim().split("\n");
		expect(JSON.parse(lines[0]!)).toEqual(["L1: foo bar", "L3: foo baz"]);
		expect(JSON.parse(lines[1]!)).toEqual([]);
		expect(JSON.parse(lines[2]!)).toEqual(["L1: Foo", "L2: foo"]);
	});

	it("search scans lines lazily with splitlines semantics on CRLF, Unicode separators, and blank lines", async () => {
		const r = await run(`
import json
print(json.dumps(search("", "x")))
print(json.dumps(search("no newline", "newline")))
print(json.dumps(search("a\\r\\nb\\rc\\nd\\n", "b")))
print(json.dumps(search("foo\\n\\nfoo", "foo")))
print(json.dumps(search("same same\\nsame", "same")))
print(json.dumps(search("a\\u2028b\\u2029c", "b")))
print(json.dumps(search("a\\v\\fb\\x85c", "b")))
print(json.dumps(search("  pad  \\n\\t", "pad")))
`);
		expect(r.exitCode).toBe(0);
		const lines = r.stdout.trim().split("\n");
		expect(JSON.parse(lines[0]!)).toEqual([]); // empty payload
		expect(JSON.parse(lines[1]!)).toEqual(["L1: no newline"]);
		expect(JSON.parse(lines[2]!)).toEqual(["L2: b"]); // CRLF, lone \r, trailing \n
		expect(JSON.parse(lines[3]!)).toEqual(["L1: foo", "L3: foo"]); // blank line keeps numbering
		expect(JSON.parse(lines[4]!)).toEqual(["L1: same same", "L2: same"]); // one entry per matching line
		expect(JSON.parse(lines[5]!)).toEqual(["L2: b"]); // \u2028/\u2029 separators
		expect(JSON.parse(lines[6]!)).toEqual(["L3: b"]); // \v and \f are adjacent -> blank line, b on L3
		expect(JSON.parse(lines[7]!)).toEqual(["L1:   pad"]); // trailing whitespace stripped, leading kept
	});

	it("search caps results at limit and stops scanning once the cap is hit", async () => {
		const r = await run(`
import json
print(json.dumps(search("a\\nb\\nc\\nd\\ne", "a|c", limit=5)))
print(json.dumps(search("a\\nb\\nc\\nd\\ne", "a|c|e", limit=2)))
print(json.dumps(search("a\\nb\\n", "a|b", limit=2)))
print(json.dumps(search("a\\nb", "a|b", limit=2)))
print(json.dumps(search("Foo\\nfoo", "foo", re.IGNORECASE, limit=1)))
`);
		expect(r.exitCode).toBe(0);
		const lines = r.stdout.trim().split("\n");
		// Below the cap the result is identical to the unbounded behavior.
		expect(JSON.parse(lines[0]!)).toEqual(["L1: a", "L3: c"]);
		// Over the cap: first `limit` matches plus a truncation marker; the
		// scan stops the moment the cap is hit, so the result list cannot
		// grow past limit+1 entries no matter how many lines match.
		expect(JSON.parse(lines[1]!)).toEqual(["L1: a", "L3: c", "... (truncated, more matches may exist)"]);
		// A scan that ends exactly at the cap (no lines left unexamined) is
		// not truncated, so no marker is appended.
		expect(JSON.parse(lines[2]!)).toEqual(["L1: a", "L2: b"]);
		expect(JSON.parse(lines[3]!)).toEqual(["L1: a", "L2: b"]);
		// flags stays positional; limit is a keyword-only kwarg.
		expect(JSON.parse(lines[4]!)).toEqual(["L1: Foo", "... (truncated, more matches may exist)"]);
	});

	it("search rejects non-positive limits", async () => {
		const bad = await run(`search("a\\nb", "a", limit=0)`);
		expect(bad.exitCode).not.toBe(0);
		expect(bad.stderr).toContain("ValueError");
	});

	it("metadata reports str and list shapes", async () => {
		const r = await run(`
import json
print(json.dumps(metadata("hi there\\nworld")))
print(json.dumps(metadata(["ab", "cde"])))
`);
		expect(r.exitCode).toBe(0);
		const lines = r.stdout.trim().split("\n");
		expect(JSON.parse(lines[0]!)).toEqual({
			type: "str",
			chars: 14,
			lines: 2,
			words: 3,
			approx_tokens: 3,
		});
		expect(JSON.parse(lines[1]!)).toEqual({
			type: "list",
			items: 2,
			chars: 5,
			approx_tokens: 1,
		});
	});
});
