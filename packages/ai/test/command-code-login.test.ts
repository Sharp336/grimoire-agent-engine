import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { loginCommandCode } from "@oh-my-pi/pi-ai/registry/oauth/command-code";
import type { OAuthAuthInfo } from "@oh-my-pi/pi-ai/registry/oauth/types";

/**
 * Drive the real Command Code login handshake against its real loopback
 * listener. The "provider" here is a browser, so nothing is HTTP-mocked: the
 * test IS the studio, POSTing the callback payload back to the port the login
 * advertises. `COMMANDCODE_API_ENV` is unset, so the flow targets prod.
 *
 * Cases share the fixed callback port 5959, so they must not overlap. A file-
 * level mutex serializes them even under `bun test --parallel`.
 */

type StartedLogin = {
	auth: OAuthAuthInfo;
	/** Always-handled settlement view of the login promise. */
	settled: Promise<{ ok: true; value: string } | { ok: false; error: unknown }>;
	abort: AbortController;
	callbackUrl: string;
	state: string;
	launchUrl: string;
};

/** Serialize every case — concurrent Bun.serve binds on 5959 cross-talk. */
let fileGate: Promise<void> = Promise.resolve();

function serial(run: () => Promise<void>): () => Promise<void> {
	return async () => {
		const previous = fileGate;
		const held = Promise.withResolvers<void>();
		fileGate = held.promise;
		await previous;
		try {
			await run();
		} finally {
			held.resolve();
		}
	};
}

async function startLogin(): Promise<StartedLogin> {
	const abort = new AbortController();
	const authFired = Promise.withResolvers<OAuthAuthInfo>();
	const promise = loginCommandCode({
		onAuth: info => {
			authFired.resolve(info);
		},
		onProgress: () => {},
		onPrompt: async () => "",
		signal: abort.signal,
	});
	// Attach immediately: denial rejects via `queueMicrotask`, and an unhandled
	// rejection would fail the test before assertions run.
	const settled = promise.then(
		value => ({ ok: true as const, value }),
		error => ({ ok: false as const, error }),
	);

	const auth = await authFired.promise;
	const url = new URL(auth.url);
	const callbackUrl = url.searchParams.get("callback");
	const state = url.searchParams.get("state");
	const launchUrl = auth.launchUrl;
	if (!callbackUrl || !state || !launchUrl) {
		abort.abort("test setup failed");
		await settled;
		throw new Error(`onAuth.url missing callback/state/launchUrl: ${auth.url}`);
	}
	return { auth, settled, abort, callbackUrl, state, launchUrl };
}

async function finish(login: StartedLogin): Promise<void> {
	if (!(await isSettled(login.settled))) {
		login.abort.abort("test cleanup");
	}
	await login.settled;
	// Graceful `server.stop()` needs a beat before the next case re-binds 5959.
	await Bun.sleep(25);
}

function isSettled(promise: Promise<unknown>): Promise<boolean> {
	const pending = {};
	return Promise.race([
		promise.then(
			() => null,
			() => null,
		),
		Promise.resolve(pending),
	]).then(value => value !== pending);
}

function validPayload(state: string, apiKey = "sk-command-code-test"): object {
	return { apiKey, state, userId: "u-123", userName: "test-user", keyName: "omp" };
}

async function postJson(url: string, body: unknown): Promise<Response> {
	return fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			// Bun's fetch keep-alive can pin an in-process connection to a
			// stopped Bun.serve listener across rebinds of the same port.
			connection: "close",
		},
		body: JSON.stringify(body),
	});
}

