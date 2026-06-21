import { describe, expect, it } from "bun:test";
import type { Client } from "@libsql/client";
import type { AgentSession } from "../../session/agent-session";
import type { CodemapConfig } from "../config";
import { getCodemapSessionState, hasFirstTurnInjected, markFirstTurnInjected, setCodemapSessionState } from "../state";

// Minimal stand-in for AgentSession — state.ts only reads/writes a Symbol-keyed
// property, so a plain object suffices.
function makeSession(): AgentSession {
	return {} as AgentSession;
}

function makeConfig(): CodemapConfig {
	return {
		enabled: true,
		autoInject: true,
		dbPath: "/tmp/codemap.db",
		tokenBudget: 8000,
		maxResults: 20,
		maxSummaryChars: 1000,
		turso: { syncUrl: "", authToken: "", autoProvision: false, org: "" },
		embedding: {
			model: "BAAI/bge-base-en-v1.5",
			variant: "en",
			apiUrl: undefined,
			apiKey: undefined,
			dimensions: 768,
		},
	};
}

function makeClient(): Client {
	return {} as Client;
}

describe("codemap state — getCodemapSessionState", () => {
	it("returns undefined for a fresh session with no state set", () => {
		expect(getCodemapSessionState(makeSession())).toBeUndefined();
	});

	it("returns undefined when session is undefined", () => {
		expect(getCodemapSessionState(undefined)).toBeUndefined();
	});
});

describe("codemap state — setCodemapSessionState roundtrip", () => {
	it("stores state and getCodemapSessionState returns it", () => {
		const session = makeSession();
		const state = {
			client: makeClient(),
			config: makeConfig(),
			hasInjectedForFirstTurn: false,
		};
		setCodemapSessionState(session, state);
		expect(getCodemapSessionState(session)).toBe(state);
	});

	it("returns the previous state when overwriting", () => {
		const session = makeSession();
		const first = {
			client: makeClient(),
			config: makeConfig(),
			hasInjectedForFirstTurn: false,
		};
		const second = {
			client: makeClient(),
			config: makeConfig(),
			hasInjectedForFirstTurn: true,
		};
		setCodemapSessionState(session, first);
		const previous = setCodemapSessionState(session, second);
		expect(previous).toBe(first);
		expect(getCodemapSessionState(session)).toBe(second);
	});

	it("clears state when passed undefined and returns previous", () => {
		const session = makeSession();
		const state = {
			client: makeClient(),
			config: makeConfig(),
			hasInjectedForFirstTurn: false,
		};
		setCodemapSessionState(session, state);
		const previous = setCodemapSessionState(session, undefined);
		expect(previous).toBe(state);
		expect(getCodemapSessionState(session)).toBeUndefined();
	});
});

describe("codemap state — first-turn injection flag", () => {
	it("hasFirstTurnInjected returns false when no state exists", () => {
		expect(hasFirstTurnInjected(makeSession())).toBe(false);
	});

	it("hasFirstTurnInjected returns false initially when state exists", () => {
		const session = makeSession();
		setCodemapSessionState(session, {
			client: makeClient(),
			config: makeConfig(),
			hasInjectedForFirstTurn: false,
		});
		expect(hasFirstTurnInjected(session)).toBe(false);
	});

	it("markFirstTurnInjected flips the flag to true", () => {
		const session = makeSession();
		setCodemapSessionState(session, {
			client: makeClient(),
			config: makeConfig(),
			hasInjectedForFirstTurn: false,
		});
		markFirstTurnInjected(session);
		expect(hasFirstTurnInjected(session)).toBe(true);
	});

	it("markFirstTurnInjected is a no-op when no state exists", () => {
		const session = makeSession();
		markFirstTurnInjected(session); // must not throw
		expect(hasFirstTurnInjected(session)).toBe(false);
	});
});
