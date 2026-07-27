import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StateTracker } from "../state";
import {
	gateFileExists,
	gateFilePath,
	gateResponseExists,
	gateResponsePath,
	handleGateTimeout,
	pendingQuestionPath,
	readGateFile,
	readGateResponse,
	scanPendingQuestions,
	waitForGateResponse,
	writeGateFile,
	writeGateResponse,
	createAmbientGate,
} from "../gate";

let workspace: string;
let stateDir: string;

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-gate-test-"));
	stateDir = path.join(workspace, ".swarm_gate-test", "state");
	await fs.mkdir(stateDir, { recursive: true });
});

afterEach(async () => {
	await fs.rm(workspace, { recursive: true, force: true });
});

// ============================================================================
// E1 — Declared gate writes gate-<agent>.json and pauses before next wave
// ============================================================================

describe("E1 — Declared gate pause (§6.2)", () => {
	it("writes gate-<agent>.json with prompt and actions", async () => {
		const config = {
			prompt: "Approve this plan?",
			actions: ["approve", "reject"],
		};

		await writeGateFile(stateDir, "plan", config);

		const exists = await gateFileExists(stateDir, "plan");
		expect(exists).toBe(true);

		const gate = await readGateFile(stateDir, "plan");
		expect(gate).not.toBeNull();
		expect(gate!.agent).toBe("plan");
		expect(gate!.prompt).toBe("Approve this plan?");
		expect(gate!.actions).toEqual(["approve", "reject"]);
		expect(gate!.pausedAt).toBeGreaterThan(0);
	});

	it("per-agent filenames avoid parallel-wave collisions", async () => {
		const configA = { prompt: "Plan A?", actions: ["yes", "no"] };
		const configB = { prompt: "Plan B?", actions: ["yes", "no"] };

		await writeGateFile(stateDir, "planner", configA);
		await writeGateFile(stateDir, "reviewer", configB);

		const gateA = await readGateFile(stateDir, "planner");
		const gateB = await readGateFile(stateDir, "reviewer");

		expect(gateA!.agent).toBe("planner");
		expect(gateB!.agent).toBe("reviewer");
		expect(gateA!.prompt).toBe("Plan A?");
		expect(gateB!.prompt).toBe("Plan B?");
	});

	it("pipeline status is set to paused when gate is active", async () => {
		const tracker = new StateTracker(workspace, "gate-test");
		await tracker.init(["plan", "coder"], 1, "sequential");

		// Simulate: plan agent hits a gate
		await tracker.updateAgent("plan", {
			status: "completed",
			gateStatus: { paused: true },
		});

		// Pipeline is paused
		await tracker.updatePipeline({ status: "paused" });

		const raw = await fs.readFile(
			path.join(workspace, ".swarm_gate-test", "state", "pipeline.json"),
			"utf-8",
		);
		const persisted = JSON.parse(raw);

		expect(persisted.status).toBe("paused");
		expect(persisted.agents.plan.gateStatus.paused).toBe(true);
	});

	it("next wave does NOT start while gate response is absent", async () => {
		// Gate file exists but no response → gateResponseExists returns false
		const config = { prompt: "Go?", actions: ["yes", "no"] };
		await writeGateFile(stateDir, "plan", config);

		const hasResponse = await gateResponseExists(stateDir, "plan");
		expect(hasResponse).toBe(false);
	});

	it("next wave does NOT start when response decision is 'stop'", async () => {
		const config = { prompt: "Go?", actions: ["yes", "stop"] };
		await writeGateFile(stateDir, "plan", config);

		// Human writes "stop" response
		await writeGateResponse(stateDir, "plan", "stop");

		const response = await readGateResponse(stateDir, "plan");
		expect(response).not.toBeNull();
		expect(response!.decision).toBe("stop");
	});

	it("next wave proceeds only after valid gate response", async () => {
		const config = { prompt: "Go?", actions: ["yes", "no"] };
		await writeGateFile(stateDir, "plan", config);

		// No response yet
		expect(await gateResponseExists(stateDir, "plan")).toBe(false);

		// Human writes response
		await writeGateResponse(stateDir, "plan", "yes");

		const response = await readGateResponse(stateDir, "plan");
		expect(response).not.toBeNull();
		expect(response!.decision).toBe("yes");
		expect(response!.resolvedAt).toBeGreaterThan(0);
	});
});

