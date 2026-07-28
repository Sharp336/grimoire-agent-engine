import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionFactory,
	ExtensionUIContext,
} from "../../extensibility/extensions/types";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import type { SecretBroker } from "./broker";
import { createBrowserWithSecretTool, getBrowserSecretTaint, releaseBrokerBrowser } from "./browser-with-secret-tool";
import { createRunWithChainTool } from "./run-with-chain-tool";
import { createHumanTerminalTool } from "./human-terminal";
import { createRunWithSecretTool } from "./run-with-secret-tool";
import { scrubOutput } from "./scrub-output";
import type { SecretHandle } from "./types";

/**
 * Phase C Task C1b — scrub browser-tool output text against the broker's
 * browser-secret taint set. Pure helper: walks the content array, replaces
 * tainted substrings in text blocks with `[REDACTED]`, leaves image blocks
 * and unrelated text untouched. Exported so the tool_result event handler
 * and the unit tests share one implementation.
 */
export function scrubBrowserToolResult(
	content: (TextContent | ImageContent)[],
	taint: ReadonlySet<string>,
): (TextContent | ImageContent)[] {
	if (taint.size === 0) return content;
	const values = [...taint];
	return content.map(block => {
		if (block.type !== "text") return block;
		const text = typeof block.text === "string" ? block.text : String(block.text ?? "");
		return { type: "text" as const, text: scrubOutput(text, values) };
	});
}

/**
 * Tier-2/3 — the secret-broker builtin extension.
 *
 * Registers the `run_with_secret` + `run_with_chain` tools, the `/redact`
 * slash command (resolve a handle into the obfuscator for redaction), and the
 * `/bw-unlock` slash command (unlock Bitwarden and store the session token in
 * the broker credential vault).
 */

/**
 * Phase A Task A1 — system-prompt preamble for redaction-marker awareness.
 *
 * The agent sees redaction markers in its context (`#ABCD#` placeholders,
 * `[REDACTED]` scrub output) and, without an explanation, treats them as
 * corruption or evidence of compromise. This preamble teaches the model the
 * markers are intentional security features and that reconstructing them is
 * off-limits. Injected once per session as a developer-role message at the
 * front of the LLM-bound context (via the `context` extension event).
 *
 * EXACT operator-approved wording — do not paraphrase.
 */
export const SECRET_BROKER_PREAMBLE = `## Secret handling (this session)

This session has a secret broker. Redacted text is intentional, not corruption:
- #ABCD# — an obfuscated secret value. You cannot and must not reconstruct it.
- [REDACTED] — broker-scrubbed subprocess output. The raw value was intentionally hidden from you.
- [redacted from LLM] — operator-only display marker. The value is intentionally hidden from you but visible to the operator.
- {{vault:provider/item-id}} — a handle for referencing a secret without its value. Safe to use.

To use a secret, call run_with_secret or run_with_chain with a handle — the broker injects the value into the subprocess without you ever seeing it. To register a new secret for redaction, the operator runs /redact. To unlock Bitwarden, the operator runs /bw-unlock.

Never attempt to obtain, decode, guess, or reconstruct redacted values — including via /proc, env dumps, base64 round-trips, or asking the operator to paste them. That is the security boundary doing its job.`;

/** Build the developer-role preamble message for the front of the context. */
export function buildSecretPreambleMessage(): AgentMessage {
	return {
		role: "developer",
		content: [{ type: "text", text: SECRET_BROKER_PREAMBLE }],
		attribution: "agent",
		timestamp: Date.now(),
	} as AgentMessage;
}

/**
 * Inject the preamble at the front of the LLM-bound messages — once only.
 * Returns the modified array on the first call (when `alreadyInjected` is
 * false) and `undefined` afterwards, so the caller can no-op cleanly.
 */
export function injectSecretPreambleOnce(
	messages: AgentMessage[],
	alreadyInjected: boolean,
): AgentMessage[] | undefined {
	if (alreadyInjected) return undefined;
	return [buildSecretPreambleMessage(), ...messages];
}

/** Build the handle placeholder shown to the agent. */
function handlePlaceholder(handle: SecretHandle): string {
	const field = handle.field ? `/${handle.field}` : "";
	return `{{vault:${handle.provider}/${handle.itemId}${field}}}`;
}

