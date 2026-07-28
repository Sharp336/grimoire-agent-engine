/**
 * Self-hosted rotation test site for C3. A tiny Bun.serve() app with a
 * login form, session cookie, and change-password form backed by an
 * in-memory account store. FAKE credentials only.
 */

export interface RotationTestSite {
	url: string;
	port: number;
	/** Current password in the site store (test-only backdoor; never log it). */
	getPassword(): string;
	setPassword(value: string): void;
	/** When true, POST /account/password rejects the next change attempt. */
	rejectNextChange: boolean;
	/** When true, logins with the post-change password fail (to exercise revert). */
	rejectNewLogins: boolean;
	stop(): Promise<void>;
}

export interface RotationTestSiteOptions {
	initialPassword?: string;
	username?: string;
}

const LOGIN_PAGE = `<!doctype html><html><body>
<h1>Sign in</h1>
<form method="post" action="/login">
	<input id="username" name="username" type="text" />
	<input id="password" name="password" type="password" />
	<button type="submit">Sign in</button>
</form>
</body></html>`;

const CHANGE_PAGE = `<!doctype html><html><body>
<h1>Change password</h1>
<form method="post" action="/account/password">
	<input id="current" name="current" type="password" />
	<input id="new" name="new" type="password" />
	<input id="confirm" name="confirm" type="password" />
	<button type="submit">Change</button>
</form>
</body></html>`;

export const CHANGE_SUCCESS_MARKER = "Password changed successfully";
export const LOGIN_FAILURE_MARKER = "Invalid credentials";

export async function startRotationTestSite(opts?: RotationTestSiteOptions): Promise<RotationTestSite> {
	const store = {
		username: opts?.username ?? "alice",
		password: opts?.initialPassword ?? "old-fake-pw-12345678",
	};
	const state = {
		rejectNextChange: false,
		rejectNewLogins: false,
		sessions: new Set<string>(),
	};

	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			const cookie = req.headers.get("cookie") ?? "";
			const authed = [...state.sessions].some(token => cookie.includes(`sid=${token}`));

			if (url.pathname === "/login" && req.method === "GET") {
				return new Response(LOGIN_PAGE, { headers: { "content-type": "text/html" } });
			}
			if (url.pathname === "/login" && req.method === "POST") {
				return req.formData().then(form => {
					const username = String(form.get("username") ?? "");
					const password = String(form.get("password") ?? "");
					const isOld = username === store.username && password === store.password;
					if (isOld && !state.rejectNewLogins) {
						const token = crypto.randomUUID();
						state.sessions.add(token);
						return new Response(null, {
							status: 302,
							headers: { location: "/account", "set-cookie": `sid=${token}; Path=/` },
						});
					}
					return new Response(LOGIN_FAILURE_MARKER, { status: 401 });
				});
			}
			if (url.pathname === "/account" && req.method === "GET") {
				if (!authed) return new Response("unauthorized", { status: 401 });
				return new Response("<html><body><h1>Account</h1></body></html>", {
					headers: { "content-type": "text/html" },
				});
			}
			if (url.pathname === "/account/password" && req.method === "GET") {
				if (!authed) return new Response("unauthorized", { status: 401 });
				return new Response(CHANGE_PAGE, { headers: { "content-type": "text/html" } });
			}
			if (url.pathname === "/account/password" && req.method === "POST") {
				if (!authed) return new Response("unauthorized", { status: 401 });
				return req.formData().then(form => {
					const current = String(form.get("current") ?? "");
					const next = String(form.get("new") ?? "");
					const confirm = String(form.get("confirm") ?? "");
					if (state.rejectNextChange) {
						state.rejectNextChange = false;
						return new Response("Change rejected by site policy", { status: 403 });
					}
					if (current !== store.password) {
						return new Response("Current password incorrect", { status: 403 });
					}
					if (next !== confirm || next.length === 0) {
						return new Response("New passwords do not match", { status: 400 });
					}
					store.password = next;
					return new Response(CHANGE_SUCCESS_MARKER, { status: 200 });
				});
			}
			return new Response("not found", { status: 404 });
		},
	});

	const port = server.port ?? 0;
	return {
		url: `http://127.0.0.1:${port}`,
		port,
		getPassword: () => store.password,
		setPassword: value => {
			store.password = value;
		},
		get rejectNextChange() {
			return state.rejectNextChange;
		},
		set rejectNextChange(value: boolean) {
			state.rejectNextChange = value;
		},
		get rejectNewLogins() {
			return state.rejectNewLogins;
		},
		set rejectNewLogins(value: boolean) {
			state.rejectNewLogins = value;
		},
		stop: async () => {
			server.stop(true);
		},
	};
}
