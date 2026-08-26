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
type SearchFn = (text: string, pattern: string, flags?: string) => string[];
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

	it("metadata reports list shape", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const metadata = sandbox.metadata as MetadataFn;
		expect(metadata(["ab", "cde"])).toEqual({
			type: "list",
			items: 2,
			chars: 5,
			approx_tokens: 1, // 5 // 4
		});
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

	it("rlm_query delegates to agent() with the default agent", async () => {
		const { calls, stub } = recordingBridge();
		const sandbox = loadJsPrelude(stub);
		const out = await (sandbox.rlm_query as RlmQueryFn)("solve this");
		expect(out).toBe("reply-1");
		const agentCall = calls.filter(c => c.name === "__agent__");
		expect(agentCall).toHaveLength(1);
		expect(agentCall[0]!.args).toEqual({ prompt: "solve this", agent: "task", handle: false });
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