// ============================================================================
// E2 — Ambient scan catches undeclared pending-question-*.md (§7.1)
// ============================================================================

describe("E2 — Ambient scan (§7.1)", () => {
	it("detects pending-question file for agent without declared gate", async () => {
		// An agent with NO declared gate writes a pending question
		const questionPath = pendingQuestionPath(stateDir, "brainstorm");
		await fs.writeFile(questionPath, "# Clarification needed\n\nWhat framework should we use?");

		const questions = await scanPendingQuestions(stateDir, ["brainstorm"]);
		expect(questions.has("brainstorm")).toBe(true);
		expect(questions.get("brainstorm")).toContain("What framework should we use?");
	});

	it("ambient scan creates gate file from pending question", async () => {
		const questionPath = pendingQuestionPath(stateDir, "coder");
		await fs.writeFile(questionPath, "Should I use TypeScript or JavaScript?");

		const questions = await scanPendingQuestions(stateDir, ["coder"]);
		expect(questions.size).toBe(1);

		// Create ambient gate from the question
		await createAmbientGate(stateDir, "coder", questions.get("coder")!);

		// Gate file should now exist
		const gate = await readGateFile(stateDir, "coder");
		expect(gate).not.toBeNull();
		expect(gate!.prompt).toBe("Should I use TypeScript or JavaScript?");
		expect(gate!.actions).toEqual(["respond"]);
	});

	it("ambient scan returns empty for agents without pending questions", async () => {
		const questions = await scanPendingQuestions(stateDir, ["coder", "reviewer"]);
		expect(questions.size).toBe(0);
	});

	it("ambient scan handles mixed: some agents have questions, some don't", async () => {
		const questionPath = pendingQuestionPath(stateDir, "coder");
		await fs.writeFile(questionPath, "Need direction.");

		const questions = await scanPendingQuestions(stateDir, ["coder", "reviewer", "planner"]);
		expect(questions.has("coder")).toBe(true);
		expect(questions.has("reviewer")).toBe(false);
		expect(questions.has("planner")).toBe(false);
	});

	it("next wave is blocked when ambient gate is detected", async () => {
		// Simulate ambient gate detection
		const questionPath = pendingQuestionPath(stateDir, "brainstorm");
		await fs.writeFile(questionPath, "What's the deadline?");

		const questions = await scanPendingQuestions(stateDir, ["brainstorm"]);
		if (questions.has("brainstorm")) {
			await createAmbientGate(stateDir, "brainstorm", questions.get("brainstorm")!);
		}

		// Gate exists → next wave blocked
		const gateExists = await gateFileExists(stateDir, "brainstorm");
		expect(gateExists).toBe(true);

		// No response yet → still blocked
		const hasResponse = await gateResponseExists(stateDir, "brainstorm");
		expect(hasResponse).toBe(false);
	});
});

// ============================================================================
// F1 — gate-response resumes via session-resume (§6.3)
// ============================================================================

describe("F1 — Gate resume via session-resume (§6.3)", () => {
	it("gate response file is readable for session resume", async () => {
		const config = {
			prompt: "Approve?",
			actions: ["approve", "reject"],
		};
		await writeGateFile(stateDir, "plan", config);

		// Human response
		await writeGateResponse(stateDir, "plan", "approve");

		const response = await readGateResponse(stateDir, "plan");
		expect(response).not.toBeNull();
		expect(response!.agent).toBe("plan");
		expect(response!.decision).toBe("approve");
	});

	it("gate response preserves decision for session replay", async () => {
		await writeGateResponse(stateDir, "reviewer", "merge_with_changes");

		const response = await readGateResponse(stateDir, "reviewer");
		expect(response!.decision).toBe("merge_with_changes");
	});

	it("gate status transitions from paused to resolved", async () => {
		const tracker = new StateTracker(workspace, "resume-test");
		await tracker.init(["plan"], 1, "sequential");

		// Phase 1: paused
		await tracker.updateAgent("plan", {
			status: "completed",
			gateStatus: { paused: true },
		});
		expect(tracker.state.agents.plan.gateStatus).toEqual({ paused: true });

		// Phase 2: resolved
		await tracker.updateAgent("plan", {
			gateStatus: { paused: false, resolvedAction: "approve" },
		});
		expect(tracker.state.agents.plan.gateStatus!.paused).toBe(false);
		expect(tracker.state.agents.plan.gateStatus!.resolvedAction).toBe("approve");
	});
});