describe("command-code browser login", () => {
	it(
		"resolves with the posted API key on a valid studio callback",
		serial(async () => {
			const login = await startLogin();
			try {
				const callback = new URL(login.callbackUrl);
				expect(callback.protocol).toBe("http:");
				expect(callback.hostname).toBe("localhost");
				expect(callback.pathname).toBe("/callback");

				const response = await postJson(login.callbackUrl, validPayload(login.state));
				expect(response.status).toBe(200);
				expect(await response.json()).toEqual({ success: true });

				await expect(login.settled).resolves.toEqual({ ok: true, value: "sk-command-code-test" });
				// `/launch` is gated by an unguessable token so a local process
				// cannot learn the state-bearing auth URL from it.
				const launch = new URL(login.launchUrl);
				expect(launch.origin).toBe(callback.origin);
				expect(launch.pathname).toBe("/launch");
				expect(launch.searchParams.get("token")).toBeTruthy();
			} finally {
				await finish(login);
			}
		}),
	);

	it(
		"rejects a forged POST with a wrong state without settling the login",
		serial(async () => {
			const login = await startLogin();
			try {
				const forged = await postJson(login.callbackUrl, validPayload("forged-state"));
				expect(forged.status).toBe(403);

				// A rejected POST must neither win nor cancel the login.
				await Bun.sleep(50);
				expect(await isSettled(login.settled)).toBe(false);

				const real = await postJson(login.callbackUrl, validPayload(login.state, "sk-real-key"));
				expect(real.status).toBe(200);
				await expect(login.settled).resolves.toEqual({ ok: true, value: "sk-real-key" });
			} finally {
				await finish(login);
			}
		}),
	);

	it(
		"rejects a state-less denial without cancelling the login",
		serial(async () => {
			const login = await startLogin();
			try {
				// A forged `{ error: "access_denied" }` without the random state must
				// not settle (cancel) the pending login — state is checked first.
				const forged = await postJson(login.callbackUrl, {
					error: "access_denied",
					error_description: "Denied",
				});
				expect(forged.status).toBe(403);
				await Bun.sleep(50);
				expect(await isSettled(login.settled)).toBe(false);

				const real = await postJson(login.callbackUrl, validPayload(login.state, "sk-real-key"));
				expect(real.status).toBe(200);
				await expect(login.settled).resolves.toEqual({ ok: true, value: "sk-real-key" });
			} finally {
				await finish(login);
			}
		}),
	);

	it(
		"maps a studio denial with a valid state to a LoginCancelledError",
		serial(async () => {
			const login = await startLogin();
			try {
				const response = await postJson(login.callbackUrl, {
					state: login.state,
					error: "access_denied",
					error_description: "Denied",
				});
				expect(response.status).toBe(200);

				const outcome = await login.settled;
				expect(outcome.ok).toBe(false);
				if (outcome.ok) throw new Error("expected rejection");
				expect(outcome.error).toBeInstanceOf(AIError.LoginCancelledError);
				expect((outcome.error as Error).message).toBe("Denied");
			} finally {
				await finish(login);
			}
		}),
	);

	it(
		"302-redirects /launch to the studio URL while the login is active",
		serial(async () => {
			const login = await startLogin();
			try {
				// `redirect: "manual"` keeps the 302 header-visible so we never touch
				// the studio origin during the test.
				const response = await fetch(login.launchUrl, { redirect: "manual", headers: { connection: "close" } });
				expect(response.status).toBe(302);
				expect(response.headers.get("location")).toBe(login.auth.url);

				await postJson(login.callbackUrl, validPayload(login.state));
				await expect(login.settled).resolves.toEqual({ ok: true, value: "sk-command-code-test" });
			} finally {
				await finish(login);
			}
		}),
	);

	it(
		"does not expose the state-bearing auth URL to token-less /launch requests",
		serial(async () => {
			const login = await startLogin();
			try {
				const origin = new URL(login.launchUrl).origin;
				// Any local process can probe the loopback listener; without the
				// minted launch token it must get a plain 404 — no redirect, and
				// therefore no way to read `state` out of the Location header.
				const probe = await fetch(`${origin}/launch`, { redirect: "manual", headers: { connection: "close" } });
				expect(probe.status).toBe(404);
				expect(probe.headers.get("location")).toBeNull();

				// The probe must not disrupt the real handshake.
				await postJson(login.callbackUrl, validPayload(login.state));
				await expect(login.settled).resolves.toEqual({ ok: true, value: "sk-command-code-test" });
			} finally {
				await finish(login);
			}
		}),
	);

	it(
		"rejects /launch with a wrong token without settling the login",
		serial(async () => {
			const login = await startLogin();
			try {
				const launch = new URL(login.launchUrl);
				launch.searchParams.set("token", "forged-token");
				const probe = await fetch(launch, { redirect: "manual", headers: { connection: "close" } });
				expect(probe.status).toBe(404);
				expect(probe.headers.get("location")).toBeNull();

				// The real callback still wins with the correct state.
				await postJson(login.callbackUrl, validPayload(login.state));
				await expect(login.settled).resolves.toEqual({ ok: true, value: "sk-command-code-test" });
			} finally {
				await finish(login);
			}
		}),
	);
});
