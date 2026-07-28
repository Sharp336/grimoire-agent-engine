#!/usr/bin/env bun
// Integration test for the oh-my-pi-secret broker.
// Tests against REAL Bitwarden and REAL Infisical — no mocks.
//
// Prerequisites:
// 1. bw unlocked: `bw unlock` (enter master password)
// 2. BW_SESSION env var set (bw unlock prints it)
// 3. For Infisical: INFISICAL_CLIENT_SECRET + INFISICAL_WORKSPACE_ID set
//
// Usage:
//   export PATH="/home/johnzealanddoyle/.bun/bin:$PATH"
//   export BW_SESSION="$(cat /run/user/1000/bitwarden-mcp/session 2>/dev/null || echo '')"
//   bun run packages/coding-agent/src/secrets/broker/integration-test.ts

import { SecretObfuscator } from "../obfuscator";
import { BitwardenProvider, InfisicalProvider, SecretBroker } from "./index";

const FAIL = "\x1b[1;31mFAIL\x1b[0m";
const PASS = "\x1b[1;32mPASS\x1b[0m";
const INFO = "\x1b[1;34mINFO\x1b[0m";
const REDACTED_MARKER = "[REDACTED]";

let passCount = 0;
let failCount = 0;

function assert(condition: boolean, message: string) {
	if (condition) {
		console.log(`  ${PASS} ${message}`);
		passCount++;
	} else {
		console.log(`  ${FAIL} ${message}`);
		failCount++;
	}
}

