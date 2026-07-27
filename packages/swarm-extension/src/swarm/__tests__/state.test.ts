import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { StateTracker } from "../state";

let workspace: string;

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "swarm-state-test-"));
});

afterEach(async () => {
	await fs.rm(workspace, { recursive: true, force: true });
});

// ============================================================================
// K1 — resolvedModel field persists to pipeline.json
// ============================================================================
describe("StateTracker — resolvedModel per agent (K1)", () => {
	it("persists resolvedModel in pipeline.json after agent update", async () => {
		const tracker = new StateTracker(workspace, "observability-test");
		await tracker.init(["coder"], 1, "sequential");

		// Simulate executor capturing the resolved model from SingleResult
		await tracker.updateAgent("coder", {
			status: "completed",
			resolvedModel: "anthropic/claude-sonnet-4-20250514",
		});

		// Read the persisted JSON directly from disk
		const raw = await fs.readFile(
			path.join(workspace, ".swarm_observability-test", "state", "pipeline.json"),
			"utf-8",
		);
		const persisted = JSON.parse(raw);

		expect(persisted.agents.coder.resolvedModel).toBe("anthropic/claude-sonnet-4-20250514");
	});

	it("allows resolvedModel to be omitted when not available", async () => {
		const tracker = new StateTracker(workspace, "no-model-test");
		await tracker.init(["reviewer"], 1, "sequential");

		await tracker.updateAgent("reviewer", {
			status: "completed",
		});

		const raw = await fs.readFile(
			path.join(workspace, ".swarm_no-model-test", "state", "pipeline.json"),
			"utf-8",
		);
		const persisted = JSON.parse(raw);

		// resolvedModel should simply not appear or be undefined
		expect(persisted.agents.reviewer.resolvedModel).toBeUndefined();
	});
});

// ============================================================================
// K2 — gateStatus tracking: paused → resolved
// ============================================================================
describe("StateTracker — gateStatus per agent (K2)", () => {
	it("records gateStatus as paused when agent hits a gate", async () => {
		const tracker = new StateTracker(workspace, "gate-test");
		await tracker.init(["approver"], 1, "sequential");

		await tracker.updateAgent("approver", {
			status: "completed",
			gateStatus: { paused: true },
		});

		const raw = await fs.readFile(
			path.join(workspace, ".swarm_gate-test", "state", "pipeline.json"),
			"utf-8",
		);
		const persisted = JSON.parse(raw);

		expect(persisted.agents.approver.gateStatus).toEqual({ paused: true });
	});

	it("flips gateStatus to resolved when human responds", async () => {
		const tracker = new StateTracker(workspace, "gate-resolve-test");
		await tracker.init(["approver"], 1, "sequential");

		// Phase 1: agent completes, gate is paused
		await tracker.updateAgent("approver", {
			status: "completed",
			gateStatus: { paused: true },
		});

		let raw = await fs.readFile(
			path.join(workspace, ".swarm_gate-resolve-test", "state", "pipeline.json"),
			"utf-8",
		);
		expect(JSON.parse(raw).agents.approver.gateStatus).toEqual({ paused: true });

		// Phase 2: human resolves the gate
		await tracker.updateAgent("approver", {
			gateStatus: { paused: false, resolvedAction: "approve" },
		});

		raw = await fs.readFile(
			path.join(workspace, ".swarm_gate-resolve-test", "state", "pipeline.json"),
			"utf-8",
		);
		const persisted = JSON.parse(raw);

		expect(persisted.agents.approver.gateStatus.paused).toBe(false);
		expect(persisted.agents.approver.gateStatus.resolvedAction).toBe("approve");
	});
});
