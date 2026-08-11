import { type Mock, afterEach, describe, expect, it, vi } from "bun:test";
import type { GoalControllerResult } from "@oh-my-pi/pi-coding-agent/goals/goal-mode-controller";
import type { Goal } from "@oh-my-pi/pi-coding-agent/goals/state";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { handleGoalAcp, handleGuidedGoalAcp } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/goal";

/**
 * handleGoalAcp / handleGuidedGoalAcp dispatch tests. The runtime is stubbed
 * with a vi.fn-backed goalModeController shaped to the controller's public
 * surface — no module mocking, so the suite stays isolated and restoreAllMocks
 * keeps it safe.
 */

/** Stub controller surface used by handleGoalAcp (Mock-typed, not ReturnType). */
interface StubController {
	enter: Mock<(objective: string) => Promise<GoalControllerResult>>;
	replaceObjective: Mock<(objective: string) => Promise<GoalControllerResult>>;
	show: Mock<() => string>;
	pause: Mock<() => Promise<GoalControllerResult>>;
	resume: Mock<() => Promise<GoalControllerResult>>;
	drop: Mock<() => Promise<GoalControllerResult>>;
	setBudget: Mock<(value: number | undefined) => Promise<GoalControllerResult>>;
	exposeGoalTool: Mock<() => Promise<void>>;
	entryGuard: Mock<() => GoalControllerResult | null>;
}

const ACTIVE_GOAL: Goal = {
	id: "goal-1",
	objective: "Build a widget",
	status: "active",
	tokenBudget: 1000,
	tokensUsed: 120,
	timeUsedSeconds: 45,
	createdAt: 0,
	updatedAt: 0,
};

const GOAL_DETAILS = [
	"Objective: Build a widget",
	"Status: active",
	"Tokens: 120 / 1,000 (880 left)",
	"Time spent: 45s",
].join("\n");

function createStubController(): StubController {
	return {
		enter: vi.fn(async (_objective: string): Promise<GoalControllerResult> => ({ ok: true })),
		replaceObjective: vi.fn(async (_objective: string): Promise<GoalControllerResult> => ({ ok: true })),
		show: vi.fn((): string => GOAL_DETAILS),
		pause: vi.fn(async (): Promise<GoalControllerResult> => ({ ok: true })),
		resume: vi.fn(async (): Promise<GoalControllerResult> => ({ ok: true })),
		drop: vi.fn(async (): Promise<GoalControllerResult> => ({ ok: true })),
		setBudget: vi.fn(async (_value: number | undefined): Promise<GoalControllerResult> => ({ ok: true })),
		exposeGoalTool: vi.fn(async (): Promise<void> => {}),
		entryGuard: vi.fn((): GoalControllerResult | null => null),
	};
}

function createRuntime(controller: StubController, options: { activeGoal?: boolean } = {}) {
	const prompt = vi.fn(async (_text: string): Promise<boolean> => true);
	const output = vi.fn(async () => {});
	const runtime = {
		session: {
			goalModeController: controller,
			getGoalModeState: () =>
				options.activeGoal ? { enabled: true, mode: "active", goal: ACTIVE_GOAL } : undefined,
			getPlanModeState: () => undefined,
			settings: { get: vi.fn((key: string) => (key === "goal.enabled" ? true : undefined)) },
			prompt,
		},
		sessionManager: {},
		settings: { get: vi.fn() },
		cwd: "/tmp",
		output,
		refreshCommands: vi.fn(async () => {}),
		reloadPlugins: vi.fn(async () => {}),
	} as unknown as SlashCommandRuntime;
	return { runtime, output, prompt };
}

