import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { runCli } from "@oh-my-pi/pi-coding-agent/cli";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	applyCostGate,
	CostCapExceededError,
	createCostGateController,
	evaluateCostGate,
	resolveCostGate,
} from "@oh-my-pi/pi-coding-agent/session/cost-gate";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("evaluateCostGate", () => {
	it("is ok when no thresholds are set", () => {
		expect(evaluateCostGate(createCostGateController({}), 999)).toBe("ok");
	});

	it("is ok below both thresholds", () => {
		const gate = createCostGateController({ warnCost: 8, maxCost: 10 });
		expect(evaluateCostGate(gate, 5)).toBe("ok");
	});

	it("warns once at warnCost and stays ok afterwards", () => {
		const gate = createCostGateController({ warnCost: 8, maxCost: 10 });
		expect(evaluateCostGate(gate, 8)).toBe("warn");
		expect(evaluateCostGate(gate, 9)).toBe("ok");
	});

	it("caps at maxCost regardless of prior warning", () => {
		const gate = createCostGateController({ warnCost: 8, maxCost: 10 });
		expect(evaluateCostGate(gate, 10)).toBe("cap");
		expect(evaluateCostGate(gate, 10)).toBe("cap");
	});
});

describe("applyCostGate", () => {
	it("dispatches below thresholds", () => {
		const gate = createCostGateController({ maxCost: 10 });
		const dispatch = () => "sent";
		expect(
			applyCostGate(
				gate,
				() => 1,
				() => {},
				dispatch,
			),
		).toBe("sent");
	});

	it("throws CostCapExceededError at maxCost without dispatching", () => {
		const gate = createCostGateController({ maxCost: 10 });
		const dispatched = { called: false };
		expect(() =>
			applyCostGate(
				gate,
				() => 10,
				() => {},
				() => {
					dispatched.called = true;
				},
			),
		).toThrow(CostCapExceededError);
		expect(dispatched.called).toBe(false);
	});

	it("invokes onWarn once at warnCost", () => {
		const gate = createCostGateController({ warnCost: 8 });
		const warned: string[] = [];
		applyCostGate(
			gate,
			() => 8,
			m => warned.push(m),
			() => "sent",
		);
		applyCostGate(
			gate,
			() => 9,
			m => warned.push(m),
			() => "sent",
		);
		expect(warned).toHaveLength(1);
		expect(warned[0]).toContain("$8.00");
	});

	it("binds the cost getter on first use", () => {
		const gate = createCostGateController({ maxCost: 10 });
		applyCostGate(
			gate,
			() => 3,
			() => {},
			() => {},
		);
		expect(gate.getCost?.()).toBe(3);
	});
});

describe("resolveCostGate", () => {
	it("returns undefined when neither flags nor config are set", () => {
		expect(resolveCostGate({}, {})).toBeUndefined();
	});

	it("prefers flags over configured values", () => {
		const gate = resolveCostGate({ warnCost: 8, maxCost: 10 }, { warnCost: 1, maxCost: 2 });
		expect(gate?.warnCost).toBe(8);
		expect(gate?.maxCost).toBe(10);
	});

	it("falls back to configured values", () => {
		const gate = resolveCostGate({}, { warnCost: 8, maxCost: 10 });
		expect(gate?.warnCost).toBe(8);
		expect(gate?.maxCost).toBe(10);
		expect(gate?.warned).toBe(false);
	});
});

describe("session cost settings (issue #7802)", () => {
	it("defaults warnCost and maxCost to undefined", () => {
		const settings = Settings.isolated();
		expect(settings.get("session.warnCost")).toBeUndefined();
		expect(settings.get("session.maxCost")).toBeUndefined();
	});

	it("honors explicit overrides", () => {
		const settings = Settings.isolated({ "session.warnCost": 8, "session.maxCost": 10 });
		expect(settings.get("session.warnCost")).toBe(8);
		expect(settings.get("session.maxCost")).toBe(10);
	});
});

describe("--warn-cost / --max-cost parsing (issue #7802)", () => {
	it("parses valid numbers", () => {
		const parsed = parseArgs(["--warn-cost", "8", "--max-cost", "10", "--print", "hello"]);
		expect(parsed.warnCost).toBe(8);
		expect(parsed.maxCost).toBe(10);
		expect(parsed.print).toBe(true);
	});

	it("throws a visible parse error for invalid values", () => {
		for (const value of ["-1", "Infinity", "NaN", "abc"]) {
			let thrown: unknown;
			try {
				parseArgs(["--max-cost", value]);
			} catch (error) {
				thrown = error;
			}
			if (!(thrown instanceof Error)) {
				throw new Error(`--max-cost ${value} did not throw a visible parse error`);
			}
			expect(thrown.message).toContain("--max-cost");
		}
	});

	it("reports invalid values as CLI usage errors", async () => {
		const previousExitCode = process.exitCode;
		let observedExitCode: string | number | null | undefined;
		const captured: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
			captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});

		try {
			await runCli(["--warn-cost", "abc", "--print", "hello"]);
			observedExitCode = process.exitCode;
		} finally {
			vi.restoreAllMocks();
			process.exitCode = previousExitCode ?? 0;
		}

		const stderr = captured.join("");
		expect(observedExitCode).toBe(2);
		expect(stderr).toContain("Invalid --warn-cost value");
		expect(stderr).toContain("Run `omp --help` for available flags.");
	});
});

describe("cost gate wiring in runRootCommand (issue #7802)", () => {
	it("passes flag-derived costGate into createAgentSession options", async () => {
		using tempDir = TempDir.createSync("@omp-cost-gate-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
		let observedOptions: CreateAgentSessionOptions | undefined;
		const parsed = parseArgs(["--warn-cost", "8", "--max-cost", "10", "--print", "hello"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.path();

		try {
			await runRootCommand(parsed, ["--warn-cost", "8", "--max-cost", "10", "--print", "hello"], {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					observedOptions = options;
					throw new Error("stop after session options");
				},
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "stop after session options") {
				throw error;
			}
		} finally {
			authStorage.close();
		}

		expect(observedOptions?.costGate?.warnCost).toBe(8);
		expect(observedOptions?.costGate?.maxCost).toBe(10);
	});

	it("falls back to session settings when flags are absent", async () => {
		using tempDir = TempDir.createSync("@omp-cost-gate-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const settings = Settings.isolated({
			"marketplace.autoUpdate": "off",
			"session.warnCost": 8,
			"session.maxCost": 10,
		});
		let observedOptions: CreateAgentSessionOptions | undefined;
		const parsed = parseArgs(["--print", "hello"]);
		parsed.noExtensions = true;
		parsed.noSkills = true;
		parsed.noRules = true;
		parsed.noTools = true;
		parsed.noLsp = true;
		parsed.sessionDir = tempDir.path();

		try {
			await runRootCommand(parsed, ["--print", "hello"], {
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					observedOptions = options;
					throw new Error("stop after session options");
				},
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "stop after session options") {
				throw error;
			}
		} finally {
			authStorage.close();
		}

		expect(observedOptions?.costGate?.warnCost).toBe(8);
		expect(observedOptions?.costGate?.maxCost).toBe(10);
	});
});
