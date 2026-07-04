import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	checkWorkspaceGuard,
	type WorkspaceGuardDecision,
} from "@oh-my-pi/pi-coding-agent/tools/workspace-guard";

const createdRoots: string[] = [];

async function makeTempWorkspace(): Promise<{ root: string; outsideRoot: string }> {
	const base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workspace-guard-"));
	createdRoots.push(base);

	const root = path.join(base, "workspace");
	const outsideRoot = path.join(base, "outside");
	await fs.mkdir(path.join(root, "src"), { recursive: true });
	await fs.mkdir(outsideRoot, { recursive: true });

	return { root, outsideRoot };
}

function expectAllowed(decision: WorkspaceGuardDecision): asserts decision is WorkspaceGuardDecision & { allowed: true } {
	expect(decision).toMatchObject({ allowed: true });
}

function expectBlocked(
	decision: WorkspaceGuardDecision,
	code: "missing_workspace_binding" | "target_outside_workspace" | "cwd_outside_workspace",
): asserts decision is WorkspaceGuardDecision & { allowed: false } {
	expect(decision).toMatchObject({ allowed: false, code });
	expect(decision.message).toContain("workspace");
}

afterEach(async () => {
	await Promise.all(createdRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("workspace mutating-tool guard", () => {
	it("allows a mutating file target that resolves inside the bound workspace", async () => {
		const { root } = await makeTempWorkspace();
		const target = path.join("src", "allowed.ts");

		const decision = await checkWorkspaceGuard({
			access: "mutate",
			toolName: "write",
			workspaceRoot: root,
			sessionCwd: root,
			targetPath: target,
		});

		expectAllowed(decision);
		expect(decision.resolvedWorkspaceRoot).toBe(await fs.realpath(root));
		expect(decision.resolvedTargetPath).toBe(path.join(await fs.realpath(root), target));
	});

	it("blocks a mutating file target outside the bound workspace", async () => {
		const { root, outsideRoot } = await makeTempWorkspace();
		const outsideFile = path.join(outsideRoot, "outside.ts");

		const decision = await checkWorkspaceGuard({
			access: "mutate",
			toolName: "write",
			workspaceRoot: root,
			sessionCwd: root,
			targetPath: outsideFile,
		});

		expectBlocked(decision, "target_outside_workspace");
		expect(decision.toolName).toBe("write");
		expect(decision.resolvedWorkspaceRoot).toBe(await fs.realpath(root));
		expect(decision.resolvedTargetPath).toBe(path.join(await fs.realpath(outsideRoot), "outside.ts"));
	});

	it("blocks mutating file targets that escape through '..' or a symlink", async () => {
		const { root, outsideRoot } = await makeTempWorkspace();
		const outsideFile = path.join(outsideRoot, "escaped.ts");
		await fs.writeFile(outsideFile, "export const escaped = true;\n");

		const symlinkPath = path.join(root, "src", "linked-outside.ts");
		await fs.symlink(outsideFile, symlinkPath);

		const escapingTargets = [
			path.join("..", "outside", "escaped.ts"),
			path.join("src", "linked-outside.ts"),
		];

		for (const targetPath of escapingTargets) {
			const decision = await checkWorkspaceGuard({
				access: "mutate",
				toolName: "edit",
				workspaceRoot: root,
				sessionCwd: root,
				targetPath,
			});

			expectBlocked(decision, "target_outside_workspace");
		}
	});

	it("blocks bash and eval when the requested cwd resolves outside the bound workspace", async () => {
		const { root, outsideRoot } = await makeTempWorkspace();

		const cases: Array<{ toolName: "bash" | "eval"; requestedCwd: string }> = [
			{ toolName: "bash", requestedCwd: outsideRoot },
			{ toolName: "eval", requestedCwd: path.join("..", "outside") },
		];

		for (const testCase of cases) {
			const decision = await checkWorkspaceGuard({
				access: "mutate",
				toolName: testCase.toolName,
				workspaceRoot: root,
				sessionCwd: root,
				requestedCwd: testCase.requestedCwd,
			});

			expectBlocked(decision, "cwd_outside_workspace");
			expect(decision.toolName).toBe(testCase.toolName);
		}
	});

	it("requires a workspace binding for mutating tools but permits read-only tools without one", async () => {
		const { root, outsideRoot } = await makeTempWorkspace();

		const mutatingDecision = await checkWorkspaceGuard({
			access: "mutate",
			toolName: "write",
			workspaceRoot: null,
			sessionCwd: root,
			targetPath: path.join(root, "src", "blocked-without-binding.ts"),
		});

		expectBlocked(mutatingDecision, "missing_workspace_binding");
		expect(mutatingDecision.toolName).toBe("write");

		const readOnlyDecision = await checkWorkspaceGuard({
			access: "read",
			toolName: "read",
			workspaceRoot: null,
			sessionCwd: root,
			targetPath: path.join(outsideRoot, "readable.txt"),
		});

		expectAllowed(readOnlyDecision);
	});
});