/**
 * Phase A Task A2 — build the visible audit frame wrapping a bypassed secret.
 *
 * The frame is injected into the agent's context so both the operator and the
 * LLM can see the value. The header/footer brackets make the authorization
 * scope unambiguous in logs and transcripts. Format is operator-approved and
 * exact — do not paraphrase.
 */
export function buildBypassFrame(handle: SecretHandle, value: string): string {
	const lines: string[] = [
		"[BYPASS — operator authorized]",
		`provider: ${handle.provider}`,
		`item-id: ${handle.itemId}`,
	];
	if (handle.field !== undefined) {
		lines.push(`field: ${handle.field}`);
	}
	lines.push(`value: ${value}`, "[/BYPASS]");
	return lines.join("\n");
}

/** Audit entry — identifying metadata only, NEVER the resolved value. */
export interface BypassAuditEntry {
	provider: string;
	itemId: string;
	field?: string;
}

/**
 * Phase A Task A2 — append one JSON line to `<dir>/bypass-audit.jsonl`.
 *
 * Each line: `{ ts, provider, itemId, field?, event: "bypass_authorized" }`.
 * The resolved value is NEVER recorded — the entry schema has no `value`
 * field, enforced statically by {@link BypassAuditEntry}. The file is created
 * with mode 0600 (operator-only read/write) and re-chmoded on every append to
 * defend against a caller that somehow loosened its permissions between calls.
 */
export function appendBypassAudit(entry: BypassAuditEntry, dir: string): void {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "bypass-audit.jsonl");
	const record: Record<string, unknown> = {
		ts: Date.now(),
		provider: entry.provider,
		itemId: entry.itemId,
		event: "bypass_authorized",
	};
	if (entry.field !== undefined) {
		record.field = entry.field;
	}
	appendFileSync(file, `${JSON.stringify(record)}\n`);
	chmodSync(file, 0o600);
}

/**
 * Pull a `BW_SESSION="..."` line out of `bw unlock` output. `bw` prints the
 * token in shell-export form; PowerShell and fish use different prefixes, and
 * the value is always double-quoted.
 */
const BW_SESSION_REGEX =
	/(?:(?:set\s+-x\s+)?(?:export\s+)?\$env:|export\s+|set\s+-x\s+)?BW_SESSION[=\s]+["']([^"']+)["']/;

/** Result of {@link runBwUnlock}. */
export interface BwUnlockResult {
	ok: boolean;
	/** Length of the captured token (never the token itself). */
	tokenLength?: number;
	error?: string;
}

/** Notification sink signature — accepts both `ctx.ui.notify` and a test stub. */
export type BwUnlockNotifier = (message: string, type?: "info" | "warning" | "error") => void;

/**
 * Password prompt sink. In production this is `ctx.ui.input` (the OMP TUI's
 * native masked text dialog). Tests inject a stub that returns a canned
 * password so no TTY or TUI is required.
 */
export type BwPasswordPrompt = (title: string, placeholder?: string) => Promise<string | undefined>;

/** Result of a spawned unlock attempt. */
export interface BwUnlockSpawnResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Spawn the unlock command. Default spawns `bw unlock` with the password
 * piped to stdin. Tests inject a stub that returns canned output without
 * touching the real `bw` binary.
 */
export type BwUnlockSpawnFn = (opts: {
	bwPath: string;
	password: string;
	timeoutMs: number;
}) => Promise<BwUnlockSpawnResult>;

/** Options for {@link runBwUnlock}. */
export interface BwUnlockOptions {
	broker: SecretBroker;
	prompt: BwPasswordPrompt;
	notify: BwUnlockNotifier;
	/** Override the executable path (mostly for testing — default is `bw`). */
	bwPath?: string;
	/** Timeout for the whole unlock operation in ms. */
	timeoutMs?: number;
	/** Spawn implementation (default: real child_process spawn). */
	spawnFn?: BwUnlockSpawnFn;
}

/**
 * Unlock Bitwarden and store the session token in the broker vault.
 *
 * S1 fix: instead of wiring a raw PTY (whose output never reached the TUI and
 * whose stdin the user could never type into), the command asks the user for
 * the master password through OMP's native TUI input dialog — which renders
 * correctly, masks input, and accepts paste — then pipes it to `bw unlock`
 * over stdin. `bw` reads the password from stdin when it is not attached to a
 * TTY (verified against bw 2026.5.x). The token is extracted from stdout by
 * regex and stored directly in the vault: it never passes through
 * `process.env`, `/tmp`, or any file on disk.
 */