function command(args: string) {
	return { name: "goal", args, text: args ? `/goal ${args}` : "/goal" };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("handleGoalAcp", () => {
	it("'set X' with no active goal calls enter and returns the kickoff prompt", async () => {
		const controller = createStubController();
		controller.enter.mockResolvedValue({ ok: true, prompt: "X" });
		const { runtime } = createRuntime(controller, { activeGoal: false });

		const result = await handleGoalAcp(command("set X"), runtime);

		expect(controller.enter).toHaveBeenCalledTimes(1);
		expect(controller.enter).toHaveBeenCalledWith("X");
		expect(controller.replaceObjective).not.toHaveBeenCalled();
		expect(result).toEqual({ prompt: "X" });
	});

	it("'set Y' with an active goal calls replaceObjective instead of enter", async () => {
		const controller = createStubController();
		controller.replaceObjective.mockResolvedValue({ ok: true, prompt: "Y" });
		const { runtime } = createRuntime(controller, { activeGoal: true });

		const result = await handleGoalAcp(command("set Y"), runtime);

		expect(controller.replaceObjective).toHaveBeenCalledTimes(1);
		expect(controller.replaceObjective).toHaveBeenCalledWith("Y");
		expect(controller.enter).not.toHaveBeenCalled();
		expect(result).toEqual({ prompt: "Y" });
	});

	it("'set' without an objective returns a usage error", async () => {
		const controller = createStubController();
		const { runtime, output } = createRuntime(controller);

		const result = await handleGoalAcp(command("set"), runtime);

		expect(controller.enter).not.toHaveBeenCalled();
		expect(controller.replaceObjective).not.toHaveBeenCalled();
		expect(output).toHaveBeenCalledWith("Usage: /goal set <objective>");
		expect(result).toEqual({ consumed: true });
	});

	it("'show' outputs the goal details and consumes", async () => {
		const controller = createStubController();
		controller.show.mockReturnValue(GOAL_DETAILS);
		const { runtime, output } = createRuntime(controller);

		const result = await handleGoalAcp(command("show"), runtime);

		expect(controller.show).toHaveBeenCalledTimes(1);
		expect(output).toHaveBeenCalledWith(GOAL_DETAILS);
		expect(result).toEqual({ consumed: true });
	});

	it("bare /goal outputs show() and consumes", async () => {
		const controller = createStubController();
		controller.show.mockReturnValue(GOAL_DETAILS);
		const { runtime, output } = createRuntime(controller);

		const result = await handleGoalAcp(command(""), runtime);

		expect(controller.show).toHaveBeenCalledTimes(1);
		expect(output).toHaveBeenCalledWith(GOAL_DETAILS);
		expect(result).toEqual({ consumed: true });
	});

	it("'drop' calls controller.drop and consumes", async () => {
		const controller = createStubController();
		const { runtime } = createRuntime(controller, { activeGoal: true });

		const result = await handleGoalAcp(command("drop"), runtime);

		expect(controller.drop).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ consumed: true });
	});

	it("'pause' and 'resume' consume on success", async () => {
		const controller = createStubController();
		const { runtime } = createRuntime(controller);

		expect(await handleGoalAcp(command("pause"), runtime)).toEqual({ consumed: true });
		expect(await handleGoalAcp(command("resume"), runtime)).toEqual({ consumed: true });
		expect(controller.pause).toHaveBeenCalledTimes(1);
		expect(controller.resume).toHaveBeenCalledTimes(1);
	});

	it("'budget 100' calls setBudget(100)", async () => {
		const controller = createStubController();
		const { runtime } = createRuntime(controller);

		const result = await handleGoalAcp(command("budget 100"), runtime);

		expect(controller.setBudget).toHaveBeenCalledTimes(1);
		expect(controller.setBudget).toHaveBeenCalledWith(100);
		expect(result).toEqual({ consumed: true });
	});

	it("'budget off' calls setBudget(undefined)", async () => {
		const controller = createStubController();
		const { runtime } = createRuntime(controller);

		const result = await handleGoalAcp(command("budget off"), runtime);

		expect(controller.setBudget).toHaveBeenCalledTimes(1);
		expect(controller.setBudget).toHaveBeenCalledWith(undefined);
		expect(result).toEqual({ consumed: true });
	});

	it("'budget' without a value returns a usage error", async () => {
		const controller = createStubController();
		const { runtime, output } = createRuntime(controller);

		const result = await handleGoalAcp(command("budget"), runtime);

		expect(controller.setBudget).not.toHaveBeenCalled();
		expect(output).toHaveBeenCalledWith("Usage: /goal budget <N|off>");
		expect(result).toEqual({ consumed: true });
	});

	it("unknown verb with an active goal returns a usage error", async () => {
		const controller = createStubController();
		const { runtime, output } = createRuntime(controller, { activeGoal: true });

		const result = await handleGoalAcp(command("frobnicate"), runtime);

		expect(controller.enter).not.toHaveBeenCalled();
		expect(output).toHaveBeenCalledWith(
			"Unknown /goal subcommand. Use set|show|pause|resume|drop|budget",
		);
		expect(result).toEqual({ consumed: true });
	});

	it("controller errors surface via usage", async () => {
		const controller = createStubController();
		controller.enter.mockResolvedValue({ ok: false, error: "Goal mode is disabled." });
		const { runtime, output } = createRuntime(controller);

		const result = await handleGoalAcp(command("set X"), runtime);

		expect(output).toHaveBeenCalledWith("Goal mode is disabled.");
		expect(result).toEqual({ consumed: true });
	});
});

