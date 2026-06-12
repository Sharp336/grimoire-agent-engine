import { describe, expect, it } from "bun:test";
import { type ChildControlTarget, DirectChildControl } from "@oh-my-pi/pi-coding-agent/agent-control/control";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry, type AgentStatus } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

interface FakeSession {
	session: AgentSession;
	prompts: string[];
	steers: string[];
}

function makeSession(): FakeSession {
	const prompts: string[] = [];
	const steers: string[] = [];
	return {
		session: {
			prompt: async (text: string) => {
				prompts.push(text);
			},
			steer: async (text: string) => {
				steers.push(text);
			},
		} as unknown as AgentSession,
		prompts,
		steers,
	};
}

function registerChild(
	registry: AgentRegistry,
	id: string,
	sessionFile: string,
	status: AgentStatus,
	session: AgentSession | null,
): ChildControlTarget {
	registry.register({ id, displayName: id, kind: "sub", session, sessionFile, status });
	return { controlGeneration: "generation-a", id, sessionFile };
}

function createControl(): {
	registry: AgentRegistry;
	lifecycle: AgentLifecycleManager;
	control: DirectChildControl;
} {
	const registry = new AgentRegistry();
	const lifecycle = new AgentLifecycleManager(registry);
	return { registry, lifecycle, control: new DirectChildControl("generation-a", registry, lifecycle) };
}

describe("DirectChildControl", () => {
	it("steers running children and prompts idle children through exact admitted targets", async () => {
		const { registry, control } = createControl();
		const running = makeSession();
		const runningTarget = registerChild(registry, "Running", "/tmp/running.jsonl", "running", running.session);
		const idle = makeSession();
		const idleTarget = registerChild(registry, "Idle", "/tmp/idle.jsonl", "idle", idle.session);
		expect(control.admit(runningTarget)).toBe(true);
		expect(control.admit(idleTarget)).toBe(true);

		expect(await control.send(runningTarget, "adjust course")).toEqual({ ok: true, action: "steered" });
		expect(await control.send(idleTarget, "one more task")).toEqual({ ok: true, action: "prompted" });
		expect(running.steers).toEqual(["adjust course"]);
		expect(running.prompts).toEqual([]);
		expect(idle.prompts).toEqual(["one more task"]);
		expect(idle.steers).toEqual([]);
	});

	it("coalesces concurrent parked revival while delivering one prompt and one steer", async () => {
		const { registry, lifecycle, control } = createControl();
		const revived = makeSession();
		const target = registerChild(registry, "Parked", "/tmp/parked.jsonl", "parked", null);
		let revives = 0;
		const { promise: releaseRevival, resolve } = Promise.withResolvers<void>();
		lifecycle.adopt(target.id, {
			idleTtlMs: 0,
			revive: async () => {
				revives += 1;
				await releaseRevival;
				return revived.session;
			},
		});
		expect(control.admit(target)).toBe(true);

		const first = control.send(target, "first follow-up");
		const second = control.send(target, "second follow-up");
		resolve();

		expect(await Promise.all([first, second])).toEqual([
			{ ok: true, action: "revived" },
			{ ok: true, action: "steered" },
		]);
		expect(revives).toBe(1);
		expect(revived.prompts).toEqual(["first follow-up"]);
		expect(revived.steers).toEqual(["second follow-up"]);
	});

	it("fails closed for non-revivable and terminal children", async () => {
		const { registry, lifecycle, control } = createControl();
		const parked = registerChild(registry, "Parked", "/tmp/parked.jsonl", "parked", null);
		lifecycle.adopt(parked.id, { idleTtlMs: 0 });
		expect(control.admit(parked)).toBe(true);
		const abortedSession = makeSession();
		const aborted = registerChild(registry, "Aborted", "/tmp/aborted.jsonl", "aborted", abortedSession.session);
		expect(control.admit(aborted)).toBe(true);
		control.markTerminal(aborted);
		registry.unregister(aborted.id);

		expect(await control.send(parked, "wake")).toMatchObject({ ok: false, code: "not_revivable" });
		expect(await control.send(aborted, "wake")).toMatchObject({ ok: false, code: "terminal" });
		expect(abortedSession.prompts).toEqual([]);
		expect(abortedSession.steers).toEqual([]);
	});

	it("rejects unknown, foreign, stale-generation, and reused-id identity mismatches", async () => {
		const { registry, control } = createControl();
		const admittedSession = makeSession();
		const admitted = registerChild(registry, "Admitted", "/tmp/original.jsonl", "idle", admittedSession.session);
		expect(control.admit(admitted)).toBe(true);
		const foreignSession = makeSession();
		const foreign = registerChild(registry, "Nested", "/tmp/nested.jsonl", "idle", foreignSession.session);

		expect(
			await control.send(
				{ controlGeneration: "generation-a", id: "Unknown", sessionFile: "/tmp/unknown.jsonl" },
				"x",
			),
		).toMatchObject({ ok: false, code: "unknown_target" });
		expect(await control.send(foreign, "x")).toMatchObject({ ok: false, code: "foreign_target" });
		expect(await control.send({ ...admitted, controlGeneration: "generation-b" }, "x")).toMatchObject({
			ok: false,
			code: "stale_generation",
		});

		const replacement = makeSession();
		registry.register({
			id: admitted.id,
			displayName: admitted.id,
			kind: "sub",
			session: replacement.session,
			sessionFile: "/tmp/reused.jsonl",
			status: "idle",
		});
		expect(await control.send(admitted, "x")).toMatchObject({ ok: false, code: "identity_mismatch" });
		expect(replacement.prompts).toEqual([]);
	});

	it("makes every target stale when its session-scoped generation closes", async () => {
		const { registry, lifecycle, control } = createControl();
		const child = makeSession();
		const target = registerChild(registry, "Child", "/tmp/child.jsonl", "idle", child.session);
		expect(control.admit(target)).toBe(true);

		control.close();

		expect(await control.send(target, "late")).toMatchObject({ ok: false, code: "stale_generation" });
		expect(control.admit(target)).toBe(false);
		const nextControl = new DirectChildControl("generation-b", registry, lifecycle);
		expect(nextControl.admit(target)).toBe(false);
		expect(
			await nextControl.send({ ...target, controlGeneration: "generation-b" }, "cross-generation"),
		).toMatchObject({ ok: false, code: "foreign_target" });
		expect(child.prompts).toEqual([]);
	});
});
