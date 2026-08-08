import { describe, expect, test } from "bun:test";
import { RpcSessionAuthorityCoordinator } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-authority";

describe("RpcSessionAuthorityCoordinator", () => {
	test("fences admission and invalidates stale continuations before session cancellation", async () => {
		let sessionId = "session-1";
		const authority = new RpcSessionAuthorityCoordinator(() => sessionId);
		const stale = authority.capture();
		const deferred = Promise.withResolvers<void>();
		let mutations = 0;
		const continuation = deferred.promise.then(() => {
			if (authority.isCurrent(stale)) mutations += 1;
		});

		const transition = authority.beginSessionTransition();
		expect(authority.transitioning).toBeTrue();
		expect(authority.isCurrent(stale)).toBeFalse();
		expect(() => authority.capture()).toThrow(expect.objectContaining({ code: "session_busy" }));
		expect(authority.captureLifecycleAuthority()).toEqual(stale);

		deferred.resolve();
		await continuation;
		expect(mutations).toBe(0);

		sessionId = "session-2";
		const current = authority.completeSessionTransition(transition);
		expect(current).toEqual({
			sessionId: "session-2",
			sessionGeneration: 1,
			authorityGeneration: 1,
		});
		expect(Object.isFrozen(current)).toBeTrue();
		expect(() => authority.assertCurrent(stale)).toThrow(expect.objectContaining({ code: "session_changed" }));
	});

	test("failed session admission preserves the previously committed generation", () => {
		const authority = new RpcSessionAuthorityCoordinator(() => "session-1");
		const admitted = authority.capture();
		const transition = authority.beginSessionTransition();

		authority.failSessionTransition(transition);
		const current = authority.capture();

		expect(current).toEqual(admitted);
		expect(authority.isCurrent(admitted)).toBeTrue();
	});

	test("failed teardown invalidates execution authority without changing the session generation", () => {
		const authority = new RpcSessionAuthorityCoordinator(() => "session-1");
		const admitted = authority.capture();
		const transition = authority.beginSessionTransition();

		const current = authority.invalidateSessionTransitionAuthority(transition);

		expect(current).toEqual({
			sessionId: admitted.sessionId,
			sessionGeneration: admitted.sessionGeneration,
			authorityGeneration: admitted.authorityGeneration + 1,
		});
		expect(authority.isCurrent(admitted)).toBeFalse();
		expect(() => authority.assertCurrent(admitted)).toThrow(expect.objectContaining({ code: "authority_changed" }));
	});

	test("failed mutation advances session authority when identity changed before the error", () => {
		let sessionId = "session-1";
		const authority = new RpcSessionAuthorityCoordinator(() => sessionId);
		const transition = authority.beginSessionTransition();
		sessionId = "session-2";

		const current = authority.invalidateSessionTransitionAuthority(transition);

		expect(current).toEqual({
			sessionId: "session-2",
			sessionGeneration: 1,
			authorityGeneration: 1,
		});
	});

	test("collaboration authority changes preserve session identity while invalidating privileges", () => {
		const authority = new RpcSessionAuthorityCoordinator(() => "session-1");
		const stale = authority.capture();
		const transition = authority.beginExecutionAuthorityTransition();

		expect(authority.isCurrent(stale)).toBeFalse();
		expect(authority.captureLifecycleAuthority()).toEqual(stale);
		const current = authority.completeExecutionAuthorityTransition(transition);

		expect(current.sessionId).toBe(stale.sessionId);
		expect(current.sessionGeneration).toBe(stale.sessionGeneration);
		expect(current.authorityGeneration).toBe(stale.authorityGeneration + 1);
		expect(() => authority.assertCurrent(stale)).toThrow(expect.objectContaining({ code: "authority_changed" }));
	});

	test("failed collaboration admission preserves the previous authority", () => {
		const authority = new RpcSessionAuthorityCoordinator(() => "session-1");
		const admitted = authority.capture();
		const transition = authority.beginExecutionAuthorityTransition();

		authority.failExecutionAuthorityTransition(transition);

		expect(authority.capture()).toEqual(admitted);
		expect(authority.isCurrent(admitted)).toBeTrue();
	});

	test("rejects stale transition completion", () => {
		const authority = new RpcSessionAuthorityCoordinator(() => "session-1");
		const first = authority.beginSessionTransition();
		authority.failSessionTransition(first);
		const second = authority.beginSessionTransition();

		expect(() => authority.completeSessionTransition(first)).toThrow(
			expect.objectContaining({ code: "session_changed" }),
		);
		authority.completeSessionTransition(second);
	});
});