async function main() {
	console.log("=== oh-my-pi-secret Integration Test ===\n");

	// --- 1. Check bw is unlocked ---
	console.log("1. Bitwarden CLI status:");
	const bw = new BitwardenProvider();
	const bwAvailable = await bw.isAvailable();
	if (!bwAvailable) {
		console.log(`  ${FAIL} bw is not unlocked or not in PATH`);
		console.log(`  ${INFO} Run: bw unlock  (then export BW_SESSION=...)`);
		failCount++;
	} else {
		console.log(`  ${PASS} bw is unlocked and available`);
		passCount++;
	}

	// --- 2. Check Infisical is reachable ---
	console.log("\n2. Infisical API status:");
	const infisicalClientSecret = process.env.INFISICAL_CLIENT_SECRET;
	const infisicalWorkspace = process.env.INFISICAL_WORKSPACE_ID;
	const infisicalUrl = process.env.INFISICAL_API_URL ?? "http://100.96.119.57:8083/api";

	if (!infisicalClientSecret || !infisicalWorkspace) {
		console.log(`  ${INFO} INFISICAL_CLIENT_SECRET or INFISICAL_WORKSPACE_ID not set — skipping Infisical tests`);
		console.log(`  ${INFO} To test: export INFISICAL_CLIENT_SECRET=... INFISICAL_WORKSPACE_ID=...`);
	} else {
		const inf = new InfisicalProvider({
			apiUrl: infisicalUrl,
			clientId: process.env.INFISICAL_CLIENT_ID ?? "",
			clientSecret: process.env.INFISICAL_CLIENT_SECRET ?? "",
			workspaceId: infisicalWorkspace,
		});
		const infAvailable = await inf.isAvailable();
		assert(infAvailable, "Infisical API is reachable and healthy");
	}

	// --- 3. Broker + Bitwarden: resolve a real secret ---
	if (bwAvailable) {
		console.log("\n3. Broker: resolve a real Bitwarden secret via runWithSecret:");
		const broker = new SecretBroker();
		broker.registerProvider(new BitwardenProvider());

		// Find a test item from bw — use the first item's ID
		console.log("  Listing bw items to find a test target...");
		const { exitCode, stdout } = await new Promise<{ exitCode: number; stdout: string }>(resolve => {
			const child = Bun.spawn(["bw", "list", "items", "--raw"], {
				stdio: ["ignore", "pipe", "pipe"],
				env: process.env as Record<string, string>,
			});
			let out = "";
			child.stdout.pipeTo(
				new WritableStream({
					write: d => {
						out += d;
					},
				}),
			);
			child.exited.then(code => resolve({ exitCode: code ?? -1, stdout: out }));
		});

		let loginItem: { id: string; name: string; login?: { password?: string } } | undefined;
		if (exitCode !== 0) {
			console.log(`  ${FAIL} bw list items failed (exit ${exitCode})`);
			failCount++;
		} else {
			const items = JSON.parse(stdout) as Array<{ id: string; name: string; login?: { password?: string } }>;
			loginItem = items.find(i => i.login?.password);
			if (!loginItem) {
				console.log(`  ${INFO} No login items with passwords found in vault — skipping resolve test`);
			} else {
				console.log(`  ${INFO} Test target: "${loginItem.name}" (id: ${loginItem.id})`);

				// Get the real password to verify scrubbing works
				const itemId = loginItem.id;
				const realPassword = await new Promise<string>(resolve => {
					const child = Bun.spawn(["bw", "get", "password", itemId, "--raw"], {
						stdio: ["ignore", "pipe", "pipe"],
						env: process.env as Record<string, string>,
					});
					let out = "";
					child.stdout.pipeTo(
						new WritableStream({
							write: d => {
								out += d;
							},
						}),
					);
					child.exited.then(() => resolve(out.trim()));
				});

				// 3a. runWithSecret: spawn `printenv MY_SECRET` with the resolved password
				const result = await broker.runWithSecret({
					handle: { provider: "bitwarden", itemId: loginItem.id },
					command: "printenv",
					args: ["MY_SECRET"],
					envKey: "MY_SECRET",
					timeoutMs: 10000,
				});

				assert(result.exitCode === 0, `runWithSecret exit code is 0 (got ${result.exitCode})`);

				// The stdout should contain the secret value (printenv prints it)
				// BUT it should be scrubbed to [REDACTED]
				const stdoutContainsSecret = result.stdout.includes(realPassword);
				const stdoutContainsRedacted = result.stdout.includes(REDACTED_MARKER);
				assert(!stdoutContainsSecret, "Real password does NOT appear in stdout (scrubbed)");
				assert(stdoutContainsRedacted, "stdout contains [REDACTED] marker");
				// 3b. Verify the real password is NOT in stderr either
				const stderrContainsSecret = result.stderr.includes(realPassword);
				assert(!stderrContainsSecret, "Real password does NOT appear in stderr");

				// 3c. Verify exec hardening: the subprocess should have closed PATH
				const pathResult = await broker.runWithSecret({
					handle: { provider: "bitwarden", itemId: loginItem.id },
					command: "printenv",
					args: ["PATH"],
					envKey: "MY_SECRET",
					timeoutMs: 10000,
				});
				const pathIsClosed =
					pathResult.stdout.includes("/usr/local/bin") &&
					!pathResult.stdout.includes("/home/johnzealanddoyle/.bun/bin");
				assert(pathIsClosed, "Subprocess PATH is the closed allowlist (no ~/.bun/bin)");

				// 3d. Verify LD_PRELOAD is stripped
				const envDumpResult = await broker.runWithSecret({
					handle: { provider: "bitwarden", itemId: loginItem.id },
					command: "env",
					args: [],
					envKey: "MY_SECRET",
					timeoutMs: 10000,
				});
				const noLdPreload = !envDumpResult.stdout.toLowerCase().includes("ld_preload");
				assert(noLdPreload, "LD_PRELOAD is not in subprocess env (stripped by exec hardening)");
			}
		}

		// --- 4. resolveHandle + addSecret (the /redact flow) ---
		console.log("\n4. resolveHandle + obfuscator integration (the /redact flow):");
		if (loginItem) {
			const obfuscator = new SecretObfuscator([]);

			// Resolve the handle (like /redact does)
			const secretValue = await broker.resolveHandle({
				provider: "bitwarden",
				itemId: loginItem.id,
			});

			// Register the value into the obfuscator (like /redact does)
			obfuscator.addSecret({ type: "plain", content: secretValue.value });

			// Verify obfuscation works
			const obfuscated = obfuscator.obfuscate(`my password is ${secretValue.value}`);
			const containsPlaceholder = /#[A-Z0-9]{4}#/.test(obfuscated);
			const containsRaw = obfuscated.includes(secretValue.value);
			assert(containsPlaceholder, "Obfuscator replaces the secret with a #XXXX# placeholder");
			assert(!containsRaw, "Raw secret value does NOT appear in obfuscated text");

			// Verify display styling
			const displayText = obfuscator.deobfuscateForDisplay(obfuscated);
			const hasAnsi = displayText.includes("\x1b[1;35m");
			const hasMarker = displayText.includes("[redacted from LLM]");
			assert(hasAnsi, "deobfuscateForDisplay wraps value in bold-magenta ANSI");
			assert(hasMarker, "deobfuscateForDisplay appends [redacted from LLM] marker");
		}
	}

	// --- 5. Infisical resolve (if creds available) ---
	if (infisicalClientSecret && infisicalWorkspace) {
		console.log("\n5. Infisical: resolve a real secret:");
		const inf = new InfisicalProvider({
			apiUrl: infisicalUrl,
			clientId: process.env.INFISICAL_CLIENT_ID ?? "",
			clientSecret: process.env.INFISICAL_CLIENT_SECRET ?? "",
			workspaceId: infisicalWorkspace,
		});

		// Try to resolve a known secret — CF_DNS_API_TOKEN is in the vault per AGENTS.md
		try {
			const secret = await inf.resolve({
				provider: "infisical",
				itemId: "prod/CF_DNS_API_TOKEN",
			});
			assert(secret.value.length > 0, "Infisical resolve returned a non-empty value");
			assert(secret.handle.provider === "infisical", "Handle provider is 'infisical'");
			console.log(
				`  ${INFO} Resolved prod/CF_DNS_API_TOKEN (length: ${secret.value.length}, last4: ...${secret.value.slice(-4)})`,
			);
		} catch (err) {
			console.log(`  ${FAIL} Infisical resolve failed: ${err}`);
			failCount++;
		}
	}

	// --- Summary ---
	console.log(`\n=== Results: ${passCount} passed, ${failCount} failed ===`);
	if (failCount > 0) {
		console.log("\x1b[1;31mINTEGRATION TEST FAILED\x1b[0m");
		process.exit(1);
	} else {
		console.log("\x1b[1;32mINTEGRATION TEST PASSED\x1b[0m");
	}
}

main().catch(err => {
	console.error("Fatal error:", err);
	process.exit(2);
});
