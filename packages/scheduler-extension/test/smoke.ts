/**
 * Behavioral smoke test for the scheduler extension.
 *
 * Run with: bun test/smoke.ts
 *
 * Drives the extension through a mocked ExtensionAPI: queue → start →
 * dispatch → success, interruption → resume preamble, window-quota blocking,
 * stop, crash recovery via a second extension instance, and model awareness
 * (anthropic gated, other providers ungated, unknown provider ungated with a
 * notice). Uses a throwaway PI_CODING_AGENT_DIR so no real user data is
 * touched.
 */

import * as assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { refreshDirsFromEnv } from "@oh-my-pi/pi-utils/dirs";
import type { SchedulerConfig, SchedulerLogEntry, SchedulerState } from "../src/extension";
import schedulerExtension from "../src/extension";

/** Model exposed through the mocked ctx (shape per extensions.md "provider/id"). */
interface MockModel {
	provider: string;
	id: string;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type EventHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type CommandHandler = (args: string, ctx: unknown) => Promise<void> | void;

interface MockPi {
	api: ExtensionAPI;
	emit(event: string, payload: unknown, ctx: unknown): Promise<void>;
	command(args: string, ctx: unknown): Promise<void>;
	sentPrompts: string[];
	setFailSend(fail: boolean): void;
}

function makeMockPi(): MockPi {
	const handlers = new Map<string, EventHandler[]>();
	let commandHandler: CommandHandler | null = null;
	const sentPrompts: string[] = [];
	let failSend = false;
	const raw = {
		setLabel(_label: string) {},
		logger: { warn(_msg: string) {}, info(_msg: string) {} },
		on(event: string, handler: EventHandler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand(_name: string, def: { description: string; handler: CommandHandler }) {
			commandHandler = def.handler;
		},
		sendUserMessage(content: string) {
			if (failSend) throw new Error("host mode rejected prompt delivery");
			sentPrompts.push(content);
		},
	};
	return {
		api: raw as unknown as ExtensionAPI,
		async emit(event, payload, ctx) {
			// Model the host: event/timer handlers get a base ExtensionContext WITHOUT
			// the command-only session controls (newSession/switchSession/…); only
			// command handlers see those (createCommandContext). Strip newSession so
			// the scheduler must source the content-policy purge from a retained
			// command context, exactly as in production.
			const eventCtx =
				ctx && typeof ctx === "object" ? { ...(ctx as Record<string, unknown>), newSession: undefined } : ctx;
			for (const handler of handlers.get(event) ?? []) await handler(payload, eventCtx);
		},
		async command(args, ctx) {
			assert.ok(commandHandler, "command not registered");
			await commandHandler(args, ctx);
		},
		sentPrompts,
		setFailSend(fail: boolean) {
			failSend = fail;
		},
	};
}

interface MockCtx {
	ui: {
		notify(message: string, level?: string): void;
		confirm(title: string, message: string): Promise<boolean>;
		setStatus(key: string, text: string): void;
	};
	hasUI: boolean;
	cwd: string;
	models: { current(): MockModel | undefined };
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	abort(): void;
	getContextUsage(): undefined;
	newSession(): Promise<{ cancelled: boolean }>;
	compact(instructionsOrOptions?: string): Promise<void>;
	notifications: string[];
	confirmCalls: number;
	newSessionCalls: number;
	compactCalls: number;
	newSessionCancelled: boolean;
	newSessionDelayMs: number;
	setTimeout(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): Timer;
	setInterval(callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): Timer;
	clearTimer(timer: Timer): void;
	setTimeoutCalls: number;
	setIntervalCalls: number;
	clearTimerCalls: number;
}

/**
 * `model` is what ctx.models.current() returns: default is a Claude
 * subscription model (gated by the default quota profile); pass another
 * provider to exercise ungated dispatch, or null for an undetectable model.
 */
function makeCtx(cwd: string, model: MockModel | null = { provider: "anthropic", id: "claude-fable-5" }): MockCtx {
	const ctx: MockCtx = {
		notifications: [],
		confirmCalls: 0,
		newSessionCalls: 0,
		newSessionCancelled: false,
		newSessionDelayMs: 0,
		compactCalls: 0,
		setTimeoutCalls: 0,
		setIntervalCalls: 0,
		clearTimerCalls: 0,
		ui: {
			notify(message) {
				ctx.notifications.push(message);
			},
			async confirm() {
				ctx.confirmCalls += 1;
				return true;
			},
			setStatus() {},
		},
		hasUI: true,
		cwd,
		models: { current: () => model ?? undefined },
		isIdle: () => true,
		hasPendingMessages: () => false,
		abort() {},
		getContextUsage: () => undefined,
		async newSession() {
			ctx.newSessionCalls += 1;
			if (ctx.newSessionDelayMs) await Bun.sleep(ctx.newSessionDelayMs);
			return { cancelled: ctx.newSessionCancelled };
		},
		async compact() {
			ctx.compactCalls += 1;
		},
		setTimeout(callback, ms, ...args) {
			ctx.setTimeoutCalls += 1;
			return setTimeout(callback, ms, ...args);
		},
		setInterval(callback, ms, ...args) {
			ctx.setIntervalCalls += 1;
			const timer = setInterval(callback, ms, ...args);
			timer.unref?.();
			return timer;
		},
		clearTimer(timer) {
			ctx.clearTimerCalls += 1;
			clearTimeout(timer);
		},
	};
	return ctx;
}

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

const tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-scheduler-smoke-"));
export async function runSmoke(): Promise<void> {
	process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
	// The pi-utils dir resolver caches at module load (before this line runs), so
	// re-sync it to the throwaway agent dir just set — otherwise getAgentDir() (used
	// by the extension) would point at the real ~/.omp/agent.
	refreshDirsFromEnv();
	const tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "omp-scheduler-cwd-"));
	const stateFile = path.join(tmpAgentDir, "scheduler", "state.json");
	const configFile = path.join(tmpAgentDir, "scheduler", "config.json");
	const logFile = path.join(tmpAgentDir, "scheduler", "task-log.jsonl");
	const ledgerFile = path.join(tmpAgentDir, "scheduler", "task-ledger.md");

