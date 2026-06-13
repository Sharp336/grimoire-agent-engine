import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatHashlineHeader, Patch } from "@oh-my-pi/hashline";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { enforcePlanModeWrite, resolvePlanPath } from "@oh-my-pi/pi-coding-agent/tools/plan-mode-guard";

interface SessionOverrides {
	artifactsDir?: string | null;
	sessionId?: string | null;
	cwd?: string;
	planMode?: PlanModeState;
}

function makeSession(overrides: SessionOverrides): ToolSession {
	return {
		cwd: overrides.cwd ?? "/repo",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: {
			getPlansDirectory: () => "/plans",
		},
		getArtifactsDir: () => overrides.artifactsDir ?? null,
		getSessionId: () => overrides.sessionId ?? null,
		getPlanModeState: () => overrides.planMode,
	} as unknown as ToolSession;
}

describe("resolvePlanPath local:// support", () => {
	it("resolves local:// paths under session artifacts local root", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", sessionId: "abc" });
		expect(resolvePlanPath(session, "local://handoffs/result.json")).toBe(
			path.join("/tmp/agent-artifacts", "local", "handoffs", "result.json"),
		);
	});

	it("falls back to os tmp root when artifacts dir is unavailable", () => {
		const session = makeSession({ artifactsDir: null, sessionId: "session-42" });
		expect(resolvePlanPath(session, "local://memo.txt")).toBe(
			path.join(os.tmpdir(), "omp-local", "session-42", "memo.txt"),
		);
	});
});

describe("resolvePlanPath resolves literally (no plan-mode redirect)", () => {
	const planMode: PlanModeState = { enabled: true, planFilePath: "local://some-plan.md" };

	it("resolves a bare path against cwd regardless of plan mode", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", cwd: "/repo", planMode });
		expect(resolvePlanPath(session, "PLAN.md")).toBe(path.join("/repo", "PLAN.md"));
		expect(resolvePlanPath(session, "src/foo.ts")).toBe(path.join("/repo", "src/foo.ts"));
	});

	it("resolves a local:// plan file to the session local root", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", planMode });
		expect(resolvePlanPath(session, "local://some-plan.md")).toBe(
			path.join("/tmp/agent-artifacts", "local", "some-plan.md"),
		);
	});
});

describe("enforcePlanModeWrite (working tree read-only, local:// sandbox writable)", () => {
	const planMode: PlanModeState = { enabled: true, planFilePath: "local://some-plan.md" };

	it("accepts writes to any local:// file", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", planMode });
		expect(() => enforcePlanModeWrite(session, "local://auth-refactor-plan.md", { op: "create" })).not.toThrow();
		expect(() => enforcePlanModeWrite(session, "local://scratch/notes.md", { op: "update" })).not.toThrow();
	});

	it("rejects writes to the working tree", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", cwd: "/repo", planMode });
		expect(() => enforcePlanModeWrite(session, "src/foo.ts", { op: "update" })).toThrow(/working tree is read-only/);
		expect(() => enforcePlanModeWrite(session, "PLAN.md", { op: "create" })).toThrow(/working tree is read-only/);
	});

	it("rejects deletes and renames outright", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", planMode });
		expect(() => enforcePlanModeWrite(session, "local://some-plan.md", { op: "delete" })).toThrow(
			/deleting files is not allowed/,
		);
		expect(() => enforcePlanModeWrite(session, "local://some-plan.md", { move: "local://renamed.md" })).toThrow(
			/renaming files is not allowed/,
		);
	});

	it("is a no-op when plan mode is disabled", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", cwd: "/repo" });
		expect(() => enforcePlanModeWrite(session, "src/foo.ts", { op: "update" })).not.toThrow();
	});
});

