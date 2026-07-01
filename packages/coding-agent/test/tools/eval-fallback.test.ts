import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as evalIndex from "@oh-my-pi/pi-coding-agent/eval";
import * as pyKernel from "@oh-my-pi/pi-coding-agent/eval/py/kernel";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { resolveEvalBackends } from "@oh-my-pi/pi-coding-agent/tools/eval-backends";

let originalPiPy: string | undefined;
let originalPiJs: string | undefined;
let originalPiRb: string | undefined;
let originalPiJl: string | undefined;
let originalPiRs: string | undefined;

function restoreEnv(name: "PI_PY" | "PI_JS" | "PI_RB" | "PI_JL" | "PI_RS", value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}
function makeSession(settings = Settings.isolated()): ToolSession {
	return {
		cwd: "/tmp/eval-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
	};
}

const mockResult = {
	output: "ok",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	artifactId: undefined,
	totalLines: 1,
	totalBytes: 2,
	outputLines: 1,
	outputBytes: 2,
	displayOutputs: [],
};

describe("EvalTool language dispatch", () => {
	beforeEach(() => {
		originalPiPy = Bun.env.PI_PY;
		originalPiJs = Bun.env.PI_JS;
		originalPiRb = Bun.env.PI_RB;
		originalPiJl = Bun.env.PI_JL;
		originalPiRs = Bun.env.PI_RS;
		delete Bun.env.PI_PY;
		delete Bun.env.PI_JS;
		delete Bun.env.PI_RB;
		delete Bun.env.PI_JL;
		delete Bun.env.PI_RS;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		restoreEnv("PI_PY", originalPiPy);
		restoreEnv("PI_JS", originalPiJs);
		restoreEnv("PI_RB", originalPiRb);
		restoreEnv("PI_JL", originalPiJl);
		restoreEnv("PI_RS", originalPiRs);
	});

	it('dispatches to the JS backend when cell.language === "js"', async () => {
		const jsExecuteSpy = vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(mockResult);
		const pythonExecuteSpy = vi.spyOn(evalIndex.pythonBackend, "execute");

		const tool = new EvalTool(makeSession());
		await tool.execute("call-js", {
			language: "js",
			code: "const x = 1;",
		});

		expect(jsExecuteSpy).toHaveBeenCalledTimes(1);
		expect(pythonExecuteSpy).not.toHaveBeenCalled();
	});

	it('dispatches to the Python backend when cell.language === "py"', async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.pythonBackend, "isAvailable").mockResolvedValue(true);
		const pythonExecuteSpy = vi.spyOn(evalIndex.pythonBackend, "execute").mockResolvedValue(mockResult);
		const jsExecuteSpy = vi.spyOn(evalIndex.jsBackend, "execute");

		const tool = new EvalTool(makeSession());
		await tool.execute("call-py", {
			language: "py",
			code: "print('hi')",
		});

		expect(pythonExecuteSpy).toHaveBeenCalledTimes(1);
		expect(jsExecuteSpy).not.toHaveBeenCalled();
	});

	it("dispatches each call to the backend named by its language", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.pythonBackend, "isAvailable").mockResolvedValue(true);
		const pythonExecuteSpy = vi.spyOn(evalIndex.pythonBackend, "execute").mockResolvedValue(mockResult);
		const jsExecuteSpy = vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(mockResult);

		const tool = new EvalTool(makeSession());
		await tool.execute("call-py", { language: "py", code: "x = 1" });
		await tool.execute("call-js", { language: "js", code: "const y = 2;" });

		expect(pythonExecuteSpy).toHaveBeenCalledTimes(1);
		expect(jsExecuteSpy).toHaveBeenCalledTimes(1);
	});

	it("rejects py cells when eval.py is disabled", async () => {
		const settings = Settings.isolated();
		settings.set("eval.py", false);
		const tool = new EvalTool(makeSession(settings));
		await expect(
			tool.execute("call-py-disabled", {
				language: "py",
				code: "print('hi')",
			}),
		).rejects.toThrow(/eval\.py = false/);
	});

	it("rejects js cells when eval.js is disabled", async () => {
		const settings = Settings.isolated();
		settings.set("eval.js", false);
		const tool = new EvalTool(makeSession(settings));
		await expect(
			tool.execute("call-js-disabled", {
				language: "js",
				code: "const x = 1;",
			}),
		).rejects.toThrow(/eval\.js = false/);
	});

	it("uses settings for eval backends whose env flag is unset", () => {
		Bun.env.PI_PY = "1";
		const settings = Settings.isolated();
		settings.set("eval.py", false);
		settings.set("eval.js", false);

		expect(resolveEvalBackends(makeSession(settings))).toEqual({
			python: true,
			js: false,
			ruby: false,
			julia: false,
			rust: false,
		});
	});

	it("resolves rust backend allowance according to eval.rs and PI_RS", () => {
		const settings = Settings.isolated();
		settings.set("eval.rs", true);
		expect(resolveEvalBackends(makeSession(settings))).toMatchObject({ rust: true });

		Bun.env.PI_RS = "0";
		expect(resolveEvalBackends(makeSession(settings))).toMatchObject({ rust: false });

		settings.set("eval.rs", false);
		Bun.env.PI_RS = "1";
		expect(resolveEvalBackends(makeSession(settings))).toMatchObject({ rust: true });
	});

	it("lets PI_JS disable js execution even when eval.js is enabled", async () => {
		Bun.env.PI_JS = "0";
		const settings = Settings.isolated();
		settings.set("eval.js", true);
		const tool = new EvalTool(makeSession(settings));

		await expect(
			tool.execute("call-js-env-disabled", {
				language: "js",
				code: "const x = 1;",
			}),
		).rejects.toThrow(/PI_JS=0/);
	});

	it("rejects rs cells when eval.rs is disabled", async () => {
		const settings = Settings.isolated();
		settings.set("eval.rs", false);
		const tool = new EvalTool(makeSession(settings));
		await expect(
			tool.execute("call-rs-disabled", {
				language: "rs",
				code: "let x = 1;",
			}),
		).rejects.toThrow(/PI_RS=0 or eval\.rs = false/);
	});

	it('dispatches to the Rust backend when cell.language === "rs"', async () => {
		const settings = Settings.isolated();
		settings.set("eval.rs", true);
		vi.spyOn(evalIndex.rustBackend, "isAvailable").mockResolvedValue(true);
		const rustExecuteSpy = vi.spyOn(evalIndex.rustBackend, "execute").mockResolvedValue({
			...mockResult,
			output: "42\n",
		});

		const tool = new EvalTool(makeSession(settings));
		const result = await tool.execute("call-rs", {
			language: "rs",
			code: "let answer = 42; answer",
		});

		expect(rustExecuteSpy).toHaveBeenCalledTimes(1);
		const text = result.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("\n");
		expect(text).toContain("42");
	});

	it("rejects rs cells when eval.rs is enabled but Evcxr is unavailable", async () => {
		const settings = Settings.isolated();
		settings.set("eval.rs", true);
		settings.set("eval.js", true);
		settings.set("eval.py", true);
		vi.spyOn(evalIndex.rustBackend, "isAvailable").mockResolvedValue(false);

		const tool = new EvalTool(makeSession(settings));
		try {
			await tool.execute("call-rs-unavailable", {
				language: "rs",
				code: "let answer = 42; answer",
			});
			expect.unreachable("should have thrown");
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			expect(message).toContain("install Evcxr");
			expect(message).toContain('"js"');
			expect(message).toContain('"py"');
		}
	});
});
