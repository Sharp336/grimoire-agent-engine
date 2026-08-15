import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { Shell } from "@oh-my-pi/pi-natives";

afterEach(() => {
	mock.restore();
});

function makeSession(): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		settings: {
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return false;
				if (key === "astGrep.enabled") return false;
				if (key === "astEdit.enabled") return false;
				if (key === "grep.enabled") return false;
				if (key === "glob.enabled") return false;
				return undefined;
			},
			isConfigured() {
				return false;
			},
			getShellConfig() {
				return {
					shell: "/bin/bash",
					args: [],
					env: { PATH: process.env.PATH ?? "", HOME: "/tmp" } as Record<string, string>,
					prefix: undefined,
				};
			},
			getGroup(name: string) {
				if (name === "shellMinimizer") return { enabled: false } as unknown as Record<string, unknown>;
				return undefined as unknown as Record<string, unknown>;
			},
			getBashInterceptorRules() {
				return [];
			},
		},
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

describe("BashTool execution results", () => {
	it("resolves with an error result carrying execution details instead of throwing", async () => {
		const tool = new BashTool(makeSession());
		const result = await tool.execute("call-fail", { command: "exit 3" });

		// A completed command that failed is a non-throwing error result so the
		// renderer keeps the wall time / timeout / exit-code footer.
		expect(result.isError).toBe(true);
		expect(result.details?.exitCode).toBe(3);
		expect(result.details?.timeoutSeconds).toBe(300);
		expect(typeof result.details?.wallTimeMs).toBe("number");

		// The LLM-facing text still states the exit code verbatim.
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("Command exited with code 3");
	});

	it("returns a warning-state timeout result with one timeout notice", async () => {
		// Keep the real native subprocess timeout path, but compress its backend
		// deadline; BashTool must still report the user-facing one-second timeout.
		const realRun = Shell.prototype.run;
		spyOn(Shell.prototype, "run").mockImplementation(function (this: Shell, options, onChunk) {
			return realRun.call(this, { ...options, timeoutMs: 20 }, onChunk);
		});
		const tool = new BashTool(makeSession());
		const result = await tool.execute("call-timeout", { command: "sleep 3", timeout: 1 });

		expect(result.isError).toBe(true);
		expect(result.details?.timedOut).toBe(true);
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text.match(/\[Command timed out after 1 seconds\]/gu)).toHaveLength(1);
	});

	it("preserves the executor cancellation notice without classifying it as a timeout", async () => {
		const dispatched = Promise.withResolvers<void>();
		const realRun = Shell.prototype.run;
		spyOn(Shell.prototype, "run").mockImplementation(function (this: Shell, options, onChunk) {
			dispatched.resolve();
			return realRun.call(this, options, onChunk);
		});
		const tool = new BashTool(makeSession());
		const controller = new AbortController();
		const execution = tool.execute("call-cancel", { command: "sleep 3" }, controller.signal);
		await dispatched.promise;
		controller.abort();

		const error = await execution.catch(error => error);
		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message.match(/\[Command cancelled\]/gu)).toHaveLength(1);
		expect(message).not.toContain("Command aborted");
	});

	it("returns a success result with no exit-code detail for a zero exit", async () => {
		const tool = new BashTool(makeSession());
		const result = await tool.execute("call-ok", { command: "printf hi" });

		expect(result.isError).toBeUndefined();
		expect(result.details?.exitCode).toBeUndefined();
		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("hi");
		expect(text).not.toContain("Command exited with code");
	});

	it("preserves final-stage output when a pipeline ends in head or tail", async () => {
		const tool = new BashTool(makeSession());

		for (const scenario of [
			{ command: "seq 1 5 | head -n2", expected: "1\n2" },
			{ command: "seq 1 5 | tail -n2", expected: "4\n5" },
		]) {
			const result = await tool.execute(`call-pipeline-${scenario.expected[0]}`, { command: scenario.command });
			const text = result.content.find(c => c.type === "text")?.text ?? "";
			const stdout = text.replace(/\n\nWall time: \d+\.\d{2} seconds$/, "").trimEnd();

			expect(result.isError).toBeUndefined();
			expect(stdout).toBe(scenario.expected);
		}
	});
});

