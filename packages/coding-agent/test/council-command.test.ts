import { describe, expect, it, mock } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CouncilCoordinator, CouncilRunOptions } from "@oh-my-pi/pi-coding-agent/council/coordinator";
import type { CouncilManifest } from "@oh-my-pi/pi-coding-agent/council/state";
import {
	ACP_BUILTIN_RESERVED_NAMES,
	ACP_BUILTIN_SLASH_COMMANDS,
} from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { BUILTIN_SLASH_COMMAND_DEFS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import {
	councilMoveBlockMessage,
	handleCouncilCommand,
	parseCouncilCommandArgs,
} from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/council";
import { COUNCIL_GRAMMAR, COUNCIL_USAGE } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/council-grammar";
import type { ParsedSlashCommand, SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function manifest(overrides: Partial<CouncilManifest> = {}): CouncilManifest {
	return {
		runId: "run-123",
		state: "reviewing",
		outputPath: "council-run-123-plan.md",
		warnings: [],
		config: { members: [], rounds: 2 },
		rounds: [
			{
				round: 2,
				members: [{ status: "succeeded" }, { status: "running" }, { status: "failed" }],
			},
		],
		...overrides,
	} as CouncilManifest;
}

/**
 * Run-snapshot lines only. Start and resume also emit transient pre-flight and kickoff lines, so
 * index-based assertions on `output` would pin someone else's contract.
 */
function snapshots(output: readonly string[]): string[] {
	return output.filter(text => text.startsWith("Council run-123 "));
}

function command(args: string): ParsedSlashCommand {
	return { name: "council", args, text: `/council${args ? ` ${args}` : ""}` };
}

function harness(coordinator: Partial<CouncilCoordinator>) {
	const settings = Settings.isolated();
	const output: string[] = [];
	const held: Promise<void>[] = [];
	const openCouncilConfig = mock(() => undefined);
	const runtime = {
		session: {
			getToolSession: () => ({ id: "tool-session" }),
			modelRegistry: { id: "registry" },
		},
		sessionManager: { getCwd: () => "/repo", getSessionId: () => "session-test" },
		settings,
		cwd: "/repo",
		output: (text: string) => {
			output.push(text);
		},
		refreshCommands: () => undefined,
		reloadPlugins: async () => undefined,
		holdTurn: (task: Promise<void>) => {
			held.push(task);
		},
		openCouncilConfig,
	} as unknown as SlashCommandRuntime;
	return {
		output,
		held,
		openCouncilConfig,
		runtime,
		dependencies: { getCoordinator: () => coordinator as CouncilCoordinator },
	};
}

describe("council builtin metadata", () => {
	it("reserves and advertises exactly one council builtin", () => {
		const definitions = BUILTIN_SLASH_COMMAND_DEFS.filter(item => item.name === "council");
		expect(definitions).toHaveLength(1);
		expect(definitions[0]).toMatchObject({
			description: "Run a multi-model planning council (spends on every configured council role)",
			allowArgs: true,
			inlineHint: COUNCIL_GRAMMAR,
			subcommands: [
				{ name: "status" },
				{ name: "cancel" },
				{ name: "resume", usage: "[run-id]" },
				{ name: "config" },
			],
		});
		expect(ACP_BUILTIN_RESERVED_NAMES.has("council")).toBe(true);
		expect(ACP_BUILTIN_SLASH_COMMANDS.filter(item => item.name === "council")).toEqual([
			expect.objectContaining({
				name: "council",
				description: "Run a multi-model planning council (spends on every configured council role)",
			}),
		]);
	});

	it("derives every published copy of the grammar from one constant", () => {
		const definition = BUILTIN_SLASH_COMMAND_DEFS.find(item => item.name === "council");
		const acp = ACP_BUILTIN_SLASH_COMMANDS.find(item => item.name === "council");
		expect(COUNCIL_USAGE.split("\n")[0]).toBe(`Usage: /council [--] ${COUNCIL_GRAMMAR}`);
		expect(definition?.inlineHint).toBe(COUNCIL_GRAMMAR);
		expect(acp?.input?.hint).toBe(COUNCIL_GRAMMAR);
		expect(COUNCIL_USAGE.split("\n")[1]).toContain("resume");
		expect(COUNCIL_USAGE.split("\n")[1]).toContain("/council config");
	});

	it("blocks moving while a council is nonterminal and permits terminal snapshots", () => {
		expect(councilMoveBlockMessage({ snapshot: manifest({ state: "planning" }) } as CouncilCoordinator)).toBe(
			"Cannot move while council run run-123 is drafting the plan; use /council cancel first.",
		);
		expect(
			councilMoveBlockMessage({ snapshot: manifest({ state: "completed" }) } as CouncilCoordinator),
		).toBeUndefined();
		expect(councilMoveBlockMessage({ snapshot: undefined } as CouncilCoordinator)).toBeUndefined();
	});
});

describe("council argument parsing", () => {
	it("recognizes leading subcommand tokens case-insensitively", () => {
		expect(parseCouncilCommandArgs("status")).toEqual({ kind: "status" });
		expect(parseCouncilCommandArgs("Status")).toEqual({ kind: "status" });
		expect(parseCouncilCommandArgs("STATUS")).toEqual({ kind: "status" });
		expect(parseCouncilCommandArgs("Resume run-1")).toEqual({ kind: "resume", runId: "run-1" });
		expect(parseCouncilCommandArgs("resume run-1")).toEqual({ kind: "resume", runId: "run-1" });
		expect(parseCouncilCommandArgs("status-report exactly")).toEqual({
			kind: "task",
			task: "status-report exactly",
		});
	});

	it("refuses subcommand arguments and always points at the -- escape", () => {
		for (const [args, message] of [
			["status report exactly", "Usage: /council status"],
			["status of the auth migration", "Usage: /council status"],
			["Status page redesign", "Usage: /council status"],
			["Cancel the retry logic", "Usage: /council cancel"],
			["Config schema cleanup", "Usage: /council config"],
			["resume run-1 extra", "Usage: /council resume [run-id]"],
		] as const) {
			expect(parseCouncilCommandArgs(args)).toEqual({
				kind: "error",
				message: `${message} (prefix with -- if your task starts with a subcommand word)`,
			});
		}
		expect(parseCouncilCommandArgs("-- Status page redesign")).toEqual({
			kind: "task",
			task: "Status page redesign",
		});
	});

	it("refuses a lone near-miss token and names the subcommand it meant", () => {
		for (const [token, subcommand] of [
			["statsu", "status"],
			["cnacel", "cancel"],
			["statuss", "status"],
			["cancl", "cancel"],
			["confug", "config"],
			["resmue", "resume"],
		] as const) {
			expect(parseCouncilCommandArgs(token)).toEqual({
				kind: "error",
				message: `Unknown council subcommand "${token}". Did you mean /council ${subcommand}? Run /council -- ${token} to use it as a task.`,
			});
		}
	});

	it("still dispatches a task that merely opens with a mistyped subcommand", () => {
		expect(parseCouncilCommandArgs("statsu page for the dashboard")).toEqual({
			kind: "task",
			task: "statsu page for the dashboard",
		});
		expect(parseCouncilCommandArgs("cnacel the retry logic")).toEqual({
			kind: "task",
			task: "cnacel the retry logic",
		});
	});

	it("resolves near misses in declared subcommand order", () => {
		const declared = BUILTIN_SLASH_COMMAND_DEFS.find(item => item.name === "council")?.subcommands?.map(
			sub => sub.name,
		);
		expect(declared).toEqual(["status", "cancel", "resume", "config"]);

		// Optimal string alignment distance, computed independently of the parser.
		const distance = (a: string, b: string): number => {
			const table = Array.from({ length: a.length + 1 }, (_, row) =>
				Array.from({ length: b.length + 1 }, (_, column) => (row === 0 ? column : column === 0 ? row : 0)),
			);
			for (let row = 1; row <= a.length; row++) {
				for (let column = 1; column <= b.length; column++) {
					const cost = a[row - 1] === b[column - 1] ? 0 : 1;
					let best = Math.min(
						table[row]![column - 1]! + 1,
						table[row - 1]![column]! + 1,
						table[row - 1]![column - 1]! + cost,
					);
					if (row > 1 && column > 1 && a[row - 1] === b[column - 2] && a[row - 2] === b[column - 1]) {
						best = Math.min(best, table[row - 2]![column - 2]! + 1);
					}
					table[row]![column] = best;
				}
			}
			return table[a.length]![b.length]!;
		};

		const alphabet = "abcdefghijklmnopqrstuvwxyz";
		const variants = new Set<string>();
		for (const name of declared!) {
			for (let index = 0; index < name.length; index++) {
				variants.add(name.slice(0, index) + name.slice(index + 1));
				if (index + 1 < name.length) {
					variants.add(name.slice(0, index) + name[index + 1] + name[index] + name.slice(index + 2));
				}
				for (const letter of alphabet) {
					variants.add(name.slice(0, index) + letter + name.slice(index + 1));
					variants.add(name.slice(0, index) + letter + name.slice(index));
				}
			}
		}

		let refusals = 0;
		for (const variant of variants) {
			if (declared!.includes(variant)) continue;
			const expected = declared!.find(name => distance(variant, name) === 1);
			const parsed = parseCouncilCommandArgs(variant);
			if (expected === undefined) {
				expect(parsed).toEqual({ kind: "task", task: variant });
				continue;
			}
			refusals++;
			expect(parsed).toEqual({
				kind: "error",
				message: `Unknown council subcommand "${variant}". Did you mean /council ${expected}? Run /council -- ${variant} to use it as a task.`,
			});
		}
		expect(refusals).toBeGreaterThan(0);
	});

	it("strips a leading literal marker and otherwise preserves task bytes", () => {
		expect(parseCouncilCommandArgs("  --   status  keep  spacing  ")).toEqual({
			kind: "task",
			task: "status  keep  spacing",
		});
		expect(parseCouncilCommandArgs("  unknown  keep  spacing  ")).toEqual({
			kind: "task",
			task: "unknown  keep  spacing",
		});
		expect(parseCouncilCommandArgs("--status keep")).toEqual({ kind: "task", task: "--status keep" });
		expect(parseCouncilCommandArgs("")).toEqual({ kind: "usage" });
		expect(parseCouncilCommandArgs("--   ")).toEqual({ kind: "usage" });
	});
});

describe("council shared handler", () => {
	it("starts immediately, consumes task text, reports a snapshot, and holds completion", async () => {
		const completion = Promise.withResolvers<void>();
		const start = mock(async (_task: string) => manifest());
		const h = harness({ start, completion: completion.promise });
		const result = await handleCouncilCommand(command("design  this exactly"), h.runtime, h.dependencies);
		expect(start.mock.calls[0]?.[0]).toBe("design  this exactly");
		expect(result).toEqual({ consumed: true });
		expect(snapshots(h.output)).toEqual([
			"Council run-123 under review (round 2/2): 1 of 3 members done, 1 running, 1 failed; plan: local://council-run-123-plan.md",
		]);
		expect(h.held).toHaveLength(1);
	});

	it("surfaces the first sanitized preflight warning and counts the rest", async () => {
		const h = harness({
			status: mock(async () =>
				manifest({
					warnings: ["\u001b[31mprovider/example\u001b[0m overlaps Main", "model\u0007 unavailable"],
				}),
			),
		});

		await handleCouncilCommand(command("status"), h.runtime, h.dependencies);

		expect(h.output).toHaveLength(1);
		expect(h.output[0]).toContain("; warning: provider/example overlaps Main (+1 more)");
		expect(h.output[0]).not.toContain("model unavailable");
		expect(h.output[0]).not.toContain("\u001b");
		expect(h.output[0]).not.toContain("\u0007");
	});

	it("suppresses deferred kickoff and error output after the session transitions", async () => {
		const startEntered = Promise.withResolvers<void>();
		const startResult = Promise.withResolvers<CouncilManifest>();
		const h = harness({
			start: mock(async () => {
				startEntered.resolve();
				return await startResult.promise;
			}),
		});
		const invocation = handleCouncilCommand(command("deferred transition"), h.runtime, h.dependencies);
		await startEntered.promise;
		h.runtime.sessionManager.getSessionId = () => "replacement-session";
		startResult.resolve(manifest());
		await invocation;

		expect(snapshots(h.output)).toEqual([]);
		expect(h.held).toEqual([]);

		const failureEntered = Promise.withResolvers<void>();
		const failureResult = Promise.withResolvers<CouncilManifest>();
		const failed = harness({
			start: mock(async () => {
				failureEntered.resolve();
				return await failureResult.promise;
			}),
		});
		const failedInvocation = handleCouncilCommand(command("deferred failure"), failed.runtime, failed.dependencies);
		await failureEntered.promise;
		failed.runtime.sessionManager.getSessionId = () => "replacement-session";
		failureResult.reject(new Error("stale council failure"));
		await failedInvocation;

		expect(failed.output.filter(text => text.includes("stale council failure"))).toEqual([]);
		expect(failed.held).toEqual([]);
	});

	it("suppresses terminal output when the session transitions after kickoff", async () => {
		const completion = Promise.withResolvers<void>();
		const coordinator: Partial<CouncilCoordinator> = {
			start: mock(async () => manifest()),
			completion: completion.promise,
			snapshot: manifest(),
		};
		const h = harness(coordinator);
		await handleCouncilCommand(command("transition after kickoff"), h.runtime, h.dependencies);
		h.runtime.sessionManager.getSessionId = () => "replacement-session";
		coordinator.snapshot = manifest({ state: "completed" });

		completion.resolve();
		await h.held[0];

		expect(snapshots(h.output)).toHaveLength(1);
		expect(snapshots(h.output)[0]).toContain("run-123 under review");
		expect(h.output.join("\n")).not.toContain("run-123 completed");
	});

	it("holds coordinator completion before reporting a start output failure", async () => {
		const completion = Promise.withResolvers<void>();
		const h = harness({ start: mock(async () => manifest()), completion: completion.promise });
		let attemptedKickoff = false;
		h.runtime.output = async text => {
			if (!text.startsWith("Council run-123 ")) return;
			attemptedKickoff = true;
			throw new Error("ACP output failed");
		};

		await handleCouncilCommand(command("plan despite output failure"), h.runtime, h.dependencies);

		expect(attemptedKickoff).toBe(true);
		expect(h.held).toHaveLength(1);
	});

	it("emits bounded terminal output before held completion settles", async () => {
		const completion = Promise.withResolvers<void>();
		const terminalOutputStarted = Promise.withResolvers<string>();
		const releaseTerminalOutput = Promise.withResolvers<void>();
		const coordinator: Partial<CouncilCoordinator> = {
			start: mock(async () => manifest()),
			completion: completion.promise,
			snapshot: manifest(),
		};
		const h = harness(coordinator);
		h.runtime.output = async text => {
			h.output.push(text);
			if (text.includes("run-123 failed")) {
				terminalOutputStarted.resolve(text);
				await releaseTerminalOutput.promise;
			}
		};
		await handleCouncilCommand(command("terminal report"), h.runtime, h.dependencies);
		coordinator.snapshot = manifest({
			state: "failed",
			failure: { phase: "coordinator", reason: `\u001b[31mfailure\u0007 \u001b[0m${"x".repeat(400)}` },
		});
		let heldSettled = false;
		void h.held[0]!.then(() => {
			heldSettled = true;
		});

		completion.resolve();
		const terminalOutput = await terminalOutputStarted.promise;
		expect(heldSettled).toBe(false);
		expect(terminalOutput).toContain("run-123 failed");
		expect(terminalOutput).toContain("plan: local://council-run-123-plan.md; failure=failure ");
		expect(terminalOutput.length).toBeLessThan(450);
		expect(terminalOutput).not.toContain("\u001b");
		expect(terminalOutput).not.toContain("\u0007");

		releaseTerminalOutput.resolve();
		await h.held[0];
		expect(heldSettled).toBe(true);
		expect(h.output.filter(text => text.includes("run-123 failed"))).toHaveLength(1);
	});

	it("keeps a successful coordinator outcome when terminal output delivery fails", async () => {
		const completion = Promise.withResolvers<void>();
		const coordinator: Partial<CouncilCoordinator> = {
			start: mock(async () => manifest()),
			completion: completion.promise,
			snapshot: manifest(),
		};
		const h = harness(coordinator);
		let terminalDeliveries = 0;
		h.runtime.output = async text => {
			if (!text.startsWith("Council run-123 completed")) return;
			terminalDeliveries++;
			throw new Error("terminal ACP output failed");
		};
		await handleCouncilCommand(command("terminal output failure"), h.runtime, h.dependencies);
		coordinator.snapshot = manifest({ state: "completed" });

		completion.resolve();
		await expect(h.held[0]).resolves.toBeUndefined();
		expect(terminalDeliveries).toBe(1);
	});

	it("reports kickoff before an already-settled completion's terminal output", async () => {
		const coordinator: Partial<CouncilCoordinator> = {
			start: mock(async () => manifest()),
			completion: Promise.resolve(),
			snapshot: manifest({ state: "completed" }),
		};
		const h = harness(coordinator);

		await handleCouncilCommand(command("fast completion"), h.runtime, h.dependencies);
		await h.held[0];

		expect(snapshots(h.output).map(text => /^Council run-123 ([a-z ]+) \(round/.exec(text)?.[1])).toEqual([
			"under review",
			"completed",
		]);
	});

	it("does not attach stale completion to an already-completed resume", async () => {
		const coordinator: Partial<CouncilCoordinator> = {
			resume: mock(async () => manifest({ state: "completed" })),
			completion: Promise.resolve(),
			snapshot: manifest({ state: "failed" }),
		};
		const h = harness(coordinator);

		await handleCouncilCommand(command("resume finished-run"), h.runtime, h.dependencies);

		expect(h.held).toEqual([]);
		expect(snapshots(h.output)).toHaveLength(1);
		expect(snapshots(h.output)[0]).toContain("run-123 completed");
	});

	it("surfaces a duplicate-start diagnostic without queuing another task", async () => {
		const start = mock(async () => {
			throw new Error(
				"Council run run-123 is already active for this session; use /council status or /council cancel.",
			);
		});
		const h = harness({ start });
		await handleCouncilCommand(command("another task"), h.runtime, h.dependencies);
		expect(start).toHaveBeenCalledTimes(1);
		expect(h.output.at(-1)).toBe(
			"Council run run-123 is already active for this session; use /council status or /council cancel.",
		);
		expect(h.held).toEqual([]);
	});

	it("cancels deferred preflight before dispatch without leaving a held ghost run", async () => {
		const setup = Promise.withResolvers<CouncilManifest>();
		const startEntered = Promise.withResolvers<void>();
		const cancel = mock(async () => manifest({ state: "interrupted" }));
		const status = mock(async () => undefined);
		const coordinator = {
			executionInFlight: true,
			setupInFlight: true,
			snapshot: undefined,
			completion: undefined,
			start: mock(async () => {
				startEntered.resolve();
				return await setup.promise;
			}),
			status,
			cancel,
			cancelForSessionTransition: mock(async () => {
				coordinator.executionInFlight = false;
				coordinator.setupInFlight = false;
				const aborted = new Error("Council setup cancelled");
				aborted.name = "AbortError";
				setup.reject(aborted);
			}),
		};
		const h = harness(coordinator);
		const starting = handleCouncilCommand(command("deferred setup"), h.runtime, h.dependencies);
		await startEntered.promise;

		await handleCouncilCommand(command("cancel"), h.runtime, h.dependencies);
		await starting;

		expect(coordinator.cancelForSessionTransition).toHaveBeenCalledTimes(1);
		expect(status).not.toHaveBeenCalled();
		expect(cancel).not.toHaveBeenCalled();
		expect(h.held).toEqual([]);
		expect(h.output).toContain("Council setup cancelled before dispatch.");
	});

	it("reports snapshotless deferred preflight as setup in progress", async () => {
		const status = mock(async () => undefined);
		const h = harness({
			executionInFlight: true,
			setupInFlight: true,
			snapshot: undefined,
			status,
		});

		await handleCouncilCommand(command("status"), h.runtime, h.dependencies);

		expect(status).not.toHaveBeenCalled();
		expect(h.output).toEqual(["Council setup/preflight is in progress."]);
	});

	it("reports an existing terminal snapshot instead of misclassifying summary delivery as setup", async () => {
		const terminal = manifest({ state: "completed" });
		const cancel = mock(async () => terminal);
		const cancelForSessionTransition = mock(async () => undefined);
		const h = harness({
			executionInFlight: true,
			setupInFlight: false,
			snapshot: terminal,
			status: mock(async () => terminal),
			cancel,
			cancelForSessionTransition,
		});

		await handleCouncilCommand(command("cancel"), h.runtime, h.dependencies);

		expect(cancelForSessionTransition).not.toHaveBeenCalled();
		expect(cancel).not.toHaveBeenCalled();
		expect(h.output).toHaveLength(1);
		expect(h.output[0]).toContain("run-123 completed");
	});

	it("reports no active run when cancel sees only an already-settled terminal snapshot", async () => {
		const terminal = manifest({ state: "completed-degraded" });
		const cancel = mock(async () => terminal);
		const h = harness({
			executionInFlight: false,
			setupInFlight: false,
			snapshot: terminal,
			status: mock(async () => terminal),
			cancel,
		});

		await handleCouncilCommand(command("cancel"), h.runtime, h.dependencies);

		expect(cancel).not.toHaveBeenCalled();
		expect(h.output).toEqual(["No active council run."]);
	});

	it("prints stable status, cancel, resume, and empty-state results", async () => {
		const completion = Promise.resolve();
		const coordinator = {
			status: mock(async () => manifest()),
			cancel: mock(async () => manifest({ state: "interrupted" })),
			resume: mock(async (_id?: string) => manifest({ state: "dispatching" })),
			completion,
		};
		const h = harness(coordinator);
		await handleCouncilCommand(command("status"), h.runtime, h.dependencies);
		await handleCouncilCommand(command("cancel"), h.runtime, h.dependencies);
		await handleCouncilCommand(command("resume run-old"), h.runtime, h.dependencies);
		expect(coordinator.cancel).toHaveBeenCalledTimes(1);
		expect(coordinator.resume.mock.calls[0]?.[0]).toBe("run-old");
		expect(snapshots(h.output)).toEqual([
			"Council run-123 under review (round 2/2): 1 of 3 members done, 1 running, 1 failed; plan: local://council-run-123-plan.md",
			"Council run-123 interrupted (round 2/2): 1 of 3 members done, 1 running, 1 failed; plan: local://council-run-123-plan.md",
			"Council run-123 starting (round 2/2): 1 of 3 members done, 1 running, 1 failed; plan: local://council-run-123-plan.md",
		]);
		expect(h.held).toHaveLength(1);

		const empty = harness({ status: mock(async () => undefined), cancel: mock(async () => manifest()) });
		await handleCouncilCommand(command("status"), empty.runtime, empty.dependencies);
		await handleCouncilCommand(command("cancel"), empty.runtime, empty.dependencies);
		expect(empty.output[0]).toBe(
			"No active council run. planner=slow model role, adjudicator=main session (in-session adjudication); 4 roles enabled (Reviewer 1=unassigned, Reviewer 2=unassigned, Reviewer 3=unassigned, Reviewer 4=unassigned); 1 round(s) per run. Fix the roster with /council config.",
		);
		expect(empty.output[1]).toBe("No active council run.");

		const builtIn = harness({ status: mock(async () => undefined) });
		builtIn.runtime.settings = Settings.isolated({
			"council.members": [{ role: "slow", enabled: true }],
		});
		await handleCouncilCommand(command("status"), builtIn.runtime, builtIn.dependencies);
		expect(builtIn.output).toEqual([
			"No active council run. planner=slow model role, adjudicator=main session (in-session adjudication); 1 role enabled (Slow=unassigned); 1 round(s) per run. Fix the roster with /council config.",
		]);
	});

	it("opens TUI config and gives ACP actionable guidance", async () => {
		const tui = harness({});
		await handleCouncilCommand(command("config"), tui.runtime, tui.dependencies);
		expect(tui.openCouncilConfig).toHaveBeenCalledTimes(1);
		expect(tui.output).toEqual([]);

		const acp = harness({});
		acp.runtime.openCouncilConfig = undefined;
		await handleCouncilCommand(command("config"), acp.runtime, acp.dependencies);
		expect(acp.output).toHaveLength(1);
		const guidance = acp.output[0]!;
		// Operator prose reads `Reviewer N`; the YAML below it keeps the durable `councilN` ids.
		expect(guidance).toContain("4 roles enabled (Reviewer 1=unassigned");
		expect(guidance).toContain(acp.runtime.settings.getGlobalConfigPath());
		expect(guidance).toContain("council:\n  members:\n    - role: council1\n      enabled: true");
		expect(guidance).toContain("modelRoles:\n  council1: provider/model");
		expect(guidance).toContain("  planner: provider/model");
		expect(guidance).toContain("  adjudicator: provider/model");
		expect(guidance).toContain("  advisor:\n    planner: false\n    reviewers: false\n    adjudicator: false");
		expect(guidance).toContain("An unassigned `planner` role falls back to the `slow` model role");
		expect(guidance).toContain("an unassigned `adjudicator` role keeps adjudication in your main session.");
	});

	it("prints usage for empty input and rejects invalid subcommand arguments", async () => {
		const h = harness({});
		await handleCouncilCommand(command(""), h.runtime, h.dependencies);
		await handleCouncilCommand(command("cancel trailing"), h.runtime, h.dependencies);
		expect(h.output).toEqual([
			COUNCIL_USAGE,
			"Usage: /council cancel (prefix with -- if your task starts with a subcommand word)",
		]);
	});

	it("names the roster it is about to spend on before the first child launches", async () => {
		const h = harness({
			start: async (_task: string, options?: CouncilRunOptions) => {
				await options?.onKickoff?.({
					runId: "run-123",
					resumed: false,
					plannerModel: "planner/fixed",
					adjudicator: { mode: "main", model: "main/active" },
					members: [
						{ role: "council1", model: "member/one", rounds: [1, 2] },
						{ role: "council2", model: "member/two", rounds: [1, 2] },
					],
					rounds: 2,
				});
				return manifest();
			},
		});

		await handleCouncilCommand(command("do the thing"), h.runtime, h.dependencies);

		// Roster resolution can block on the keychain, so the wait is announced before it starts.
		expect(h.output.slice(0, 2)).toEqual([
			"Resolving council roster…",
			"Starting run-123: planner=planner/fixed, adjudicator=main/active (main), round 1: [Reviewer 1=member/one, Reviewer 2=member/two], round 2: [Reviewer 1=member/one, Reviewer 2=member/two].",
		]);
	});

	it("announces the storage read and the roster before a resume, and marks it resumed", async () => {
		const h = harness({
			resume: async (_runId?: string, options?: CouncilRunOptions) => {
				await options?.onKickoff?.({
					runId: "run-123",
					resumed: true,
					plannerModel: "planner/fixed",
					adjudicator: { mode: "main", model: "main/active" },
					members: [{ role: "council1", model: "member/one", rounds: [1] }],
					rounds: 1,
				});
				return manifest();
			},
		});

		await handleCouncilCommand(command("resume run-123"), h.runtime, h.dependencies);

		expect(h.output.slice(0, 3)).toEqual([
			"Loading council run…",
			"Resolving council roster…",
			"Resuming run-123: planner=planner/fixed, adjudicator=main/active (main), round 1: [Reviewer 1=member/one].",
		]);
	});

	it("says a completed run has nothing to resume", async () => {
		const h = harness({ resume: async () => manifest({ state: "completed" }) });

		await handleCouncilCommand(command("resume run-123"), h.runtime, h.dependencies);

		expect(h.output).toContain("Run run-123 already completed; nothing to resume.");
		expect(snapshots(h.output)).toHaveLength(1);
	});
});