describe("handleGuidedGoalAcp", () => {
	it("exposes the goal tool and returns the interview as a residual prompt without calling session.prompt", async () => {
		// Contract: the guided-goal handler MUST return { prompt } so the slash
		// dispatcher feeds the interview kickoff as model input within the
		// current client request. Calling session.prompt() directly would nest an
		// agent-initiated turn and break the ACP lifecycle.
		const controller = createStubController();
		const { runtime, prompt } = createRuntime(controller);

		const result = await handleGuidedGoalAcp(command("rough idea"), runtime);

		expect(controller.exposeGoalTool).toHaveBeenCalledTimes(1);
		// Must NOT call session.prompt() directly — that would nest an
		// agent-initiated turn. The interview is returned as a residual prompt.
		expect(prompt).not.toHaveBeenCalled();
		expect(result).toEqual({ prompt: expect.any(String) });
		if (result && typeof result === "object" && "prompt" in result) {
			// The interview kickoff is rendered from the guided-goal template and
			// carries the supplied rough objective.
			expect(result.prompt).toContain("rough idea");
		}
	});

	it("rejects /guided-goal in a plan_paused session via the controller entry guard (dispatcher-level)", async () => {
		// Regression: the goal tool's createGoal has no plan guard, so a guided-goal
		// interview started in a plan_paused session could create a goal that
		// replaces the paused plan. The handler must block via entryGuard BEFORE
		// exposing the tool.
		const controller = createStubController();
		controller.entryGuard.mockReturnValue({ ok: false, error: "Exit plan mode first." });
		const { runtime, output } = createRuntime(controller);

		const result = await executeAcpBuiltinSlashCommand("/guided-goal plan an idea", runtime);

		expect(controller.exposeGoalTool).not.toHaveBeenCalled();
		expect(output).toHaveBeenCalledWith("Exit plan mode first.");
		expect(result).toEqual({ consumed: true });
	});
});

describe("executeAcpBuiltinSlashCommand /goal dispatch", () => {
	// The original gap: ACP advertises + executes only specs with `handle`. These
	// assert the ACTUAL dispatcher-level execution path (not just the helper).
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("dispatches `/goal show` through the ACP builtin dispatcher and consumes", async () => {
		const controller = createStubController();
		const { runtime, output } = createRuntime(controller);

		const result = await executeAcpBuiltinSlashCommand("/goal show", runtime);

		expect(output).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ consumed: true });
	});

	it("dispatches `/goal set <objective>` and returns the residual prompt", async () => {
		const controller = createStubController();
		controller.enter.mockResolvedValue({ ok: true, prompt: "ship it" });
		const { runtime } = createRuntime(controller);

		const result = await executeAcpBuiltinSlashCommand("/goal set ship it", runtime);

		expect(result).toEqual({ prompt: "ship it" });
	});

	it("returns false for an unknown command (not consumed by a builtin)", async () => {
		const controller = createStubController();
		const { runtime } = createRuntime(controller);

		const result = await executeAcpBuiltinSlashCommand("/not-a-builtin", runtime);

		expect(result).toBe(false);
	});
});