	function readState(): SchedulerState {
		return JSON.parse(fs.readFileSync(stateFile, "utf8")) as SchedulerState;
	}
	function task(state: SchedulerState, id: string) {
		const found = state.tasks.find(t => t.id === id);
		assert.ok(found, `task ${id} missing`);
		return found;
	}
	/** All log records, newest last — for asserting the self-describing log fields. */
	function readLog(): SchedulerLogEntry[] {
		return fs
			.readFileSync(logFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map(l => JSON.parse(l) as SchedulerLogEntry);
	}

	const a = makeMockPi();
	const ctx = makeCtx(tmpCwd);
	schedulerExtension(a.api);

	// 1. session_start seeds config.json with defaults
	await a.emit("session_start", {}, ctx);
	assert.ok(fs.existsSync(configFile), "config.json seeded on session_start");

	// default config gates anthropic/claude at 5h×4; status shows model + profile
	await a.command("status", ctx);
	assert.match(
		ctx.notifications.at(-1) ?? "",
		/model: anthropic\/claude-fable-5 — quota: 5h×4 \(anthropic\)/,
		"status shows the detected model and the gated default profile",
	);

	// speed the loop up and shrink windows so quota logic is exercisable:
	// sessionHours 1e-5 h = 36ms, 3 windows per rolling 24h for anthropic/claude.
	const cfg = JSON.parse(fs.readFileSync(configFile, "utf8")) as SchedulerConfig;
	cfg.dispatchDelayMs = 30;
	cfg.quotaProfiles = [
		{ match: "anthropic|claude", sessionHours: 0.00001, maxSessionsPer24h: 3 },
		{ match: ".*", sessionHours: null, maxSessionsPer24h: null },
	];
	fs.writeFileSync(configFile, JSON.stringify(cfg));

	// 2. add + status
	await a.command("add Write the CHANGELOG", ctx);
	assert.match(ctx.notifications.at(-1) ?? "", /queued t1/);
	await a.command("status", ctx);
	assert.match(ctx.notifications.at(-1) ?? "", /t1 {2}queued/);
	assert.match(ctx.notifications.at(-1) ?? "", /windows: 0\/3/);

	// 3. start warns (via confirm) when approvalMode is persisted non-yolo
	fs.writeFileSync(path.join(tmpAgentDir, "config.yml"), "tools:\n  approvalMode: write\n");
	await a.command("start", ctx);
	assert.equal(ctx.confirmCalls, 1, "non-yolo approval mode should trigger a confirm dialog");
	await sleep(600); // cmdStart arms a 500ms initial dispatch

	// 4. dispatch wraps prompt with the unattended preamble
	assert.equal(a.sentPrompts.length, 1, "one prompt dispatched");
	assert.match(a.sentPrompts[0], /no human is watching/);
	assert.match(a.sentPrompts[0], /Write the CHANGELOG/);
	assert.doesNotMatch(a.sentPrompts[0], /RESUME/);

	// 5. successful turn settles the task as done and records one session window
	await a.emit("agent_start", {}, ctx);
	await a.emit("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "stop" }] }, ctx);
	{
		const st = readState();
		assert.equal(task(st, "t1").status, "done");
		assert.equal(st.currentTaskId, null);
		assert.equal(st.windows.length, 1, "agent_start recorded a session window");
		assert.equal(st.windows[0].profile, "anthropic|claude", "window tagged with the profile it was tracked under");
	}

	// 6. failed turn marks the task interrupted, then re-dispatches with RESUME
	await a.command("add Migrate the database", ctx);
	await sleep(80);
	assert.equal(a.sentPrompts.length, 2, "t2 dispatched");
	await a.emit("agent_start", {}, ctx);
	await a.emit(
		"agent_end",
		{ messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited" }] },
		ctx,
	);
	{
		const st = readState();
		assert.equal(task(st, "t2").status, "interrupted");
		assert.match(task(st, "t2").lastError ?? "", /rate limited/);
	}
	await sleep(80); // agent_end scheduled the next dispatch (30ms)
	assert.equal(a.sentPrompts.length, 3, "t2 re-dispatched");
	assert.match(a.sentPrompts[2], /RESUME/);
	assert.match(a.sentPrompts[2], /do not repeat completed work/);
	assert.match(a.sentPrompts[2], /Migrate the database/);
	await a.emit("agent_start", {}, ctx);
	await a.emit("agent_end", { messages: [{ role: "assistant", content: [] }] }, ctx);
	{
		const st = readState();
		assert.equal(task(st, "t2").status, "done");
		assert.equal(task(st, "t2").attempts, 2);
	}

	// 7. quota exhausted for the gated anthropic profile (3 windows used, none
	// active) blocks dispatch + arms resume timer
	await sleep(50); // let the 36ms window expire
	await a.command("add Third task", ctx);
	await sleep(80);
	assert.equal(a.sentPrompts.length, 3, "t3 must NOT dispatch while quota is exhausted");
	assert.ok(
		ctx.notifications.some(n => n.includes("auto-resuming at")),
		"blocked notification announces auto-resume time",
	);
	{
		const st = readState();
		assert.equal(task(st, "t3").status, "queued");
	}

	// 8. stop clears timers and holds
	await a.command("stop", ctx);
	{
		const st = readState();
		assert.equal(st.run, "stopped");
	}

	// 9. log shows JSONL entries; remove/clear manage the queue
	await a.command("log 20", ctx);
	assert.match(ctx.notifications.at(-1) ?? "", /log entries/);
	assert.match(ctx.notifications.at(-1) ?? "", /dispatch/);
	assert.match(ctx.notifications.at(-1) ?? "", /blocked/);
	for (const line of fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean)) {
		JSON.parse(line); // every log line is valid JSON
	}
	await a.command("remove t3", ctx);
	assert.equal(
		readState().tasks.some(t => t.id === "t3"),
		false,
	);
	await a.command("clear", ctx);
	{
		const kept = readState().tasks;
		assert.ok(
			kept.length >= 2 && kept.every(t => t.status === "done" || t.status === "failed"),
			"clear preserves finished (done/failed) tasks and drops only pending work",
		);
	}

	// 10. crash recovery: a fresh instance finds a task left "running" by a dead
	// process, marks it interrupted, and (run=running) resumes it with the preamble.
	{
		const st = readState();
		st.run = "running";
		st.currentTaskId = "t9";
		st.windows = []; // fresh quota for the new "day"
		st.tasks = [
			{
				id: "t9",
				prompt: "Port the parser to Rust",
				status: "running",
				addedAt: new Date().toISOString(),
				dispatchedAt: new Date().toISOString(),
				attempts: 1,
			},
		];
		st.nextTaskSeq = 10;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const b = makeMockPi();
	const ctxB = makeCtx(tmpCwd);
	schedulerExtension(b.api);
	await b.emit("session_start", {}, ctxB);
	{
		const st = readState();
		assert.equal(task(st, "t9").status, "interrupted", "in-flight task recovered as interrupted");
		assert.equal(st.currentTaskId, null);
	}
	assert.ok(
		ctxB.notifications.some(n => n.includes("active") && n.includes("1 task(s) pending")),
		"restart announces the active scheduler",
	);
	await sleep(80); // session_start scheduled dispatch (dispatchDelayMs=30)
	assert.equal(b.sentPrompts.length, 1, "recovered task re-dispatched after restart");
	assert.match(b.sentPrompts[0], /RESUME/);
	assert.match(b.sentPrompts[0], /Port the parser to Rust/);
	await b.emit("agent_start", {}, ctxB);
	await b.emit("agent_end", { messages: [{ role: "assistant", content: [] }] }, ctxB);
	assert.equal(task(readState(), "t9").status, "done");
	await sleep(50);
	await b.command("stop", ctxB); // clear timers so the process can exit

	// 11. model awareness: a non-matching provider dispatches ungated even when
	// the anthropic quota is exhausted, and records no windows of its own.
	{
		const st = readState();
		st.run = "running";
		st.currentTaskId = null;
		st.tasks = [
			{
				id: "t20",
				prompt: "Summarize the release notes",
				status: "queued",
				addedAt: new Date().toISOString(),
				attempts: 0,
			},
		];
		st.windows = [
			// anthropic quota fully used within the rolling 24h (windows expired 36ms after start)
			{ startedAt: new Date(Date.now() - 60_000).toISOString(), profile: "anthropic|claude" },
			{ startedAt: new Date(Date.now() - 40_000).toISOString(), profile: "anthropic|claude" },
			{ startedAt: new Date(Date.now() - 20_000).toISOString(), profile: "anthropic|claude" },
		];
		st.nextTaskSeq = 21;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const c = makeMockPi();
	const ctxC = makeCtx(tmpCwd, { provider: "openai", id: "gpt-5" });
	schedulerExtension(c.api);
	await c.emit("session_start", {}, ctxC);
	await sleep(80);
	assert.equal(c.sentPrompts.length, 1, "openai model dispatches despite exhausted anthropic quota");
	assert.match(c.sentPrompts[0], /Summarize the release notes/);
	await c.command("status", ctxC);
	{
		const statusOut = ctxC.notifications.at(-1) ?? "";
		assert.match(statusOut, /model: openai\/gpt-5 — quota: none \(openai\)/, "status shows the ungated provider");
		assert.match(statusOut, /windows: not tracked \(unlimited profile\)/);
	}
	await c.emit("agent_start", {}, ctxC);
	{
		const st = readState();
		assert.equal(st.windows.length, 3, "unlimited profile records no session windows");
		assert.ok(
			st.windows.every(w => w.profile === "anthropic|claude"),
			"anthropic window records untouched",
		);
	}
	await c.emit("agent_end", { messages: [{ role: "assistant", content: [] }] }, ctxC);
	assert.equal(task(readState(), "t20").status, "done");
	await sleep(50);
	await c.command("stop", ctxC);

	// 12. unknown provider: no detectable model → ungated dispatch + notice log
	{
		const st = readState();
		st.run = "running";
		st.tasks = [
			{
				id: "t30",
				prompt: "Rebuild the search index",
				status: "queued",
				addedAt: new Date().toISOString(),
				attempts: 0,
			},
		];
		st.nextTaskSeq = 31;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const d = makeMockPi();
	const ctxD = makeCtx(tmpCwd, null); // ctx exposes no readable model at all
	schedulerExtension(d.api);
	await d.emit("session_start", {}, ctxD);
	await sleep(80);
	assert.equal(d.sentPrompts.length, 1, "unknown provider dispatches ungated");
	assert.match(d.sentPrompts[0], /Rebuild the search index/);
	assert.ok(
		ctxD.notifications.some(n => n.includes("provider/model unknown")),
		"unknown provider announces ungated dispatch",
	);
	assert.ok(
		fs
			.readFileSync(logFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line) as { event: string; detail?: string })
			.some(e => e.event === "notice" && (e.detail ?? "").includes("not detectable")),
		"a notice line is logged for the undetectable provider/model",
	);
	await d.command("status", ctxD);
	assert.match(ctxD.notifications.at(-1) ?? "", /model: unknown — quota: none \(unknown provider\)/);
	await d.emit("agent_start", {}, ctxD);
	assert.equal(readState().windows.length, 3, "no window recorded for an unknown provider");
	await d.emit("agent_end", { messages: [{ role: "assistant", content: [] }] }, ctxD);
	assert.equal(task(readState(), "t30").status, "done");
	await sleep(50);
	await d.command("stop", ctxD);

	// 13. v1 state migration: legacy string windows are re-tagged to the first
	// gated profile so a mid-upgrade day keeps counting them.
	{
		const st = readState() as unknown as { version: number; windows: unknown[] };
		st.version = 1;
		st.windows = [new Date(Date.now() - 60_000).toISOString()];
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const e = makeMockPi();
	const ctxE = makeCtx(tmpCwd);
	schedulerExtension(e.api);
	await e.emit("session_start", {}, ctxE);
	await e.command("status", ctxE);
	assert.match(
		ctxE.notifications.at(-1) ?? "",
		/windows: 1\/3 used in last 24h/,
		"legacy v1 window string counts against the gated anthropic profile",
	);

	// 14. provider rate limit: retries exhausted with a retry-after → task kept
	// "interrupted" with the attempt refunded, and ALL dispatch held until the
	// provider-declared reset time (no immediate retry burn-down).
	{
		const st = readState();
		st.run = "running";
		st.currentTaskId = null;
		st.rateLimitedUntil = null;
		st.windows = [];
		st.tasks = [
			{
				id: "t40",
				prompt: "Push the fork and raise the PR",
				status: "queued",
				addedAt: new Date().toISOString(),
				attempts: 0,
			},
		];
		st.nextTaskSeq = 41;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const f = makeMockPi();
	const ctxF = makeCtx(tmpCwd);
	schedulerExtension(f.api);
	await f.emit("session_start", {}, ctxF);
	await sleep(80);
	assert.equal(f.sentPrompts.length, 1, "t40 dispatched");
	await f.emit("agent_start", {}, ctxF);
	await f.emit(
		"auto_retry_end",
		{
			success: false,
			finalError:
				'Retry failed after 1 attempts: Provider requested 120000ms wait, exceeds retry.maxDelayMs (300000ms). Original error: 429 {"type":"rate_limit_error"} retry-after-ms=120000',
		},
		ctxF,
	);
	await f.emit("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "stop" }] }, ctxF);
	{
		const st = readState();
		const t40 = task(st, "t40");
		assert.equal(t40.status, "interrupted", "rate-limited task stays interrupted, never failed");
		assert.equal(t40.attempts, 0, "rate-limited attempt is refunded");
		const hold = Date.parse(st.rateLimitedUntil ?? "");
		assert.ok(Number.isFinite(hold) && hold > Date.now() + 100_000, "hold recorded from the provider retry-after");
		assert.ok(
			ctxF.notifications.some(n => n.includes("rate-limited — holding dispatch until")),
			"rate-limit hold is announced",
		);
		// The log alone must explain WHY the turn ended and whether it cost an
		// attempt — no cross-referencing state.json or the source classifiers.
		const log = readLog();
		const t40End = [...log].reverse().find(e => e.event === "end" && e.taskId === "t40");
		assert.ok(t40End, "t40 end is logged");
		assert.equal(t40End?.classification, "rate_limit", "end log records the rate_limit classification");
		assert.equal(t40End?.refunded, true, "end log records that the attempt was refunded");
		assert.equal(t40End?.terminal ?? false, false, "a refunded end is never terminal");
		assert.ok((t40End?.prompt ?? "").includes("Push the fork"), "end log is self-describing (carries the prompt)");
		const t40Dispatch = log.find(e => e.event === "dispatch" && e.taskId === "t40");
		assert.ok((t40Dispatch?.prompt ?? "").includes("Push the fork"), "dispatch log carries the prompt");
	}
	await sleep(120);
	assert.equal(f.sentPrompts.length, 1, "no re-dispatch while the provider hold is active");
	await f.command("status", ctxF);
	assert.match(ctxF.notifications.at(-1) ?? "", /hold: provider rate-limited until/);
	await f.command("stop", ctxF); // clears the armed resume timer

	// 15. /scheduler retry revives a failed task (fresh attempt budget, resume
	// preamble), and an expired provider hold is cleared on the next dispatch.
	{
		const st = readState();
		st.run = "running";
		st.currentTaskId = null;
		st.rateLimitedUntil = new Date(Date.now() - 1000).toISOString(); // expired hold
		st.windows = [];
		st.tasks = [
			{
				id: "t50",
				prompt: "Fix the merge conflicts",
				status: "failed",
				addedAt: new Date().toISOString(),
				attempts: 3,
				lastError: "provider retries exhausted (rate limit or outage)",
			},
		];
		st.nextTaskSeq = 51;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const g = makeMockPi();
	const ctxG = makeCtx(tmpCwd);
	schedulerExtension(g.api);
	await g.emit("session_start", {}, ctxG);
	await sleep(80);
	assert.equal(g.sentPrompts.length, 0, "failed task is not auto-dispatched");
	await g.command("retry t50", ctxG);
	assert.match(ctxG.notifications.at(-1) ?? "", /re-queued t50/);
	{
		const t50 = task(readState(), "t50");
		assert.equal(t50.status, "interrupted", "retry re-queues as interrupted (resume path)");
		assert.equal(t50.attempts, 0, "retry resets the attempt budget");
	}
	await sleep(80);
	assert.equal(g.sentPrompts.length, 1, "retried task dispatched");
	assert.match(g.sentPrompts[0], /RESUME/);
	assert.match(g.sentPrompts[0], /Fix the merge conflicts/);
	assert.equal(readState().rateLimitedUntil ?? null, null, "expired provider hold cleared on dispatch");
	await g.emit("agent_start", {}, ctxG);
	await g.emit("agent_end", { messages: [{ role: "assistant", content: [] }] }, ctxG);
	assert.equal(task(readState(), "t50").status, "done");
	await g.command("retry", ctxG);
	assert.match(ctxG.notifications.at(-1) ?? "", /no failed tasks to retry/);
	await sleep(50);
	await g.command("stop", ctxG);

	// 16. network outage: provider unreachable → attempt refunded, exponential
	// backoff armed, and the task auto-resumes once the "internet" is back.
	{
		const c16 = JSON.parse(fs.readFileSync(configFile, "utf8")) as SchedulerConfig;
		c16.outageBackoffBaseMs = 40; // armResumeTimer clamps to 1s minimum
		c16.outageBackoffMaxMs = 200;
		fs.writeFileSync(configFile, JSON.stringify(c16));
		const st = readState();
		st.run = "running";
		st.currentTaskId = null;
		st.rateLimitedUntil = null;
		st.windows = [];
		st.tasks = [
			{
				id: "t60",
				prompt: "Count to 200, print every second",
				status: "queued",
				addedAt: new Date().toISOString(),
				attempts: 0,
			},
		];
		st.nextTaskSeq = 61;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const h = makeMockPi();
	const ctxH = makeCtx(tmpCwd);
	schedulerExtension(h.api);
	await h.emit("session_start", {}, ctxH);
	await sleep(80);
	assert.equal(h.sentPrompts.length, 1, "t60 dispatched");
	// internet cut: harness retries exhaust with a transport error
	await h.emit("agent_start", {}, ctxH);
	await h.emit(
		"auto_retry_end",
		{
			success: false,
			finalError: "Retry failed after 8 attempts: fetch failed: connect ECONNREFUSED api.anthropic.com:443",
		},
		ctxH,
	);
	await h.emit("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "stop" }] }, ctxH);
	{
		const st = readState();
		const t60 = task(st, "t60");
		assert.equal(t60.status, "interrupted", "outage keeps the task interrupted, never failed");
		assert.equal(t60.attempts, 0, "outage attempt is refunded");
		assert.equal(st.rateLimitedUntil ?? null, null, "outage does not record a rate-limit hold");
		assert.ok(
			ctxH.notifications.some(n => n.includes("provider unreachable — retrying in") && n.includes("outage #1")),
			"outage backoff is announced",
		);
	}
	assert.equal(h.sentPrompts.length, 1, "no instant re-dispatch after an outage");
	// internet restored: the armed backoff timer (1s clamp) re-dispatches with RESUME
	await sleep(1300);
	assert.equal(h.sentPrompts.length, 2, "task auto-resumes after the outage backoff");
	assert.match(h.sentPrompts[1], /RESUME/);
	assert.match(h.sentPrompts[1], /Count to 200/);
	// second consecutive outage doubles the streak, still refunding the attempt
	await h.emit("agent_start", {}, ctxH);
	await h.emit(
		"auto_retry_end",
		{ success: false, finalError: "fetch failed: getaddrinfo ENOTFOUND api.anthropic.com" },
		ctxH,
	);
	await h.emit("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "stop" }] }, ctxH);
	assert.equal(task(readState(), "t60").attempts, 0, "second outage attempt also refunded");
	assert.ok(
		ctxH.notifications.some(n => n.includes("outage #2")),
		"consecutive outages escalate the streak",
	);
	await sleep(1300);
	assert.equal(h.sentPrompts.length, 3, "resumes again after the second backoff");
	await h.emit("agent_start", {}, ctxH);
	await h.emit("agent_end", { messages: [{ role: "assistant", content: [] }] }, ctxH);
	assert.equal(task(readState(), "t60").status, "done", "task completes once connectivity is back");
	await sleep(50);
	await h.command("stop", ctxH);

	// 17. user abort of a scheduled turn pauses the queue (never re-dispatches
	// over the human) and keeps the task interrupted with the attempt refunded.
	{
		const st = readState();
		st.run = "running";
		st.currentTaskId = null;
		st.rateLimitedUntil = null;
		st.windows = [];
		st.tasks = [
			{ id: "t70", prompt: "Long refactor", status: "queued", addedAt: new Date().toISOString(), attempts: 0 },
		];
		st.nextTaskSeq = 71;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const m = makeMockPi();
	const ctxM = makeCtx(tmpCwd);
	schedulerExtension(m.api);
	await m.emit("session_start", {}, ctxM);
	await sleep(80);
	assert.equal(m.sentPrompts.length, 1, "t70 dispatched");
	await m.emit("agent_start", {}, ctxM);
	await m.emit("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "aborted" }] }, ctxM);
	{
		const st = readState();
		assert.equal(st.run, "paused", "user abort pauses the queue");
		const t70 = task(st, "t70");
		assert.equal(t70.status, "interrupted", "aborted task kept resumable");
		assert.equal(t70.attempts, 0, "user abort refunds the attempt");
		assert.ok(
			ctxM.notifications.some(n => n.includes("queue paused")),
			"abort pause is announced",
		);
	}
	await sleep(120);
	assert.equal(m.sentPrompts.length, 1, "paused queue never re-dispatches over the user");
	await m.command("start", ctxM);
	await sleep(700); // cmdStart arms a 500ms initial dispatch
	assert.equal(m.sentPrompts.length, 2, "start resumes the aborted task");
	assert.match(m.sentPrompts[1], /RESUME/);
	await m.emit("agent_start", {}, ctxM);
	await m.emit("agent_end", { messages: [{ role: "assistant", content: [] }] }, ctxM);
	assert.equal(task(readState(), "t70").status, "done");
	await sleep(50);
	await m.command("stop", ctxM);

	// 18. watchdog: a dispatched prompt whose turn never materializes (swallowed
	// message / lost agent_end) is re-queued with the attempt refunded and
	// re-dispatched automatically — "running" can never silently stall.
	{
		const c18 = JSON.parse(fs.readFileSync(configFile, "utf8")) as SchedulerConfig;
		c18.watchdogIntervalMs = 40;
		c18.stallTimeoutMs = 60;
		// High attempt budget so the (>= maxAttempts) stall cap can't fail t80 mid-test
		// while we race to catch the watchdog re-dispatch — this scenario tests the
		// re-dispatch, not the cap (scenario 32 covers the cap).
		c18.maxAttempts = 20;
		fs.writeFileSync(configFile, JSON.stringify(c18));
		const st = readState();
		st.run = "running";
		st.currentTaskId = null;
		st.rateLimitedUntil = null;
		st.windows = [];
		st.tasks = [
			{ id: "t80", prompt: "Swallowed dispatch", status: "queued", addedAt: new Date().toISOString(), attempts: 0 },
		];
		st.nextTaskSeq = 81;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const w = makeMockPi();
	const ctxW = makeCtx(tmpCwd);
	schedulerExtension(w.api);
	await w.emit("session_start", {}, ctxW);
	await sleep(80);
	assert.equal(w.sentPrompts.length, 1, "t80 dispatched");
	// no agent_start/agent_end ever arrives; the watchdog notices the idle agent
	// past stallTimeoutMs and re-queues + re-dispatches.
	await sleep(300);
	assert.ok(w.sentPrompts.length >= 2, "watchdog re-dispatched the stalled task");
	assert.ok(
		ctxW.notifications.some(n => n.includes("watchdog")),
		"watchdog recovery is announced",
	);
	assert.match(w.sentPrompts.at(-1) ?? "", /RESUME/);
	// catch the task in flight, then pin isIdle=false so the watchdog cannot
	// steal the turn we are about to simulate (mock isIdle is constant-true).
	for (let k = 0; k < 100 && readState().currentTaskId === null; k++) await sleep(20);
	assert.equal(readState().currentTaskId, "t80", "t80 back in flight");
	ctxW.isIdle = () => false;
	await w.emit("agent_start", {}, ctxW);
	await w.emit("agent_end", { messages: [{ role: "assistant", content: [] }] }, ctxW);
	assert.equal(task(readState(), "t80").status, "done", "recovered task completes");
	await sleep(50);
	await w.command("stop", ctxW);
	// The timer surface — dispatch (setTimeout), watchdog (setInterval), and teardown
	// (clearTimer) — must run through the runner's MANAGED timers, not raw globals, so
	// a throwing tick is contained instead of surfacing as a session-fatal
	// uncaughtException (issue #5664). This mock ctx counts every managed call.
	assert.ok(ctxW.setIntervalCalls >= 1, "watchdog armed via ctx.setInterval");
	assert.ok(ctxW.setTimeoutCalls >= 1, "dispatch armed via ctx.setTimeout");
	assert.ok(ctxW.clearTimerCalls >= 1, "timers torn down via ctx.clearTimer");

	// 19. export: the whole queue lands in a human-workable markdown file.
	await w.command("export", ctxW);
	const defaultExport = path.join(tmpCwd, "scheduler-queue.md");
	assert.ok(fs.existsSync(defaultExport), "default export file created");
	{
		const md = fs.readFileSync(defaultExport, "utf8");
		assert.match(md, /## t80 — done/);
		assert.match(md, /Swallowed dispatch/);
		assert.match(md, /```text/);
	}
	await w.command("export custom-dump.md", ctxW);
	assert.ok(fs.existsSync(path.join(tmpCwd, "custom-dump.md")), "explicit export path honored");
	// Scenario 18 armed a 40ms watchdog on `w`; /scheduler stop leaves that interval
	// running until session_shutdown. Emit it now so the stale low-interval watchdog
	// cannot fire against later scenarios (which reuse the same state file), and
	// restore sane timers in the shared config so nothing inherits the 40ms cadence.
	await w.emit("session_shutdown", {}, ctxW);
	{
		const cReset = JSON.parse(fs.readFileSync(configFile, "utf8")) as SchedulerConfig;
		cReset.watchdogIntervalMs = 60_000;
		cReset.stallTimeoutMs = 600_000;
		cReset.maxAttempts = 3; // undo scenario 18's inflated budget so later scenarios see the default
		fs.writeFileSync(configFile, JSON.stringify(cReset));
	}

	// 20. add-file batch: comma-separated {prompt: "..."} objects — whitespace/
	// newline tolerant, bare or quoted keys, syntax-verified, capped at 30.
	const p = makeMockPi();
	const ctxP = makeCtx(tmpCwd);
	schedulerExtension(p.api);
	await p.emit("session_start", {}, ctxP);
	const batchDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-scheduler-batch-"));
	const seqBefore = readState().nextTaskSeq;

	// valid batch: messy separators (newline / no space / spaces), bare keys,
	// a quoted key, a trailing comma, and an escaped \n inside a prompt.
	const validBatch = path.join(batchDir, "batch.txt");
	fs.writeFileSync(
		validBatch,
		'{prompt: "task one"},\n{prompt: "task two"},{prompt: "task three"} ,\n\n  {"prompt": "task four"},{prompt: "task five\\nline two"},',
		"utf8",
	);
	await p.command(`add-file ${validBatch}`, ctxP);
	{
		const st = readState();
		assert.equal(st.nextTaskSeq, seqBefore + 5, "five tasks queued from batch");
		const batched = st.tasks.filter(t => t.sourceFile === validBatch);
		assert.equal(batched.length, 5);
		assert.deepEqual(
			batched.map(t => t.prompt),
			["task one", "task two", "task three", "task four", "task five\nline two"],
			"prompts parsed in order, whitespace stripped, \\n honored",
		);
		assert.ok(batched.every(t => t.status === "queued"));
		assert.match(ctxP.notifications.at(-1) ?? "", /queued 5 task\(s\) from batch file \(t\d+…t\d+\)/);
	}

	// syntax error: batch-shaped but broken JSON — refused atomically.
	const brokenBatch = path.join(batchDir, "broken.txt");
	fs.writeFileSync(brokenBatch, '{prompt: "unterminated}, {prompt: "ok"}', "utf8");
	{
		const before = readState().nextTaskSeq;
		await p.command(`add-file ${brokenBatch}`, ctxP);
		assert.match(ctxP.notifications.at(-1) ?? "", /invalid batch syntax.*nothing queued/s);
		assert.equal(readState().nextTaskSeq, before, "broken batch queues nothing");
	}

	// shape error: entry with a wrong key.
	const badShape = path.join(batchDir, "shape.txt");
	fs.writeFileSync(badShape, '{prompt: "fine"}, {task: "wrong key"}', "utf8");
	{
		const before = readState().nextTaskSeq;
		await p.command(`add-file ${badShape}`, ctxP);
		assert.match(ctxP.notifications.at(-1) ?? "", /expected a "prompt" key/);
		assert.equal(readState().nextTaskSeq, before, "bad shape queues nothing");
	}

	// empty prompt inside the batch.
	const emptyPrompt = path.join(batchDir, "empty.txt");
	fs.writeFileSync(emptyPrompt, '{prompt: "a"}, {prompt: "   "}', "utf8");
	{
		const before = readState().nextTaskSeq;
		await p.command(`add-file ${emptyPrompt}`, ctxP);
		assert.match(ctxP.notifications.at(-1) ?? "", /entry 2: empty prompt/);
		assert.equal(readState().nextTaskSeq, before, "empty prompt queues nothing");
	}

	// over the cap: 31 prompts refused outright.
	const bigBatch = path.join(batchDir, "big.txt");
	fs.writeFileSync(bigBatch, Array.from({ length: 31 }, (_, i) => `{prompt: "task ${i}"}`).join(",\n"), "utf8");
	{
		const before = readState().nextTaskSeq;
		await p.command(`add-file ${bigBatch}`, ctxP);
		assert.match(ctxP.notifications.at(-1) ?? "", /more than 30 prompts — max 30/);
		assert.equal(readState().nextTaskSeq, before, "oversized batch queues nothing");
	}

	// exactly 30 is fine.
	const maxBatch = path.join(batchDir, "max.txt");
	fs.writeFileSync(maxBatch, `[${Array.from({ length: 30 }, (_, i) => `{prompt: "task ${i}"}`).join(",")}]`, "utf8");
	{
		const before = readState().nextTaskSeq;
		await p.command(`add-file ${maxBatch}`, ctxP);
		assert.equal(readState().nextTaskSeq, before + 30, "30-prompt batch (bracketed form) accepted");
	}

	// plain-text file that merely starts with "{" still queues as ONE prompt
	// (no prompt-key probe match) — pre-batch behavior preserved.
	const plainCurly = path.join(batchDir, "plain.txt");
	fs.writeFileSync(plainCurly, "{a: 1} is the config shape I want; explain why", "utf8");
	{
		const before = readState().nextTaskSeq;
		await p.command(`add-file ${plainCurly}`, ctxP);
		const st = readState();
		assert.equal(st.nextTaskSeq, before + 1, "plain file = single task");
		assert.equal(
			st.tasks.find(t => t.sourceFile === plainCurly)?.prompt,
			"{a: 1} is the config shape I want; explain why",
		);
	}

	// 20b. add-file VERBATIM batch: "@@prompts" header, "---"-separated, no
	// escaping. Quotes, back/forward slashes, JSON, and multi-line/code bodies
	// must survive byte-for-byte — the whole point of the format.
	{
		const p1 = "Fix path C:\\Users\\me\\proj and url https://x/y";
		const p2 = 'Handle JSON {"retries": 3, "path": "a/b\\c"} and "quotes" here';
		const p3 = "Multi-line prompt\n\nwith a blank line and code:\n    const x = a + '/' + b;";
		const verbatim = path.join(batchDir, "verbatim.txt");
		fs.writeFileSync(verbatim, `@@prompts\n${p1}\n---\n${p2}\n---\n${p3}\n`, "utf8");
		const before = readState().nextTaskSeq;
		await p.command(`add-file ${verbatim}`, ctxP);
		const st = readState();
		assert.equal(st.nextTaskSeq, before + 3, "three verbatim prompts queued");
		assert.deepEqual(
			st.tasks.filter(t => t.sourceFile === verbatim).map(t => t.prompt),
			[p1, p2, p3],
			"verbatim prompts preserved exactly (slashes/quotes/JSON/newlines/code)",
		);
	}

	// 20c. custom separator via header — content that itself contains "---" lines
	// is kept intact because the user picks a boundary the content lacks.
	{
		const withDashes = "step one\n---\nstep two (literal --- inside one prompt)";
		const custom = path.join(batchDir, "custom-sep.txt");
		fs.writeFileSync(custom, `@@prompts sep=<<<<\n${withDashes}\n<<<<\nsecond prompt\n`, "utf8");
		const before = readState().nextTaskSeq;
		await p.command(`add-file ${custom}`, ctxP);
		const st = readState();
		assert.equal(st.nextTaskSeq, before + 2, "custom separator yields two prompts");
		assert.deepEqual(
			st.tasks.filter(t => t.sourceFile === custom).map(t => t.prompt),
			[withDashes, "second prompt"],
			"embedded --- kept verbatim; only the custom boundary splits",
		);
	}

	// 20d. CRLF endings + leading/trailing/doubled separators drop empties, not error.
	{
		const crlf = path.join(batchDir, "crlf.txt");
		fs.writeFileSync(crlf, "@@prompts\r\n---\r\nalpha\r\n---\r\n---\r\nbeta\r\n---\r\n", "utf8");
		const before = readState().nextTaskSeq;
		await p.command(`add-file ${crlf}`, ctxP);
		const st = readState();
		assert.equal(st.nextTaskSeq, before + 2, "CRLF + stray separators -> two prompts, no empties");
		assert.deepEqual(
			st.tasks.filter(t => t.sourceFile === crlf).map(t => t.prompt),
			["alpha", "beta"],
		);
	}

	// 20e. header present but only separators/blank -> refused atomically.
	{
		const emptyV = path.join(batchDir, "empty-verbatim.txt");
		fs.writeFileSync(emptyV, "@@prompts\n---\n   \n---\n", "utf8");
		const before = readState().nextTaskSeq;
		await p.command(`add-file ${emptyV}`, ctxP);
		assert.match(ctxP.notifications.at(-1) ?? "", /no non-empty prompts.*nothing queued/s);
		assert.equal(readState().nextTaskSeq, before, "all-empty verbatim batch queues nothing");
	}

	// 20f. bad header options are rejected (not silently treated as a plain prompt).
	{
		const badHdr = path.join(batchDir, "bad-header.txt");
		fs.writeFileSync(badHdr, "@@prompts weird=1\nalpha\n---\nbeta\n", "utf8");
		const before = readState().nextTaskSeq;
		await p.command(`add-file ${badHdr}`, ctxP);
		assert.match(ctxP.notifications.at(-1) ?? "", /bad @@prompts header.*nothing queued/s);
		assert.equal(readState().nextTaskSeq, before, "malformed header queues nothing");
	}

	// 20g. a plain file whose body merely starts with "---" (e.g. Markdown
	// frontmatter) is NOT a verbatim batch — no @@prompts header -> single task.
	{
		const frontmatter = path.join(batchDir, "frontmatter.txt");
		const body = "---\ntitle: Notes\ntags: [a, b]\n---\n\nActual prompt body here.";
		fs.writeFileSync(frontmatter, body, "utf8");
		const before = readState().nextTaskSeq;
		await p.command(`add-file ${frontmatter}`, ctxP);
		const st = readState();
		assert.equal(st.nextTaskSeq, before + 1, "frontmatter file = single task (no false split)");
		assert.equal(st.tasks.find(t => t.sourceFile === frontmatter)?.prompt, body);
	}

	// 21. content-policy ("cyber") violation: the poisoned conversation is purged
	// (newSession) and the task resumes in a clean context with the attempt
	// refunded — so total = completed and none fail to the cascade (t = n, m = 0).
	// ungated (openai) to keep the focus off quota/window math.
	{
		// scenario 18 left tiny watchdog/stall timers in the persisted config; the
		// mock's constant isIdle:true would otherwise let the watchdog steal the
		// re-dispatched turn. Restore sane timers so only the reset path drives.
		const c21 = JSON.parse(fs.readFileSync(configFile, "utf8")) as SchedulerConfig;
		c21.watchdogIntervalMs = 60_000;
		c21.stallTimeoutMs = 600_000;
		fs.writeFileSync(configFile, JSON.stringify(c21));
		const st = readState();
		st.run = "stopped";
		st.currentTaskId = null;
		st.rateLimitedUntil = null;
		st.windows = [];
		st.tasks = [
			{
				id: "t90",
				prompt: "Harden the auth middleware",
				status: "queued",
				addedAt: new Date().toISOString(),
				attempts: 0,
			},
		];
		st.nextTaskSeq = 91;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const cp = makeMockPi();
	const ctxCp = makeCtx(tmpCwd, { provider: "openai", id: "gpt-5" });
	schedulerExtension(cp.api);
	await cp.emit("session_start", {}, ctxCp);
	// The user starts the overnight run via the command — the ONLY context that
	// carries newSession (createCommandContext). The later content-policy purge
	// fires from a timer/event where newSession is gone, so it must reuse this one.
	await cp.command("start", ctxCp);
	await sleep(600); // cmdStart arms a 500ms initial dispatch
	assert.equal(cp.sentPrompts.length, 1, "t90 dispatched");
	assert.equal(task(readState(), "t90").attempts, 1, "first dispatch counts an attempt");
	// Anthropic content-policy rejection lands on agent_end.
	await cp.emit("agent_start", {}, ctxCp);
	await cp.emit(
		"agent_end",
		{
			messages: [
				{
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "Output blocked: content recognized as a violation of Anthropic's Usage Policy (cyber).",
				},
			],
		},
		ctxCp,
	);
	{
		const st = readState();
		const t90 = task(st, "t90");
		assert.equal(t90.status, "interrupted", "content-policy hit keeps the task resumable");
		assert.equal(t90.attempts, 0, "content-policy hit refunds the attempt (never counts toward maxAttempts)");
		assert.equal(t90.policyResets, 1, "content-policy reset counted separately from attempts");
		assert.equal(st.currentTaskId, null, "task settled off the in-flight slot");
	}
	// the next dispatch purges the poisoned context (newSession) then resumes t90.
	await sleep(220);
	assert.ok(ctxCp.newSessionCalls >= 1, "poisoned context purged via newSession before re-dispatch");
	assert.equal(cp.sentPrompts.length, 2, "t90 re-dispatched into the clean context");
	assert.match(cp.sentPrompts[1], /RESUME/);
	assert.match(cp.sentPrompts[1], /Harden the auth middleware/);
	assert.ok(
		fs
			.readFileSync(logFile, "utf8")
			.split("\n")
			.filter(Boolean)
			.map(l => JSON.parse(l) as { event: string })
			.some(e => e.event === "context_reset"),
		"a context_reset event is logged",
	);
	// clean-context resume succeeds → task done. t = n, m = 0.
	await cp.emit("agent_start", {}, ctxCp);
	await cp.emit("agent_end", { messages: [{ role: "assistant", content: [] }] }, ctxCp);
	{
		const st = readState();
		assert.equal(task(st, "t90").status, "done", "clean-context resume completes the task");
		assert.equal(
			st.tasks.filter(t => t.status === "failed").length,
			0,
			"no task failed to the cyber cascade (m = 0)",
		);
	}
	await sleep(50);
	await cp.command("stop", ctxCp);

	// 22. content-policy cap: a prompt that trips the classifier even in a clean
	// context (policyResets already at maxContextResets) is failed rather than
	// looped forever — the safety valve behind the m = 0 guarantee.
	{
		const c22 = JSON.parse(fs.readFileSync(configFile, "utf8")) as SchedulerConfig;
		c22.watchdogIntervalMs = 60_000;
		c22.stallTimeoutMs = 600_000;
		fs.writeFileSync(configFile, JSON.stringify(c22));
		const st = readState();
		st.run = "running";
		st.currentTaskId = null;
		st.rateLimitedUntil = null;
		st.windows = [];
		st.tasks = [
			{
				id: "t91",
				prompt: "Un-runnable prompt",
				status: "queued",
				addedAt: new Date().toISOString(),
				attempts: 0,
				policyResets: 5,
			},
		];
		st.nextTaskSeq = 92;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const cq = makeMockPi();
	const ctxCq = makeCtx(tmpCwd, { provider: "openai", id: "gpt-5" });
	schedulerExtension(cq.api);
	await cq.emit("session_start", {}, ctxCq);
	await sleep(80);
	assert.equal(cq.sentPrompts.length, 1, "t91 dispatched");
	await cq.emit("agent_start", {}, ctxCq);
	await cq.emit(
		"agent_end",
		{
			messages: [
				{
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "blocked: usage policy violation (cyber)",
				},
			],
		},
		ctxCq,
	);
	{
		const st = readState();
		assert.equal(task(st, "t91").status, "failed", "content-policy surviving maxContextResets purges is failed");
		assert.ok(
			ctxCq.notifications.some(n => n.includes("FAILED") && n.includes("content-policy")),
			"cap failure is announced",
		);
		// A terminal failure must be unmistakable in the log: classified, marked
		// TERMINAL, and carrying the recovery hint — the exact facts that were
		// missing when a "failed" line looked identical to a transient interrupt.
		const t91End = [...readLog()].reverse().find(e => e.event === "end" && e.taskId === "t91");
		assert.ok(t91End, "t91 end is logged");
		assert.equal(t91End?.classification, "content_policy", "terminal end records the content_policy classification");
		assert.equal(t91End?.terminal, true, "terminal end is flagged TERMINAL");
		assert.ok((t91End?.detail ?? "").includes("/scheduler retry"), "terminal end names the recovery command");
	}
	await sleep(50);
	await cq.command("stop", ctxCq);

	// 23. prompt-hash tracking + code-generated outcome ledger: a completed turn
	// records a stable prompt fingerprint, a ≤100-char summary lifted from the
	// turn's own final assistant line (no LLM call), and rewrites task-ledger.md.
	{
		const st = readState();
		st.run = "running";
		st.tasks = [
			{
				id: "t95",
				prompt: "Refactor the auth module and add tests",
				status: "queued",
				addedAt: new Date().toISOString(),
				attempts: 0,
			},
		];
		st.nextTaskSeq = 96;
		st.rateLimitedUntil = null;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const cl = makeMockPi();
	const ctxCl = makeCtx(tmpCwd, null); // ungated: no window/quota interference
	schedulerExtension(cl.api);
	await cl.emit("session_start", {}, ctxCl);
	await sleep(80);
	assert.equal(cl.sentPrompts.length, 1, "ledger scenario dispatches the queued task");
	// getState backfills the fingerprint on load even though the injected task had none.
	const t95Hash = task(readState(), "t95").promptHash;
	const expectedHash = crypto
		.createHash("sha256")
		.update("Refactor the auth module and add tests", "utf8")
		.digest("hex")
		.slice(0, 12);
	assert.equal(t95Hash, expectedHash, "promptHash is a stable SHA-256/12 fingerprint of the prompt");
	await cl.emit("agent_start", {}, ctxCl);
	await cl.emit(
		"agent_end",
		{
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "Done: refactored auth and added 12 tests." }] },
			],
		},
		ctxCl,
	);
	{
		const t95 = task(readState(), "t95");
		assert.equal(t95.status, "done", "turn completes");
		assert.equal(
			t95.summary,
			"Done: refactored auth and added 12 tests.",
			"summary is code-generated from the turn's own final assistant line — no LLM call",
		);
		const t95End = [...readLog()].reverse().find(e => e.event === "end" && e.taskId === "t95");
		assert.equal(t95End?.promptHash, expectedHash, "end log carries the prompt fingerprint");
		assert.equal(t95End?.summary, t95.summary, "end log carries the generated summary");
		// The ledger table is rewritten after the pass and is self-describing.
		const ledger = fs.readFileSync(ledgerFile, "utf8");
		assert.match(ledger, /\| hash \| status \| prompt \| summary \|/, "ledger has the table header");
		assert.match(
			ledger,
			new RegExp(`\\| \`${expectedHash}\` \\| done \\|.*Refactor the auth module.*\\|.*refactored auth.*\\|`),
			"ledger row keys by hash and holds prompt(100) + summary(100) + status",
		);
	}
	await sleep(50);
	await cl.command("ledger", ctxCl);
	assert.match(ctxCl.notifications.at(-1) ?? "", /task ledger/, "/scheduler ledger prints the table");
	assert.match(ctxCl.notifications.at(-1) ?? "", /#[0-9a-f]{12}\s+done/, "ledger command shows hash + status");
	await cl.command("stop", ctxCl);

	// 24. willContinue: a non-terminal agent_end (auto-retry / unexpected-stop
	// retry / auto-compaction continuation) must NOT settle the task or dispatch
	// the next one — the same turn is still coming. Only the final agent_end
	// (willContinue falsy) settles.
	{
		const st = readState();
		st.run = "running";
		st.currentTaskId = null;
		st.rateLimitedUntil = null;
		st.windows = [];
		st.tasks = [
			{ id: "t96", prompt: "Continuation task", status: "queued", addedAt: new Date().toISOString(), attempts: 0 },
		];
		st.nextTaskSeq = 97;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const wc = makeMockPi();
	const ctxWc = makeCtx(tmpCwd, { provider: "openai", id: "gpt-5" });
	schedulerExtension(wc.api);
	await wc.emit("session_start", {}, ctxWc);
	await sleep(80);
	assert.equal(wc.sentPrompts.length, 1, "t96 dispatched");
	assert.equal(readState().currentTaskId, "t96", "t96 in flight");
	await wc.emit("agent_start", {}, ctxWc);
	// A continuation end arrives first — the scheduler must ignore it.
	await wc.emit(
		"agent_end",
		{ messages: [{ role: "assistant", content: [], stopReason: "stop" }], willContinue: true },
		ctxWc,
	);
	{
		const st = readState();
		assert.equal(st.currentTaskId, "t96", "willContinue end leaves the task in flight");
		assert.equal(wc.sentPrompts.length, 1, "willContinue end does not dispatch the next task");
		assert.equal(task(st, "t96").status, "running", "willContinue end does not settle the task");
	}
	// The terminal end (no willContinue) finally settles it.
	await wc.emit("agent_end", { messages: [{ role: "assistant", content: [] }] }, ctxWc);
	assert.equal(task(readState(), "t96").status, "done", "terminal end settles the task done");
	await sleep(50);
	await wc.command("stop", ctxWc);

	// 25. the shipped default profile gates the Anthropic *provider*, not any model
	// id containing "claude": a third-party catalog serving Claude (Bedrock,
	// OpenRouter, …) must dispatch ungated under the defaults (regression guard —
	// the old "anthropic|claude" default gated them after 4 turns).
	{
		fs.rmSync(configFile, { force: true }); // drop the customized config so session_start re-seeds the shipped defaults
		const st = readState();
		st.run = "stopped";
		st.currentTaskId = null;
		st.rateLimitedUntil = null;
		st.windows = [];
		st.tasks = [];
		st.nextTaskSeq = 100;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const dp = makeMockPi();
	const ctxDp = makeCtx(tmpCwd, { provider: "bedrock", id: "anthropic.claude-3-sonnet" });
	schedulerExtension(dp.api);
	await dp.emit("session_start", {}, ctxDp);
	{
		const seeded = JSON.parse(fs.readFileSync(configFile, "utf8")) as SchedulerConfig;
		assert.equal(
			seeded.quotaProfiles[0].match,
			"^anthropic$",
			"shipped default is anchored to the anthropic provider, not any model id containing 'anthropic'",
		);
	}
	await dp.command("status", ctxDp);
	assert.match(
		ctxDp.notifications.at(-1) ?? "",
		/quota: none/,
		"a third-party catalog serving an anthropic.* model dispatches ungated under the defaults",
	);
	await dp.command("stop", ctxDp);

	// 26. a cancelled newSession (a hook vetoes the session switch) is NOT treated as
	// a successful purge: the scheduler falls back to compact instead of silently
	// re-sending the task into the still-poisoned transcript.
	{
		const c26 = JSON.parse(fs.readFileSync(configFile, "utf8")) as SchedulerConfig;
		c26.watchdogIntervalMs = 60_000;
		c26.stallTimeoutMs = 600_000;
		c26.dispatchDelayMs = 30;
		fs.writeFileSync(configFile, JSON.stringify(c26));
		const st = readState();
		st.run = "stopped";
		st.currentTaskId = null;
		st.rateLimitedUntil = null;
		st.windows = [];
		st.tasks = [
			{ id: "t97", prompt: "Poisoned task", status: "queued", addedAt: new Date().toISOString(), attempts: 0 },
		];
		st.nextTaskSeq = 98;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const rc = makeMockPi();
	const ctxRc = makeCtx(tmpCwd, { provider: "openai", id: "gpt-5" });
	ctxRc.newSessionCancelled = true; // a hook will veto the session switch
	schedulerExtension(rc.api);
	await rc.emit("session_start", {}, ctxRc);
	await rc.command("start", ctxRc); // capture the command context (carries newSession)
	await sleep(600); // cmdStart arms a 500ms initial dispatch
	assert.equal(rc.sentPrompts.length, 1, "t97 dispatched once");
	await rc.emit("agent_start", {}, ctxRc);
	await rc.emit(
		"agent_end",
		{
			messages: [
				{
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "blocked: usage policy violation (cyber)",
				},
			],
		},
		ctxRc,
	);
	await sleep(200);
	{
		assert.ok(ctxRc.newSessionCalls >= 1, "purge attempted via newSession");
		assert.ok(
			ctxRc.compactCalls >= 1,
			"cancelled newSession falls back to compact — not treated as a completed purge",
		);
		const resetLog = [...readLog()].reverse().find(e => e.event === "context_reset");
		assert.ok(resetLog, "a context_reset attempt is logged");
		assert.match(resetLog?.detail ?? "", /cancel/i, "the reset log records the newSession cancellation");
	}
	await rc.command("stop", ctxRc);

	// 27. a transient provider failure (outage) must not keep the session window
	// agent_start optimistically recorded — otherwise a long outage accrues phantom
	// windows that trip the 24h cap even though no Claude session was opened.
	{
		const c27 = JSON.parse(fs.readFileSync(configFile, "utf8")) as SchedulerConfig;
		c27.quotaProfiles = [
			{ match: "anthropic", sessionHours: 5, maxSessionsPer24h: 4 },
			{ match: ".*", sessionHours: null, maxSessionsPer24h: null },
		];
		c27.watchdogIntervalMs = 60_000;
		c27.stallTimeoutMs = 600_000;
		c27.dispatchDelayMs = 30;
		fs.writeFileSync(configFile, JSON.stringify(c27));
		const st = readState();
		st.run = "running";
		st.currentTaskId = null;
		st.rateLimitedUntil = null;
		st.windows = [];
		st.tasks = [
			{
				id: "t98",
				prompt: "Gated task during an outage",
				status: "queued",
				addedAt: new Date().toISOString(),
				attempts: 0,
			},
		];
		st.nextTaskSeq = 99;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const pw = makeMockPi();
	const ctxPw = makeCtx(tmpCwd, { provider: "anthropic", id: "claude-fable-5" });
	schedulerExtension(pw.api);
	await pw.emit("session_start", {}, ctxPw);
	await sleep(80);
	assert.equal(pw.sentPrompts.length, 1, "t98 dispatched");
	await pw.emit("agent_start", {}, ctxPw);
	assert.equal(readState().windows.length, 1, "agent_start optimistically records a session window");
	// the turn never reaches the provider — a DNS/connection outage exhausts retries
	await pw.emit(
		"auto_retry_end",
		{ success: false, finalError: "fetch failed: getaddrinfo ENOTFOUND api.anthropic.com" },
		ctxPw,
	);
	await pw.emit("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "stop" }] }, ctxPw);
	{
		const st = readState();
		assert.equal(st.windows.length, 0, "the phantom window is refunded — a failed probe opened no real session");
		assert.equal(task(st, "t98").attempts, 0, "outage also refunds the task attempt");
	}
	await pw.command("stop", ctxPw);

	// 28. a length-truncated terminal turn (the core could not auto-continue) is an
	// interruption, not a silent success: unattended work is resumed/failed visibly
	// rather than recorded done.
	{
		const c28 = JSON.parse(fs.readFileSync(configFile, "utf8")) as SchedulerConfig;
		c28.dispatchDelayMs = 30;
		fs.writeFileSync(configFile, JSON.stringify(c28));
		const st = readState();
		st.run = "running";
		st.currentTaskId = null;
		st.rateLimitedUntil = null;
		st.windows = [];
		st.tasks = [
			{
				id: "t99",
				prompt: "Big task that truncates",
				status: "queued",
				addedAt: new Date().toISOString(),
				attempts: 0,
			},
		];
		st.nextTaskSeq = 100;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const ln = makeMockPi();
	const ctxLn = makeCtx(tmpCwd, { provider: "openai", id: "gpt-5" });
	schedulerExtension(ln.api);
	await ln.emit("session_start", {}, ctxLn);
	await sleep(80);
	assert.equal(ln.sentPrompts.length, 1, "t99 dispatched");
	await ln.emit("agent_start", {}, ctxLn);
	await ln.emit(
		"agent_end",
		{ messages: [{ role: "assistant", content: [{ type: "text", text: "partial…" }], stopReason: "length" }] },
		ctxLn,
	);
	{
		const st = readState();
		assert.equal(task(st, "t99").status, "interrupted", "a length-truncated turn interrupts (not done) for resume");
	}
	await sleep(120);
	assert.ok(ln.sentPrompts.length >= 2, "truncated task is resumed");
	assert.match(ln.sentPrompts.at(-1) ?? "", /RESUME/);
	await ln.command("stop", ctxLn);

	// 29. a delivery failure (sendUserMessage throws before the turn starts) respects
	// the attempt budget instead of retrying forever — with attempts already at the
	// cap, the failed delivery fails the task rather than re-arming every 30s.
	{
		const c29 = JSON.parse(fs.readFileSync(configFile, "utf8")) as SchedulerConfig;
		c29.maxAttempts = 2;
		c29.dispatchDelayMs = 30;
		fs.writeFileSync(configFile, JSON.stringify(c29));
		const st = readState();
		st.run = "running";
		st.currentTaskId = null;
		st.rateLimitedUntil = null;
		st.windows = [];
		st.tasks = [
			{ id: "t100", prompt: "Undeliverable", status: "interrupted", addedAt: new Date().toISOString(), attempts: 1 },
		];
		st.nextTaskSeq = 101;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const df = makeMockPi();
	df.setFailSend(true); // the host mode rejects prompt delivery
	const ctxDf = makeCtx(tmpCwd, { provider: "openai", id: "gpt-5" });
	schedulerExtension(df.api);
	await df.emit("session_start", {}, ctxDf);
	await sleep(120);
	{
		const st = readState();
		assert.equal(df.sentPrompts.length, 0, "nothing delivered — sendUserMessage threw");
		assert.equal(
			task(st, "t100").status,
			"failed",
			"delivery failure at the attempt budget fails the task (no infinite retry)",
		);
		assert.equal(st.currentTaskId, null, "failed delivery clears the in-flight slot");
	}
	await sleep(120); // the old buggy path would re-dispatch here; it must not
	assert.equal(df.sentPrompts.length, 0, "a budget-exhausted delivery failure is not retried");
	await df.command("stop", ctxDf);

	// 30. a corrupt config.json is preserved, not silently reseeded with defaults
	// (which would destroy the user's edits): readJson distinguishes ENOENT from a
	// parse error, and loadConfig leaves an unreadable file untouched.
	{
		fs.writeFileSync(configFile, "{ this is not valid json ]");
		const st = readState();
		st.run = "stopped";
		st.currentTaskId = null;
		st.tasks = [];
		st.windows = [];
		st.nextTaskSeq = 102;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const cf = makeMockPi();
	const ctxCf = makeCtx(tmpCwd, { provider: "openai", id: "gpt-5" });
	schedulerExtension(cf.api);
	await cf.emit("session_start", {}, ctxCf);
	await cf.command("status", ctxCf); // loadConfig runs again; must not overwrite the bad file
	assert.equal(
		fs.readFileSync(configFile, "utf8"),
		"{ this is not valid json ]",
		"corrupt config.json is left untouched (not reseeded with defaults)",
	);
	assert.ok(
		ctxCf.notifications.some(n => /corrupt|unreadable/i.test(n)),
		"the corrupt config is surfaced to the user",
	);
	await cf.command("stop", ctxCf);

	// 31. /scheduler retry on a task that failed via maxContextResets restores the
	// full reset budget — policyResets is cleared alongside attempts, so the retried
	// task is not failed on its very next content-policy hit.
	{
		fs.rmSync(configFile, { force: true }); // reseed a clean default config after scenario 30
		const st = readState();
		st.run = "stopped";
		st.currentTaskId = null;
		st.windows = [];
		st.tasks = [
			{
				id: "t101",
				prompt: "Repeatedly flagged",
				status: "failed",
				addedAt: new Date().toISOString(),
				attempts: 3,
				policyResets: 5,
			},
		];
		st.nextTaskSeq = 102;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const rt = makeMockPi();
	const ctxRt = makeCtx(tmpCwd, { provider: "openai", id: "gpt-5" });
	schedulerExtension(rt.api);
	await rt.emit("session_start", {}, ctxRt);
	await rt.command("retry t101", ctxRt);
	{
		const t101 = task(readState(), "t101");
		assert.equal(t101.status, "interrupted", "retry re-queues the failed task");
		assert.equal(t101.attempts, 0, "retry resets the attempt budget");
		assert.equal(t101.policyResets, 0, "retry also resets the content-policy reset budget");
	}
	await rt.command("stop", ctxRt);

	// 32. a dispatched turn that never materializes (no agent_start/agent_end — an
	// undeliverable prompt: no model, a rejecting pre-turn hook, an async send
	// failure) is failed after maxAttempts consecutive watchdog stalls instead of
	// looping on refunded attempts forever.
	{
		const c32 = JSON.parse(fs.readFileSync(configFile, "utf8")) as SchedulerConfig;
		c32.maxAttempts = 2;
		c32.watchdogIntervalMs = 20;
		c32.stallTimeoutMs = 20;
		c32.dispatchDelayMs = 20;
		fs.writeFileSync(configFile, JSON.stringify(c32));
		const st = readState();
		st.run = "running";
		st.currentTaskId = null;
		st.rateLimitedUntil = null;
		st.windows = [];
		st.tasks = [
			{ id: "t102", prompt: "Never starts", status: "queued", addedAt: new Date().toISOString(), attempts: 0 },
		];
		st.nextTaskSeq = 103;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const sc = makeMockPi();
	const ctxSc = makeCtx(tmpCwd, { provider: "openai", id: "gpt-5" });
	schedulerExtension(sc.api);
	await sc.emit("session_start", {}, ctxSc);
	// never emit agent_start/agent_end: the watchdog keeps finding the task in flight
	// with an idle agent. After maxAttempts consecutive stalls it must fail the task.
	for (let k = 0; k < 200 && task(readState(), "t102").status !== "failed"; k++) await sleep(20);
	{
		const t102 = task(readState(), "t102");
		assert.equal(
			t102.status,
			"failed",
			"an undeliverable dispatch fails after maxAttempts consecutive stalls (no infinite refund loop)",
		);
		assert.ok((t102.stalls ?? 0) >= 2, "the consecutive-stall counter (== maxAttempts) drove the terminal failure");
		assert.ok(
			ctxSc.notifications.some(n => /never started|watchdog recoveries/i.test(n)),
			"the stall failure surfaces the undeliverable-dispatch reason",
		);
		assert.ok(
			!ctxSc.notifications.some(n => /content-policy violation persisted/i.test(n)),
			"a watchdog stall failure is NOT mislabeled as a content-policy reset",
		);
	}
	await sc.command("stop", ctxSc);

	// 33. the approval-mode preflight parses YAML properly (Bun.YAML), so a FLOW-style
	// `tools: { approvalMode: ... }` in config.yaml is detected — the old single-line
	// regex missed inline maps and silently skipped the non-yolo warning.
	{
		fs.rmSync(path.join(tmpAgentDir, "config.yml"), { force: true }); // drop scenario 3's block-style file
		fs.writeFileSync(path.join(tmpAgentDir, "config.yaml"), "tools: { approvalMode: always-ask }\n");
		fs.rmSync(configFile, { force: true });
		const st = readState();
		st.run = "stopped";
		st.currentTaskId = null;
		st.tasks = [];
		st.windows = [];
		st.nextTaskSeq = 104;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const fy = makeMockPi();
	const ctxFy = makeCtx(tmpCwd, { provider: "openai", id: "gpt-5" });
	schedulerExtension(fy.api);
	await fy.emit("session_start", {}, ctxFy);
	await fy.command("start", ctxFy);
	assert.equal(
		ctxFy.confirmCalls,
		1,
		"flow-style tools:{approvalMode} in config.yaml is parsed, so the non-yolo warning fires",
	);
	await fy.command("stop", ctxFy);
	fs.rmSync(path.join(tmpAgentDir, "config.yaml"), { force: true });

	// 34. the preflight warns if ANY settings layer is non-yolo — an earlier yolo
	// layer must not mask a later non-yolo one, since the extension can't know the
	// host's merge precedence and must never under-warn on an unattended run.
	{
		fs.rmSync(configFile, { force: true });
		fs.mkdirSync(path.join(tmpCwd, ".omp"), { recursive: true });
		fs.mkdirSync(path.join(tmpCwd, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(tmpCwd, ".omp", "config.yml"), "tools:\n  approvalMode: yolo\n");
		fs.writeFileSync(path.join(tmpCwd, ".claude", "settings.json"), '{ "tools": { "approvalMode": "write" } }');
		const st = readState();
		st.run = "stopped";
		st.currentTaskId = null;
		st.tasks = [];
		st.windows = [];
		st.nextTaskSeq = 105;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const pa = makeMockPi();
	const ctxPa = makeCtx(tmpCwd, { provider: "openai", id: "gpt-5" });
	schedulerExtension(pa.api);
	await pa.emit("session_start", {}, ctxPa);
	await pa.command("start", ctxPa);
	assert.equal(ctxPa.confirmCalls, 1, "a non-yolo .claude layer still warns even though .omp/config.yml is yolo");
	await pa.command("stop", ctxPa);
	fs.rmSync(path.join(tmpCwd, ".omp"), { recursive: true, force: true });
	fs.rmSync(path.join(tmpCwd, ".claude"), { recursive: true, force: true });
	fs.rmSync(configFile, { force: true });
	fs.writeFileSync(stateFile, "{}");
	const iv = makeMockPi();
	const ctxIv = makeCtx(tmpCwd, { provider: "openai", id: "gpt-5" });
	schedulerExtension(iv.api);
	await iv.emit("session_start", {}, ctxIv);
	await iv.command("add hello world", ctxIv); // mutating → must be refused
	assert.equal(
		fs.readFileSync(stateFile, "utf8"),
		"{}",
		"structurally invalid state.json is left untouched (not reseeded/clobbered)",
	);
	assert.ok(
		ctxIv.notifications.some(n => /malformed|corrupt|unreadable/i.test(n)),
		"the invalid state is surfaced and mutating commands refused",
	);
	await iv.command("stop", ctxIv);

	// 36. while a context purge is in flight (slow newSession), the interrupted
	// task is NOT re-dispatched into the not-yet-purged transcript — the
	// resetInFlight guard (and the watchdog's !resetInFlight check) hold dispatch
	// until the purge resolves. Without it the watchdog would re-send the poisoned
	// prompt and re-trip the classifier the reset was meant to avoid.
	{
		fs.rmSync(configFile, { force: true });
		const st = {
			version: 2,
			run: "stopped",
			tasks: [{ id: "t103", prompt: "Poisoned", status: "queued", addedAt: new Date().toISOString(), attempts: 0 }],
			currentTaskId: null,
			rateLimitedUntil: null,
			windows: [],
			nextTaskSeq: 104,
		};
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const rf = makeMockPi();
	const ctxRf = makeCtx(tmpCwd, { provider: "openai", id: "gpt-5" });
	ctxRf.newSessionDelayMs = 300; // slow purge so the in-flight window is observable
	schedulerExtension(rf.api);
	await rf.emit("session_start", {}, ctxRf);
	{
		const c = JSON.parse(fs.readFileSync(configFile, "utf8")) as SchedulerConfig;
		c.dispatchDelayMs = 20;
		c.watchdogIntervalMs = 30;
		c.stallTimeoutMs = 600_000;
		fs.writeFileSync(configFile, JSON.stringify(c));
	}
	await rf.command("start", ctxRf); // captures the command ctx (newSession) + dispatches t103
	await sleep(600); // cmdStart arms a 500ms initial dispatch
	assert.equal(rf.sentPrompts.length, 1, "t103 dispatched");
	await rf.emit("agent_start", {}, ctxRf);
	await rf.emit(
		"agent_end",
		{
			messages: [
				{
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "blocked: usage policy violation (cyber)",
				},
			],
		},
		ctxRf,
	);
	await sleep(120); // reset is now in flight (newSession sleeping 300ms)
	assert.equal(rf.sentPrompts.length, 1, "the task is NOT re-dispatched while the purge is in flight");
	await sleep(400); // let newSession resolve and the clean re-dispatch happen
	assert.ok(rf.sentPrompts.length >= 2, "task is re-dispatched only after the purge completes");
	await rf.command("stop", ctxRf);
	fs.rmSync(configFile, { force: true });
	fs.writeFileSync(
		stateFile,
		JSON.stringify({ version: 2, run: "stopped", currentTaskId: null, nextTaskSeq: 1, tasks: [{}] }),
	);
	const tr = makeMockPi();
	const ctxTr = makeCtx(tmpCwd, { provider: "openai", id: "gpt-5" });
	schedulerExtension(tr.api);
	await tr.emit("session_start", {}, ctxTr);
	await tr.command("add hello", ctxTr); // mutating → must be refused, not crash
	assert.ok(
		ctxTr.notifications.some(n => /malformed|corrupt|unreadable/i.test(n)),
		"a tasks array with malformed rows is treated as unreadable state",
	);
	await tr.command("stop", ctxTr);

	// 38. a per-tool approval policy (tools.approval.<tool> != "allow") triggers
	// the start warning even when approvalMode is yolo — the core honors per-tool
	// policies in every mode, so an overnight run could still block otherwise.
	{
		fs.rmSync(configFile, { force: true });
		fs.mkdirSync(path.join(tmpCwd, ".omp"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpCwd, ".omp", "config.yml"),
			"tools:\n  approvalMode: yolo\n  approval:\n    bash: prompt\n",
		);
		const st = readState();
		st.run = "stopped";
		st.currentTaskId = null;
		st.tasks = [];
		st.windows = [];
		st.nextTaskSeq = 106;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const pt = makeMockPi();
	const ctxPt = makeCtx(tmpCwd, { provider: "openai", id: "gpt-5" });
	schedulerExtension(pt.api);
	await pt.emit("session_start", {}, ctxPt);
	await pt.command("start", ctxPt);
	assert.equal(ctxPt.confirmCalls, 1, "a non-allow per-tool approval policy warns even under approvalMode: yolo");
	await pt.command("stop", ctxPt);
	fs.rmSync(path.join(tmpCwd, ".omp"), { recursive: true, force: true });

	// 39. approval settings merged by OTHER providers are covered too — e.g. a
	// project `.codex/config.toml` (TOML) with a non-yolo approvalMode triggers the
	// warning, since the core merges every provider's project settings verbatim.
	{
		fs.rmSync(configFile, { force: true });
		fs.mkdirSync(path.join(tmpCwd, ".codex"), { recursive: true });
		fs.writeFileSync(path.join(tmpCwd, ".codex", "config.toml"), '[tools]\napprovalMode = "write"\n');
		const st = readState();
		st.run = "stopped";
		st.currentTaskId = null;
		st.tasks = [];
		st.windows = [];
		st.nextTaskSeq = 107;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const cx = makeMockPi();
	const ctxCx = makeCtx(tmpCwd, { provider: "openai", id: "gpt-5" });
	schedulerExtension(cx.api);
	await cx.emit("session_start", {}, ctxCx);
	await cx.command("start", ctxCx);
	assert.equal(
		ctxCx.confirmCalls,
		1,
		"a non-yolo approvalMode in a provider's project file (.codex/config.toml) warns",
	);
	await cx.command("stop", ctxCx);
	fs.rmSync(path.join(tmpCwd, ".codex"), { recursive: true, force: true });

	// 40. if the session shuts down while a content-policy purge is in flight, the
	// purge's `.finally` must NOT arm a dispatch against the torn-down session.
	{
		fs.rmSync(configFile, { force: true });
		const st = {
			version: 2,
			run: "stopped",
			tasks: [{ id: "t104", prompt: "Poisoned", status: "queued", addedAt: new Date().toISOString(), attempts: 0 }],
			currentTaskId: null,
			rateLimitedUntil: null,
			windows: [],
			nextTaskSeq: 105,
		};
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const sd = makeMockPi();
	const ctxSd = makeCtx(tmpCwd, { provider: "openai", id: "gpt-5" });
	ctxSd.newSessionDelayMs = 300; // slow purge so shutdown lands mid-reset
	schedulerExtension(sd.api);
	await sd.emit("session_start", {}, ctxSd);
	{
		const c = JSON.parse(fs.readFileSync(configFile, "utf8")) as SchedulerConfig;
		c.dispatchDelayMs = 20;
		c.watchdogIntervalMs = 30;
		c.stallTimeoutMs = 600_000;
		fs.writeFileSync(configFile, JSON.stringify(c));
	}
	await sd.command("start", ctxSd);
	await sleep(600);
	assert.equal(sd.sentPrompts.length, 1, "t104 dispatched");
	await sd.emit("agent_start", {}, ctxSd);
	await sd.emit(
		"agent_end",
		{
			messages: [
				{
					role: "assistant",
					content: [],
					stopReason: "error",
					errorMessage: "blocked: usage policy violation (cyber)",
				},
			],
		},
		ctxSd,
	);
	await sleep(80); // reset now in flight (newSession sleeping 300ms)
	await sd.emit("session_shutdown", {}, ctxSd); // shut down mid-purge
	const afterShutdown = sd.sentPrompts.length;
	await sleep(400); // let the purge resolve — its .finally must not re-dispatch
	assert.equal(
		sd.sentPrompts.length,
		afterShutdown,
		"no dispatch is armed after shutdown, even when an in-flight purge resolves later",
	);
	fs.rmSync(configFile, { force: true });
	fs.writeFileSync(
		stateFile,
		JSON.stringify({
			version: 2,
			run: "stopped",
			currentTaskId: null,
			nextTaskSeq: 2,
			tasks: [{ id: "t1", prompt: "x" }],
		}),
	);
	const fv = makeMockPi();
	const ctxFv = makeCtx(tmpCwd, { provider: "openai", id: "gpt-5" });
	schedulerExtension(fv.api);
	await fv.emit("session_start", {}, ctxFv);
	await fv.command("add hello", ctxFv); // mutating → must be refused, not persist over the bad file
	assert.ok(
		ctxFv.notifications.some(n => /malformed|corrupt|unreadable/i.test(n)),
		"a task row missing required fields is treated as unreadable state",
	);
	await fv.command("stop", ctxFv);

	// 42. a config.json with a wrong-typed field (promptPreamble: number) falls
	// back to defaults for the session WITHOUT overwriting the file, rather than
	// merging a number that later crashes string helpers (.trim()/truncate()).
	{
		fs.writeFileSync(configFile, JSON.stringify({ promptPreamble: 123 }));
		const st = readState();
		st.run = "stopped";
		st.currentTaskId = null;
		st.tasks = [];
		st.windows = [];
		st.nextTaskSeq = 108;
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const cv = makeMockPi();
	const ctxCv = makeCtx(tmpCwd, { provider: "openai", id: "gpt-5" });
	schedulerExtension(cv.api);
	await cv.emit("session_start", {}, ctxCv);
	await cv.command("status", ctxCv); // exercises loadConfig; a merged number would crash a string helper
	assert.equal(
		JSON.parse(fs.readFileSync(configFile, "utf8")).promptPreamble,
		123,
		"a wrong-typed config.json is left untouched (not normalized/overwritten)",
	);
	assert.ok(
		ctxCv.notifications.some(n => /malformed|wrong type|corrupt/i.test(n)),
		"the wrong-typed config is surfaced and defaults used for the session",
	);
	await cv.command("stop", ctxCv);
	fs.rmSync(configFile, { force: true });
	fs.writeFileSync(
		stateFile,
		JSON.stringify({ version: 2, run: "stopped", currentTaskId: null, nextTaskSeq: 1, tasks: [], windows: [{}] }),
	);
	const wv = makeMockPi();
	const ctxWv = makeCtx(tmpCwd, { provider: "openai", id: "gpt-5" });
	schedulerExtension(wv.api);
	await wv.emit("session_start", {}, ctxWv);
	await wv.command("add hello", ctxWv);
	assert.ok(
		ctxWv.notifications.some(n => /malformed|corrupt|unreadable/i.test(n)),
		"a malformed window row is treated as unreadable state",
	);
	await wv.command("stop", ctxWv);

	// 44. a resume timer armed before shutdown (rate-limit hold) must not dispatch
	// after the session is torn down — the sink guard in tryDispatch makes any
	// surviving timer callback inert.
	{
		fs.rmSync(configFile, { force: true });
		const st = {
			version: 2,
			run: "stopped",
			tasks: [{ id: "t105", prompt: "x", status: "queued", addedAt: new Date().toISOString(), attempts: 0 }],
			currentTaskId: null,
			rateLimitedUntil: null,
			windows: [],
			nextTaskSeq: 106,
		};
		fs.writeFileSync(stateFile, JSON.stringify(st));
	}
	const rz = makeMockPi();
	const ctxRz = makeCtx(tmpCwd, { provider: "openai", id: "gpt-5" });
	schedulerExtension(rz.api);
	await rz.emit("session_start", {}, ctxRz);
	{
		const c = JSON.parse(fs.readFileSync(configFile, "utf8")) as SchedulerConfig;
		c.dispatchDelayMs = 20;
		c.watchdogIntervalMs = 60_000;
		c.stallTimeoutMs = 600_000;
		fs.writeFileSync(configFile, JSON.stringify(c));
	}
	await rz.command("start", ctxRz);
	await sleep(600);
	assert.equal(rz.sentPrompts.length, 1, "t105 dispatched");
	await rz.emit("agent_start", {}, ctxRz);
	await rz.emit(
		"auto_retry_end",
		{ success: false, finalError: "Provider requested 1000ms wait. Original error: 429 retry-after-ms=1000" },
		ctxRz,
	);
	await rz.emit("agent_end", { messages: [{ role: "assistant", content: [], stopReason: "stop" }] }, ctxRz);
	await sleep(100); // a resume timer (~1s) is now armed
	await rz.emit("session_shutdown", {}, ctxRz);
	const afterShutdownRz = rz.sentPrompts.length;
	await sleep(1400); // past the resume time — the timer must not dispatch
	assert.equal(rz.sentPrompts.length, afterShutdownRz, "a resume timer does not dispatch after shutdown");

	console.log("smoke: all assertions passed");
	console.log(`smoke: data dir was ${tmpAgentDir}`);
}

// Executed directly (`bun test/smoke.ts`) → run the suite. When imported by
// smoke.test.ts (not the entry point), the wrapper calls runSmoke() inside a
// try/finally so global env/resolver state is restored even on a failing scenario.
if (import.meta.main) await runSmoke();
