/**
 * End-to-end exercise of the Rust subprocess runner.
 *
 * Gated by `PI_RUST_INTEGRATION=1` so CI without a real Evcxr interpreter
 * does not fail.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { disposeAllRustKernelSessions, executeRust } from "@oh-my-pi/pi-coding-agent/eval/rs/executor";
import { TempDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

async function checkEvcxr(): Promise<boolean> {
	if (Bun.env.PI_RUST_INTEGRATION !== "1") return false;
	try {
		const help = await $`evcxr --help`.nothrow().quiet();
		if (help.exitCode !== 0) return false;
		const text = help.stdout.toString();
		return text.includes("--disable-readline") && text.includes("--ide-mode");
	} catch {
		return false;
	}
}

const SHOULD_RUN = await checkEvcxr();

describe.skipIf(!SHOULD_RUN)("rust runner subprocess", () => {
	afterEach(async () => {
		await disposeAllRustKernelSessions();
	});

	it("preflight: evcxr CLI protocol matches source-verified expectations", async () => {
		using tempDir = TempDir.createSync("@rust-integration-preflight-");
		const cwd = tempDir.path();

		// 1. evcxr --help exposes expected flags
		const help = await $`evcxr --help`.nothrow().quiet();
		expect(help.exitCode).toBe(0);
		expect(help.stdout.toString()).toContain("--disable-readline");
		expect(help.stdout.toString()).toContain("--ide-mode");

		// 2. Kernel startup emitted expected banner and prompt
		// This implicitly tests start() and its waitForStartupPrompt logic
		const r = await executeRust("1 + 1", { cwd, sessionId: "session-preflight" });
		expect(r.exitCode).toBe(0);
		expect(r.output).toContain("2");
	});

	it("preserves state across cells (happy path)", async () => {
		using tempDir = TempDir.createSync("@rust-integration-");
		const cwd = tempDir.path();

		const r1 = await executeRust("let answer = 41;", { cwd, sessionId: "session-a" });
		expect(r1.exitCode).toBe(0);

		const r2 = await executeRust("answer + 1", { cwd, sessionId: "session-a" });
		expect(r2.exitCode).toBe(0);
		expect(r2.output).toContain("42");
	});

	it("transports multiline rust blocks correctly", async () => {
		using tempDir = TempDir.createSync("@rust-integration-");
		const code = `
			fn compute(x: i32) -> i32 {
				x * 2
			}
			compute(21)
		`;
		const r = await executeRust(code, { cwd: tempDir.path(), sessionId: "session-b" });
		expect(r.exitCode).toBe(0);
		expect(r.output).toContain("42");
	});

	it("rejects literal unicode separators before writing to kernel", async () => {
		using tempDir = TempDir.createSync("@rust-integration-");
		const cwd = tempDir.path();

		const r1 = await executeRust("let test_var = 20;", { cwd, sessionId: "session-c" });
		expect(r1.exitCode).toBe(0);

		await expect(executeRust('let bad = "\u2028";', { cwd, sessionId: "session-c" })).rejects.toThrow(
			/Rust eval cannot transport literal Unicode line\/paragraph separators/,
		);

		// Prove kernel survived
		const r3 = await executeRust("test_var + 22", { cwd, sessionId: "session-c" });
		expect(r3.exitCode).toBe(0);
		expect(r3.output).toContain("42");
	});

	it("strips ANSI escapes from error diagnostic", async () => {
		using tempDir = TempDir.createSync("@rust-integration-");
		const r = await executeRust("let missing_symbol_xyz: i32 = unknown_var;", {
			cwd: tempDir.path(),
			sessionId: "session-d",
		});
		expect(r.exitCode).not.toBe(0);
		expect(r.output).toContain("unknown_var");
		// Check that typical ANSI escape sequences are stripped (e.g. \x1b[)
		expect(r.output).not.toMatch(/\x1b\[/);
	});

	it("returns non-zero for missing symbols", async () => {
		using tempDir = TempDir.createSync("@rust-integration-");
		const r = await executeRust("missing_symbol_xyz + 1", { cwd: tempDir.path(), sessionId: "session-e" });
		expect(r.exitCode).not.toBe(0);
		expect(r.output).toContain("missing_symbol_xyz");
	});

	it("keeps trailing output on high-volume prints", async () => {
		using tempDir = TempDir.createSync("@rust-integration-");
		const code = `
			for i in 0..100 {
				println!("line {}", i);
			}
			"done"
		`;
		const r = await executeRust(code, { cwd: tempDir.path(), sessionId: "session-f" });
		expect(r.exitCode).toBe(0);
		expect(r.output).toContain("line 0");
		expect(r.output).toContain("line 99");
		expect(r.output).toContain("done");
	});

	it("aborts long-running execution and discards state", async () => {
		using tempDir = TempDir.createSync("@rust-integration-");
		const cwd = tempDir.path();

		const r1 = await executeRust("let shared_var = 100;", { cwd, sessionId: "session-g" });
		expect(r1.exitCode).toBe(0);

		const code = `
			std::thread::sleep(std::time::Duration::from_secs(10));
			"woke"
		`;
		const p = executeRust(code, { cwd, sessionId: "session-g", timeoutMs: 100 });

		const r2 = await p;
		expect(r2.cancelled).toBe(true);
		expect(r2.output).toMatch(/eval cell timed out/i);
		expect(r2.output).toMatch(/recreated on the next call/i);

		// Following cell runs on recreated kernel, old state should be gone
		const r3 = await executeRust("20 + 22", { cwd, sessionId: "session-g" });
		expect(r3.exitCode).toBe(0);
		expect(r3.output).toContain("42");

		const r4 = await executeRust("shared_var", { cwd, sessionId: "session-g" });
		expect(r4.exitCode).not.toBe(0);
	});
});
