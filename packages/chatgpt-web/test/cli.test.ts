import { describe, expect, test } from "bun:test";
import type { LoginHost } from "../src/browser/login-host";
import { type ChatGptWebCliDependencies, type ChatGptWebCliIo, runChatGptWebCli } from "../src/cli";
import type { SecureConfigHost } from "../src/config";
import { NativeLocalRuntimeUnavailableError } from "../src/runtime/native-local-runtime";

const secureHost = { available: true } as SecureConfigHost;
const loginHost: LoginHost = {
	async login(): Promise<never> {
		throw new Error("not called directly");
	},
	async close(): Promise<void> {},
};

function harness(): { io: ChatGptWebCliIo; stdout: string[]; stderr: string[] } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		stdout,
		stderr,
		io: {
			writeOut(text): void {
				stdout.push(text);
			},
			writeErr(text): void {
				stderr.push(text);
			},
		},
	};
}

function dependencies(overrides: Partial<ChatGptWebCliDependencies> = {}): ChatGptWebCliDependencies {
	return {
		secureHost,
		createLoginHost: () => loginHost,
		async setup(options) {
			return {
				config:
					options.mode === "full"
						? { mode: "full", tunnelId: options.tunnelId ?? null, runtimeKeyConfigured: true }
						: { mode: "browser-only", tunnelId: null, runtimeKeyConfigured: false },
			};
		},
		async login() {
			return { authenticated: true, proAvailable: false, verifiedAt: "2026-08-02T12:00:00.000Z" };
		},
		async readConfig() {
			return { mode: "browser-only", tunnelId: null, runtimeKeyConfigured: false };
		},
		async readLoginStatus() {
			return null;
		},
		async uninstall() {},
		...overrides,
	};
}

describe("ChatGPT Web CLI", () => {
	test("dispatches browser-only and full setup without echoing key paths or tunnel ids", async () => {
		const calls: unknown[] = [];
		const deps = dependencies({
			async setup(options) {
				calls.push(options);
				return {
					config:
						options.mode === "full"
							? { mode: "full", tunnelId: options.tunnelId ?? null, runtimeKeyConfigured: true }
							: { mode: "browser-only", tunnelId: null, runtimeKeyConfigured: false },
				};
			},
		});
		const browserOnly = harness();
		expect(
			await runChatGptWebCli(["setup", "--mode", "browser-only"], { dependencies: deps, io: browserOnly.io }),
		).toBe(0);
		expect(browserOnly.stdout.join("")).toBe('{"configured":true,"mode":"browser-only"}\n');

		const full = harness();
		const tunnelId = `tunnel_${"a".repeat(32)}`;
		const keyPath = "/secret/runtime-key-path-CANARY";
		expect(
			await runChatGptWebCli(["setup", "--mode", "full", "--tunnel-id", tunnelId, "--runtime-key-file", keyPath], {
				dependencies: deps,
				io: full.io,
			}),
		).toBe(0);
		expect(calls).toHaveLength(2);
		expect(calls[1]).toMatchObject({ mode: "full", tunnelId, runtimeKeyFile: keyPath });
		expect(full.stdout.join("")).not.toContain(tunnelId);
		expect(full.stdout.join("")).not.toContain(keyPath);
	});

	test("implements login, status, doctor, and uninstall handlers", async () => {
		let loggedIn = 0;
		let uninstalled = 0;
		const deps = dependencies({
			async login() {
				loggedIn++;
				return { authenticated: true, proAvailable: true, verifiedAt: "2026-08-02T12:00:00.000Z" };
			},
			async uninstall() {
				uninstalled++;
			},
		});
		for (const command of ["login", "status", "doctor", "uninstall"] as const) {
			const output = harness();
			expect(await runChatGptWebCli([command], { dependencies: deps, io: output.io })).toBe(0);
			expect(output.stderr).toEqual([]);
		}
		expect(loggedIn).toBe(1);
		expect(uninstalled).toBe(1);
	});

	test("status and doctor are read-only and redact tunnel, path, profile, marker, cookie, and token canaries", async () => {
		const canaries = [
			`tunnel_${"b".repeat(32)}`,
			"/private/browser-profile-CANARY",
			"profile-id-CANARY",
			"marker-identity-CANARY",
			"cookie-CANARY",
			"token-CANARY",
		];
		let mutations = 0;
		const deps = dependencies({
			async setup() {
				mutations++;
				throw new Error("not expected");
			},
			async login() {
				mutations++;
				throw new Error("not expected");
			},
			async uninstall() {
				mutations++;
			},
			async readConfig() {
				return { mode: "full", tunnelId: canaries[0] ?? null, runtimeKeyConfigured: true };
			},
			async readLoginStatus() {
				return { authenticated: true, proAvailable: true, verifiedAt: "2026-08-02T12:00:00.000Z" };
			},
		});
		for (const command of ["status", "doctor"] as const) {
			const output = harness();
			expect(await runChatGptWebCli([command], { dependencies: deps, io: output.io })).toBe(0);
			const text = output.stdout.join("") + output.stderr.join("");
			for (const canary of canaries) expect(text).not.toContain(canary);
		}
		expect(mutations).toBe(0);
	});

	test("never returns raw argument or dependency errors", async () => {
		const output = harness();
		const canary = "sk-high-entropy-error-CANARY";
		const deps = dependencies({
			async readConfig() {
				throw new Error(`failed with ${canary} at /private/profile-CANARY`);
			},
		});
		expect(await runChatGptWebCli(["status"], { dependencies: deps, io: output.io })).toBe(1);
		expect(output.stderr.join("")).toBe("ChatGPT Web command failed\n");
		expect(output.stderr.join("")).not.toContain(canary);
		const nativeUnavailable = harness();
		const nativeError = new NativeLocalRuntimeUnavailableError("native-secure-state-capability-unavailable");
		(nativeError as Error & { detail?: string }).detail = canary;
		expect(
			await runChatGptWebCli(["status"], {
				dependencies: dependencies({
					async readConfig() {
						throw nativeError;
					},
				}),
				io: nativeUnavailable.io,
			}),
		).toBe(1);
		expect(nativeUnavailable.stderr.join("")).toBe(
			"ChatGPT Web command failed (native-secure-state-capability-unavailable)\n",
		);
		expect(nativeUnavailable.stderr.join("")).not.toContain(canary);
		const unknown = harness();
		expect(
			await runChatGptWebCli(["status", "--secret", canary], { dependencies: dependencies(), io: unknown.io }),
		).toBe(1);
		expect(unknown.stderr.join("")).not.toContain(canary);
	});
});
