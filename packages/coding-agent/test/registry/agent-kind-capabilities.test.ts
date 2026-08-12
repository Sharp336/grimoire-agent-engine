/**
 * Contract: the AgentKind capability taxonomy — the single source of truth for the
 * class differences callers care about (peer vs local-session vs local-presence).
 * Locks each kind's membership so changing a predicate, or adding a kind, is a
 * deliberate, tested decision rather than a silently-leaking denylist.
 */
import { describe, expect, it } from "bun:test";
import {
	type AgentKind,
	type AgentRef,
	type AgentStatus,
	hasLocalPresence,
	isLocalSession,
	isMessageablePeer,
	isWaitablePeer,
} from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

const KINDS: AgentKind[] = ["main", "sub", "advisor", "remote"];

describe("AgentKind capability taxonomy", () => {
	it("isMessageablePeer — roster + broadcast peers are everything but advisor", () => {
		expect(KINDS.filter(isMessageablePeer)).toEqual(["main", "sub", "remote"]);
	});

	it("isLocalSession — locally-managed sessions are main | sub only", () => {
		expect(KINDS.filter(isLocalSession)).toEqual(["main", "sub"]);
	});

	it("hasLocalPresence — a local session or transcript excludes only remote proxies", () => {
		expect(KINDS.filter(hasLocalPresence)).toEqual(["main", "sub", "advisor"]);
	});

	it("remote is a peer but neither a local session nor locally present", () => {
		expect(isMessageablePeer("remote")).toBe(true);
		expect(isLocalSession("remote")).toBe(false);
		expect(hasLocalPresence("remote")).toBe(false);
	});

	it("advisor is locally present (read-only) but never a peer or a managed session", () => {
		expect(isMessageablePeer("advisor")).toBe(false);
		expect(isLocalSession("advisor")).toBe(false);
		expect(hasLocalPresence("advisor")).toBe(true);
	});
});

describe("isWaitablePeer (kind + status)", () => {
	const ref = (kind: AgentKind, status: AgentStatus): AgentRef => ({
		id: "x",
		displayName: "x",
		kind,
		status,
		session: null,
		sessionFile: null,
		createdAt: 0,
		lastActivity: 0,
	});

	it("a running local peer is waitable; an idle local peer is not", () => {
		expect(isWaitablePeer(ref("sub", "running"))).toBe(true);
		expect(isWaitablePeer(ref("sub", "idle"))).toBe(false);
	});

	it("a live remote proxy is waitable regardless of local status", () => {
		expect(isWaitablePeer(ref("remote", "idle"))).toBe(true);
		expect(isWaitablePeer(ref("remote", "running"))).toBe(true);
	});

	it("aborted or advisor peers are not waitable", () => {
		expect(isWaitablePeer(ref("sub", "aborted"))).toBe(false);
		expect(isWaitablePeer(ref("advisor", "idle"))).toBe(false);
	});
});