// ============================================================================
// F2 — Timeout expiry writes synthetic response (§7.2.3)
// ============================================================================

describe("F2 — Timeout expiry (§7.2.3)", () => {
	it("writes synthetic response with fail decision on timeout", async () => {
		const config = {
			prompt: "Approve?",
			actions: ["approve", "reject"],
			timeout: 0.1, // 100ms
			onTimeout: "fail" as const,
		};

		const response = await handleGateTimeout(stateDir, "plan", config);
		expect(response.decision).toBe("fail");
		expect(response.agent).toBe("plan");

		// Verify persisted
		const persisted = await readGateResponse(stateDir, "plan");
		expect(persisted!.decision).toBe("fail");
	});

	it("writes default_action on timeout when configured", async () => {
		const config = {
			prompt: "Approve?",
			actions: ["approve", "reject"],
			timeout: 0.1,
			onTimeout: "default_action" as const,
			defaultAction: "approve",
		};

		const response = await handleGateTimeout(stateDir, "plan", config);
		expect(response.decision).toBe("approve");
	});

	it("defaults to fail when onTimeout is not specified", async () => {
		const config = {
			prompt: "Approve?",
			actions: ["approve", "reject"],
			timeout: 0.1,
		};

		const response = await handleGateTimeout(stateDir, "plan", config);
		expect(response.decision).toBe("fail");
	});

	it("waitForGateResponse returns synthetic response after timeout", async () => {
		const config = {
			prompt: "Go?",
			actions: ["yes", "no"],
			timeout: 0.1,
			onTimeout: "fail" as const,
		};

		const response = await waitForGateResponse(stateDir, "plan", config);
		expect(response.decision).toBe("fail");
	});

	it("waitForGateResponse returns human response before timeout", async () => {
		const config = {
			prompt: "Go?",
			actions: ["yes", "no"],
			timeout: 5,
		};

		// Write human response immediately (simulating fast human)
		await writeGateResponse(stateDir, "plan", "yes");

		const response = await waitForGateResponse(stateDir, "plan", config);
		expect(response.decision).toBe("yes");
	});

	it("waitForGateResponse aborts on signal", async () => {
		const config = {
			prompt: "Go?",
			actions: ["yes", "no"],
		};

		const controller = new AbortController();
		// Abort immediately
		controller.abort();

		await expect(waitForGateResponse(stateDir, "plan", config, controller.signal)).rejects.toThrow(
			"Gate wait aborted",
		);
	});

	it("pipeline proceeds after timeout writes synthetic response", async () => {
		const config = {
			prompt: "Approve?",
			actions: ["approve", "reject"],
			timeout: 0.1,
			onTimeout: "default_action" as const,
			defaultAction: "approve",
		};

		// Before timeout: no response
		expect(await gateResponseExists(stateDir, "plan")).toBe(false);

		// After timeout: synthetic response exists
		await waitForGateResponse(stateDir, "plan", config);
		expect(await gateResponseExists(stateDir, "plan")).toBe(true);

		const response = await readGateResponse(stateDir, "plan");
		expect(response!.decision).toBe("approve");
	});
});

// ============================================================================
// Integration: gate file paths
// ============================================================================

describe("Gate file paths", () => {
	it("gate file path uses per-agent naming", () => {
		const filePath = gateFilePath(stateDir, "myAgent");
		expect(filePath).toBe(path.join(stateDir, "gate-myAgent.json"));
	});

	it("gate response path uses per-agent naming", () => {
		const filePath = gateResponsePath(stateDir, "myAgent");
		expect(filePath).toBe(path.join(stateDir, "gate-response-myAgent.json"));
	});

	it("pending question path uses per-agent naming", () => {
		const filePath = pendingQuestionPath(stateDir, "myAgent");
		expect(filePath).toBe(path.join(stateDir, "pending-question-myAgent.md"));
	});
});