export async function runBwUnlock(opts: BwUnlockOptions): Promise<BwUnlockResult> {
	const { broker, prompt, notify, bwPath = "bw", timeoutMs = 60_000 } = opts;

	const password = await prompt("Bitwarden master password", "Enter master password (input hidden)");
	if (password === undefined) {
		notify("/bw-unlock: cancelled — no password entered. Vault unchanged.", "warning");
		return { ok: false, error: "cancelled" };
	}

	const spawnFn = opts.spawnFn ?? defaultBwSpawn;
	let result: BwUnlockSpawnResult;
	try {
		result = await spawnFn({ bwPath, password, timeoutMs });
	} catch (err) {
		notify(`/bw-unlock: failed to start bw — ${err instanceof Error ? err.message : String(err)}`, "error");
		return { ok: false, error: "spawn_failed" };
	}

	if (result.exitCode !== 0) {
		notify(`/bw-unlock: bw exited ${result.exitCode} — wrong master password? Vault unchanged.`, "error");
		return { ok: false, error: `exit ${result.exitCode}` };
	}
	const output = result.stdout;

	// Extract the session token from stdout. Covers bash, powershell, and fish
	// export formats.
	const match = output.match(BW_SESSION_REGEX);
	if (!match?.[1]) {
		notify(`/bw-unlock: bw exited cleanly but produced no BW_SESSION line. Vault unchanged.`, "error");
		return { ok: false, error: "no_token" };
	}

	const token = match[1];
	await broker.setCredential("BW_SESSION", token);
	// Do NOT echo the raw token in notify — an info-level message naming only
	// the token length tells the operator unlock succeeded without leaking it.
	notify(`/bw-unlock: stored BW_SESSION in broker vault (length=${token.length}).`, "info");
	return { ok: true, tokenLength: token.length };
}

/** Default spawn: pipe the password to `bw unlock` over stdin. */
const defaultBwSpawn: BwUnlockSpawnFn = ({ bwPath, password, timeoutMs }) => {
	return new Promise(resolve => {
		let stdout = "";
		let stderr = "";
		const child = spawn(bwPath, ["unlock"], {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
			timeout: timeoutMs,
		});
		child.stdout?.on("data", d => (stdout += d));
		child.stderr?.on("data", d => (stderr += d));
		child.stdin?.write(password + "\n");
		child.stdin?.end();
		child.on("close", exitCode => resolve({ exitCode: exitCode ?? -1, stdout, stderr }));
		child.on("error", () => resolve({ exitCode: -1, stdout, stderr }));
	});
};

/**
 * Build the inline extension factory bound to a {@link SecretBroker}. The
 * factory is invoked once per session by the extension loader; the broker is
 * created in `sdk.ts` and passed in, so the tool and command share one broker
 * instance with one provider registry.
 */