describe("BashTool output budgets (findings A/C)", () => {
	function multilineCommand(bytes: number, exitCode: number): string {
		const lines = Math.ceil(bytes / 50);
		const perLine = Math.max(10, Math.floor(bytes / lines));
		const payload = "x".repeat(perLine);
		return `python3 -c "import sys; [sys.stdout.write('${payload}\\n') for _ in range(${lines})]; sys.exit(${exitCode})"`;
	}

	function extractText(result: unknown): string {
		if (!result || typeof result !== "object" || !("content" in result)) return "";
		const content = (result as { content: unknown }).content;
		if (!Array.isArray(content)) return "";
		for (const block of content) {
			if (!block || typeof block !== "object" || !("type" in block) || !("text" in block)) continue;
			const t = (block as { type: unknown }).type;
			const txt = (block as { text: unknown }).text;
			if (t === "text" && typeof txt === "string") return txt;
		}
		return "";
	}

	it("caps zero-exit Bash output to the Bash inline budget (~12KB) via the real tool path", async () => {
		// Use a real Settings isolated with no explicit spill threshold (defaults).
		// The executor sink is sized for the failure budget (20KB) so 18KB is
		// retained there, but the tool layer must final-cap successful results
		// to the smaller inline budget (12KB). Before the fix the shared
		// DEFAULT_MAX_BYTES (12KB) truncated the sink itself, so failure
		// diagnostics were already lost before the tool could decide.
		const settings = Settings.isolated({});
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			skills: [],
			getSessionFile: () => null,
			settings,
			getClientBridge: () => undefined,
			allocateOutputArtifact: async () => ({ path: undefined, id: undefined }),
			getSessionId: () => `test-${Date.now()}`,
		} as unknown as ToolSession;
		const tool = new BashTool(session);

		const targetBytes = 18030;
		const result: unknown = await (
			tool as unknown as { execute: (id: string, params: unknown) => Promise<unknown> }
		).execute("test", {
			command: multilineCommand(targetBytes, 0),
		});
		const text = extractText(result);
		const textBytes = Buffer.byteLength(text, "utf-8");
		// Success must be bounded to the Bash inline budget, not the 20KB failure budget.
		expect(textBytes).toBeLessThan(15 * 1024);
		expect(text.length).toBeLessThan(targetBytes);
		// Truncation is surfaced via an elision marker or artifact reference.
		expect(text.includes("elided") || text.includes("artifact://")).toBe(true);
	});

	it("honours an explicitly configured tools.artifactSpillThreshold and is not clamped by the Bash default", async () => {
		const settings = Settings.isolated({ "tools.artifactSpillThreshold": 100 });
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			skills: [],
			getSessionFile: () => null,
			settings,
			getClientBridge: () => undefined,
			allocateOutputArtifact: async () => ({ path: undefined, id: undefined }),
			getSessionId: () => `test-${Date.now()}`,
		} as unknown as ToolSession;
		const tool = new BashTool(session);

		const targetBytes = 80 * 1024;
		// `execute` params are schema-typed on the real tool; tests pass a literal.
		const runner = tool as unknown as { execute: (id: string, params: unknown) => Promise<unknown> };
		const result: unknown = await runner.execute("test", { command: multilineCommand(targetBytes, 0) });
		const text = extractText(result);
		const textBytes = Buffer.byteLength(text, "utf-8");
		// With 100KB configured, 80KB must be retained inline — not clamped to the Bash 12KB/20KB defaults.
		expect(textBytes).toBeGreaterThan(70 * 1024);
		expect(text).toContain("x".repeat(40));
	});

	it("honours a threshold explicitly configured to the schema default value", async () => {
		// Regression: detecting "configured" by comparing against the schema
		// default silently downgraded an explicit `50` to the Bash 12KB/20KB
		// budgets, because an explicit default-valued setting looked untouched.
		const settings = Settings.isolated({ "tools.artifactSpillThreshold": 50 });
		const session: ToolSession = {
			cwd: "/tmp",
			hasUI: false,
			skills: [],
			getSessionFile: () => null,
			settings,
			getClientBridge: () => undefined,
			allocateOutputArtifact: async () => ({ path: undefined, id: undefined }),
			getSessionId: () => `test-${Date.now()}`,
		} as unknown as ToolSession;
		const tool = new BashTool(session);

		// `execute` params are schema-typed on the real tool; tests pass a literal.
		const runner = tool as unknown as { execute: (id: string, params: unknown) => Promise<unknown> };
		const result: unknown = await runner.execute("test", { command: multilineCommand(40 * 1024, 0) });
		const text = extractText(result);
		// 40KB fits under the configured 50KB, so it must survive intact rather
		// than being trimmed to the 12KB success budget.
		expect(Buffer.byteLength(text, "utf-8")).toBeGreaterThan(30 * 1024);
	});
});
