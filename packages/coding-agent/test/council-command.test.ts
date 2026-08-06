import { describe, expect, it, mock } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CouncilCoordinator } from "@oh-my-pi/pi-coding-agent/council/coordinator";
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
import type { ParsedSlashCommand, SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

function manifest(overrides: Partial<CouncilManifest> = {}): CouncilManifest {
	return {
		runId: "run-123",
		state: "reviewing",
		outputPath: "plans/council-run-123.md",
		warnings: [],
		rounds: [
			{
				round: 2,
				members: [{ status: "succeeded" }, { status: "running" }, { status: "failed" }],
			},
		],
		...overrides,
	} as CouncilManifest;
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
			description: "Run a multi-model planning council",
			allowArgs: true,
			subcommands: [
				{ name: "status" },
				{ name: "cancel" },
				{ name: "resume", usage: "[run-id]" },
				{ name: "config" },
			],
		});
		expect(ACP_BUILTIN_RESERVED_NAMES.has("council")).toBe(true);
		expect(ACP_BUILTIN_SLASH_COMMANDS.filter(item => item.name === "council")).toEqual([
			expect.objectContaining({ name: "council", description: "Run a multi-model planning council" }),
		]);
	});

	it("blocks moving while a council is nonterminal and permits terminal snapshots", () => {
		expect(councilMoveBlockMessage({ snapshot: manifest({ state: "planning" }) } as CouncilCoordinator)).toBe(
			"Cannot move while council run run-123 is planning; use /council cancel first.",
		);
		expect(
			councilMoveBlockMessage({ snapshot: manifest({ state: "completed" }) } as CouncilCoordinator),
		).toBeUndefined();
		expect(councilMoveBlockMessage({ snapshot: undefined } as CouncilCoordinator)).toBeUndefined();
	});
});