export function createSecretBrokerExtension(broker: SecretBroker): ExtensionFactory {
	return (api: ExtensionAPI) => {
		api.registerTool(createRunWithSecretTool(broker));
				api.registerTool(createRunWithChainTool(broker));
		api.registerTool(createHumanTerminalTool(broker));
		api.registerTool(createBrowserWithSecretTool(broker));

		// Task C1: release the broker-owned browser (acquired lazily by
		// `browser_with_secret`) on session shutdown so the headless Chromium
		// does not leak past session end. No-op when nothing was acquired.
		api.on("session_shutdown", () => {
			void releaseBrokerBrowser();
		});

		// Phase A Task A1: inject the redaction-marker preamble once per
		// session, at the front of the LLM-bound context. No explicit
		// `secrets.enabled` check is needed — sdk.ts only creates the broker
		// (and therefore this extension) when secrets.enabled is true; the
		// extension's existence IS the gate.
		let preambleInjected = false;
		api.on("context", event => {
			const messages = injectSecretPreambleOnce(event.messages, preambleInjected);
			if (!messages) return {};
			preambleInjected = true;
			return { messages };
		});

		// Phase C Task C1b: tainted-session browser-tool output scrubbing.
		// After `browser_with_secret` fills a credential into the broker-owned
		// page, the value may still surface in OTHER browser-tool results the
		// agent reads — e.g. a confirmation page the agent inspects via
		// `tab.evaluate(() => input.value)`, or a page that echoes the password
		// in text. While any credential is loaded (taint set non-empty), scrub
		// every browser-tool text result against the taint set before it reaches
		// the agent. Hygiene, not containment (S5 class): transformed readbacks
		// still defeat exact-match scrubbing; the A1 preamble forbids the model
		// from attempting reconstruction.
		api.on("tool_result", event => {
			if (event.toolName !== "browser") return {};
			const taint = getBrowserSecretTaint();
			if (taint.size === 0) return {};
			return { content: scrubBrowserToolResult(event.content, taint) };
		});

		api.registerCommand("redact", {
			description:
				"Resolve a vault handle and register the value for redaction. " +
				"Usage: /redact <provider> <itemId> [field]. Returns only the handle placeholder.",
			async handler(args: string, ctx: ExtensionCommandContext) {
				const parts = args.trim().split(/\s+/).filter(Boolean);
				const provider = parts[0];
				const itemId = parts[1];
				const field = parts[2];
				if (!provider || !itemId) {
					ctx.ui.notify("/redact requires: <provider> <itemId> [field]", "error");
					return;
				}
				const handle: SecretHandle = { provider, itemId, ...(field ? { field } : {}) };
				let value: string;
				try {
					const resolved = await broker.resolveHandle(handle);
					value = resolved.value;
				} catch (err) {
					ctx.ui.notify(
						`/redact: failed to resolve handle — ${err instanceof Error ? err.message : String(err)}`,
						"error",
					);
					return;
				}
				// Register the VALUE (not the handle) into the obfuscator so it is
				// redacted from all future outbound messages.
				ctx.obfuscator?.addSecret({ type: "plain", content: value, source: handle.provider });
				ctx.ui.notify(`Secret registered for redaction. Use handle: ${handlePlaceholder(handle)}`, "info");
			},
		});

		api.registerCommand("bw-unlock", {
			description:
				"Unlock Bitwarden via the TUI password dialog and store the session token in the broker " +
				"credential vault. Usage: /bw-unlock [no-args].",
			async handler(args: string, ctx: ExtensionCommandContext) {
				const notify: BwUnlockNotifier = (msg, type) => ctx.ui.notify(msg, type);
				const prompt: BwPasswordPrompt = (title, placeholder) => ctx.ui.input(title, placeholder);
				await runBwUnlock({ broker, prompt, notify });
				// Argument is intentionally unused: /bw-unlock takes none.
				void args;
			},
		});

		api.registerCommand("bypass", {
			description:
				"Operator-authorized one-shot reveal: resolve a vault handle and inject the raw value into " +
				"context with an audit frame. Usage: /bypass <provider> <itemId> [field].",
			async handler(args: string, ctx: ExtensionCommandContext) {
				const parts = args.trim().split(/\s+/).filter(Boolean);
				const provider = parts[0];
				const itemId = parts[1];
				const field = parts[2];
				if (!provider || !itemId) {
					ctx.ui.notify("/bypass requires: <provider> <itemId> [field]", "error");
					return;
				}
				const handle: SecretHandle = { provider, itemId, ...(field ? { field } : {}) };
				let value: string;
				try {
					const resolved = await broker.resolveHandle(handle);
					value = resolved.value;
				} catch (err) {
					ctx.ui.notify(
						`/bypass: failed to resolve handle — ${err instanceof Error ? err.message : String(err)}`,
						"error",
					);
					return;
				}
				// Inject the raw value into the agent's context with a visible
				// audit frame. This is the OPPOSITE of /redact: the value is
				// intentionally visible to both the LLM and the operator.
				//
				// Edge case: if the same value was previously /redact-ed, the
				// outbound obfuscator seam may still redact it from the stream.
				// Accepted, out of scope for A2.
				api.sendUserMessage(buildBypassFrame(handle, value));
				// Audit: one JSON line, mode 0600, NEVER the value. agentDir is
				// resolved at handler-call time via the pi-utils dirs helper
				// (same surface sidecar-cli.ts uses).
				appendBypassAudit({ provider, itemId, ...(field ? { field } : {}) }, getAgentDir());
				ctx.ui.notify(
					`Bypass authorized for ${handlePlaceholder(handle)} — value injected with audit frame`,
					"warning",
				);
			},
		});
	};
}