describe("enforcePlanModeWrite accepts absolute local-sandbox paths", () => {
	const planMode: PlanModeState = { enabled: true, planFilePath: "local://some-plan.md" };

	it("allows the absolute path returned by `read local://...` (== sandbox-resolved path)", async () => {
		// Use an existing tmp directory so the realpath check inside the guard
		// sees a real filesystem (macOS collapses /tmp -> /private/tmp etc.).
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-guard-test-"));
		const session = makeSession({ artifactsDir, planMode });
		const absolute = resolvePlanPath(session, "local://my-plan.md");
		expect(() => enforcePlanModeWrite(session, absolute, { op: "update" })).not.toThrow();
	});

	it("allows the absolute plan path carrying a hashline #TAG (edit-header residue)", async () => {
		// `edit` forwards the literal `[PATH#TAG]` header; a trailing `#tag`
		// must not knock the path out of sandbox membership.
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-guard-test-"));
		const session = makeSession({ artifactsDir, planMode });
		const absolute = resolvePlanPath(session, "local://my-plan.md");
		expect(() => enforcePlanModeWrite(session, `${absolute}#1A2B`, { op: "update" })).not.toThrow();
	});

	it("allows the absolute plan path carrying a read line-range selector", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-guard-test-"));
		const session = makeSession({ artifactsDir, planMode });
		const absolute = resolvePlanPath(session, "local://my-plan.md");
		expect(() => enforcePlanModeWrite(session, `${absolute}:10-20`, { op: "update" })).not.toThrow();
	});

	it("still rejects an absolute path outside the local sandbox", () => {
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", cwd: "/repo", planMode });
		expect(() => enforcePlanModeWrite(session, "/repo/src/foo.ts", { op: "update" })).toThrow(
			/working tree is read-only/,
		);
	});

	it("allows a realpath-form plan path under a symlinked sandbox root", async () => {
		// Reproduces the macOS `/tmp` ↔ `/private/tmp` (and any symlinked
		// artifacts dir) hazard: the session resolves its sandbox through a
		// symlink while `read local://…` echoes the realpath in the edit header.
		// Membership must survive via realpath resolution, not a literal prefix —
		// the lexical prefix check fails here, so this exercises the realpath branch.
		const realBase = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "plan-guard-real-")));
		const realLocal = path.join(realBase, "local");
		await fs.mkdir(realLocal, { recursive: true });
		const linkBase = `${realBase}-link`;
		await fs.symlink(realBase, linkBase);
		const session = makeSession({ artifactsDir: linkBase, planMode });
		const realPlanPath = path.join(realLocal, "design-plan.md");
		await fs.writeFile(realPlanPath, "# plan\n");
		expect(() => enforcePlanModeWrite(session, realPlanPath, { op: "update" })).not.toThrow();
		// …and still allowed with the hashline #TAG the edit header carries.
		expect(() => enforcePlanModeWrite(session, `${realPlanPath}#1A2B`, { op: "update" })).not.toThrow();
	});

	it("allows the [PATH#TAG] edit header for the plan file (parse → plan-mode gate)", () => {
		// End-to-end through the real hashline parser: `read` prints
		// `[<abs-plan-path>#TAG]`, the parser splits the tag and forwards the
		// absolute, out-of-cwd path to the same gate `preflightWrite` calls.
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", cwd: "/repo", planMode });
		const absolutePlanPath = resolvePlanPath(session, "local://design-plan.md");
		const header = formatHashlineHeader(absolutePlanPath, "1A2B");
		const section = Patch.parse(`${header}\nreplace 1..1:\n+# plan\n`, { cwd: session.cwd }).sections[0];
		expect(section).toBeDefined();
		expect(section!.path).toBe(absolutePlanPath);
		expect(() => enforcePlanModeWrite(session, section!.path, { op: "update" })).not.toThrow();
	});

	it("denies a decorated absolute path outside the sandbox", () => {
		// A `#tag`/selector suffix must not let an out-of-sandbox target pass:
		// the guard authorizes the same raw path the write resolves, so the
		// decoration stays part of the (still out-of-sandbox) path.
		const session = makeSession({ artifactsDir: "/tmp/agent-artifacts", cwd: "/repo", planMode });
		expect(() => enforcePlanModeWrite(session, "/repo/src/foo.ts#1A2B", { op: "update" })).toThrow(
			/working tree is read-only/,
		);
		expect(() => enforcePlanModeWrite(session, "/repo/src/foo.ts:10-20", { op: "update" })).toThrow(
			/working tree is read-only/,
		);
	});

	it("denies a path that traverses out of the sandbox", async () => {
		const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-guard-test-"));
		const session = makeSession({ artifactsDir, planMode });
		const insideAbs = resolvePlanPath(session, "local://x.md");
		const escapes = path.join(path.dirname(insideAbs), "..", "escape.md");
		expect(() => enforcePlanModeWrite(session, escapes, { op: "update" })).toThrow(/working tree is read-only/);
	});
});