describe("council argument parsing", () => {
	it("recognizes only exact leading subcommand tokens", () => {
		expect(parseCouncilCommandArgs("status")).toEqual({ kind: "status" });
		expect(parseCouncilCommandArgs("status report exactly")).toEqual({
			kind: "error",
			message: "Usage: /council status",
		});
		expect(parseCouncilCommandArgs("status-report exactly")).toEqual({
			kind: "task",
			task: "status-report exactly",
		});
		expect(parseCouncilCommandArgs("Resume run-1")).toEqual({ kind: "task", task: "Resume run-1" });
		expect(parseCouncilCommandArgs("resume run-1")).toEqual({ kind: "resume", runId: "run-1" });
		expect(parseCouncilCommandArgs("resume run-1 extra")).toEqual({
			kind: "error",
			message: "Usage: /council resume [run-id]",
		});
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
		expect(start).toHaveBeenCalledWith("design  this exactly");
		expect(result).toEqual({ consumed: true });
		expect(h.output).toEqual([
			"Council run-123: state=reviewing; round=2; roster=1/3 succeeded, 1 running, 1 failed; warnings=0; output=plans/council-run-123.md",
		]);
		expect(h.held).toHaveLength(1);
	});

	it("reports only the count of untrusted preflight warnings in snapshots", async () => {
		const h = harness({
			status: mock(async () =>
				manifest({
					warnings: ["\u001b[31mprovider/example\u001b[0m overlaps Main", "model\u0007 unavailable"],
				}),
			),
		});

		await handleCouncilCommand(command("status"), h.runtime, h.dependencies);

		expect(h.output).toHaveLength(1);
		expect(h.output[0]).toContain("warnings=2");
		expect(h.output[0]).not.toContain("provider/example");
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

		expect(h.output).toEqual([]);
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

		expect(failed.output).toEqual([]);
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

		expect(h.output).toHaveLength(1);
		expect(h.output[0]).toContain("state=reviewing");
		expect(h.output[0]).not.toContain("state=completed");
	});

	it("holds coordinator completion before reporting a start output failure", async () => {
		const completion = Promise.withResolvers<void>();
		const h = harness({ start: mock(async () => manifest()), completion: completion.promise });
		let outputCalls = 0;
		h.runtime.output = async () => {
			outputCalls++;
			if (outputCalls === 1) throw new Error("ACP output failed");
		};

		await handleCouncilCommand(command("plan despite output failure"), h.runtime, h.dependencies);

		expect(outputCalls).toBe(2);
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
			if (text.includes("state=failed")) {
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
		expect(terminalOutput).toContain("state=failed");
		expect(terminalOutput).toContain("output=plans/council-run-123.md; failure=failure ");
		expect(terminalOutput.length).toBeLessThan(450);
		expect(terminalOutput).not.toContain("\u001b");
		expect(terminalOutput).not.toContain("\u0007");

		releaseTerminalOutput.resolve();
		await h.held[0];
		expect(heldSettled).toBe(true);
		expect(h.output.filter(text => text.includes("state=failed"))).toHaveLength(1);
	});

	it("keeps a successful coordinator outcome when terminal output delivery fails", async () => {
		const completion = Promise.withResolvers<void>();
		const coordinator: Partial<CouncilCoordinator> = {
			start: mock(async () => manifest()),
			completion: completion.promise,
			snapshot: manifest(),
		};
		const h = harness(coordinator);
		let outputCalls = 0;
		h.runtime.output = async () => {
			outputCalls++;
			if (outputCalls === 2) throw new Error("terminal ACP output failed");
		};
		await handleCouncilCommand(command("terminal output failure"), h.runtime, h.dependencies);
		coordinator.snapshot = manifest({ state: "completed" });

		completion.resolve();
		await expect(h.held[0]).resolves.toBeUndefined();
		expect(outputCalls).toBe(2);
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

		expect(h.output.map(text => /state=([^;]+)/.exec(text)?.[1])).toEqual(["reviewing", "completed"]);
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
		expect(h.output).toHaveLength(1);
		expect(h.output[0]).toContain("state=completed");
	});

	it("surfaces a duplicate-start diagnostic without queuing another task", async () => {
		const start = mock(async () => {
			throw new Error("Council run run-123 is already reviewing; use /council status or /council cancel.");
		});
		const h = harness({ start });
		await handleCouncilCommand(command("another task"), h.runtime, h.dependencies);
		expect(start).toHaveBeenCalledTimes(1);
		expect(h.output).toEqual(["Council run run-123 is already reviewing; use /council status or /council cancel."]);
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

	it("reports snapshotless deferred preflight as zero-spend setup in progress", async () => {
		const status = mock(async () => undefined);
		const h = harness({
			executionInFlight: true,
			setupInFlight: true,
			snapshot: undefined,
			status,
		});

		await handleCouncilCommand(command("status"), h.runtime, h.dependencies);

		expect(status).not.toHaveBeenCalled();
		expect(h.output).toEqual(["Council setup/preflight is in progress; cost=$0."]);
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
		expect(h.output[0]).toContain("state=completed");
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
		expect(coordinator.resume).toHaveBeenCalledWith("run-old");
		expect(h.output).toHaveLength(3);
		expect(h.output[0]).toContain("state=reviewing");
		expect(h.output[1]).toContain("state=interrupted");
		expect(h.output[2]).toContain("state=dispatching");
		expect(h.held).toHaveLength(1);

		const empty = harness({ status: mock(async () => undefined), cancel: mock(async () => manifest()) });
		await handleCouncilCommand(command("status"), empty.runtime, empty.dependencies);
		await handleCouncilCommand(command("cancel"), empty.runtime, empty.dependencies);
		expect(empty.output[0]).toBe(
			"No active council run. rounds=1; task.maxConcurrency=32; roster=4/4 enabled [council1=unassigned, council2=unassigned, council3=unassigned, council4=unassigned]; cost=$0.",
		);
		expect(empty.output[1]).toBe("No active council run.");

		const builtIn = harness({ status: mock(async () => undefined) });
		builtIn.runtime.settings = Settings.isolated({
			"council.members": [{ role: "slow", enabled: true }],
		});
		await handleCouncilCommand(command("status"), builtIn.runtime, builtIn.dependencies);
		expect(builtIn.output).toEqual([
			"No active council run. rounds=1; task.maxConcurrency=32; roster=1/1 enabled [slow=unassigned]; cost=$0.",
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
		expect(acp.output).toEqual(["Council configuration requires the Model Hub Roles view."]);
	});

	it("prints usage for empty input and rejects invalid subcommand arguments", async () => {
		const h = harness({});
		await handleCouncilCommand(command(""), h.runtime, h.dependencies);
		await handleCouncilCommand(command("cancel trailing"), h.runtime, h.dependencies);
		expect(h.output).toEqual([
			"Usage: /council <task> | status | cancel | resume [run-id] | config",
			"Usage: /council cancel",
		]);
	});
});
