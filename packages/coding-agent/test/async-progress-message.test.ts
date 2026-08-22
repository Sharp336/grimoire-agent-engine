import { beforeAll, describe, expect, test } from "bun:test";
import * as os from "node:os";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	buildAsyncProgressBlock,
	buildAsyncResultBlock,
} from "@oh-my-pi/pi-coding-agent/modes/utils/transcript-render-helpers";
import {
	ASYNC_PROGRESS_MESSAGE_TYPE,
	type AsyncProgressEntry,
	buildAsyncProgressBatchMessage,
	buildAsyncResultBatchMessage,
} from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";

function job(id: string): AsyncJob {
	return {
		id,
		type: "bash",
		status: "running",
		startTime: 0,
		label: id,
		abortController: new AbortController(),
		promise: Promise.resolve(),
	};
}

function entry(jobId: string, text: string, seq = 1): AsyncProgressEntry {
	return { jobId, text, seq, job: job(jobId), elapsedMs: 5_000, epoch: 0, delivery: "ambient" };
}

function content(message: { content: unknown } | null): string {
	if (!message || typeof message.content !== "string") throw new Error("Expected text content");
	return message.content;
}

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Failed to load dark theme for tests");
	setThemeInstance(theme);
});

describe("async progress messages", () => {
	test("preserves every permitted event while batching updates by job", () => {
		const longEvent = "x".repeat(500);
		const message = buildAsyncProgressBatchMessage([
			entry("bg_1", "first", 1),
			entry("bg_1", `second\n${longEvent}`, 2),
			entry("bg_2", "important", 1),
		]);
		const jobs = message?.details?.jobs ?? [];

		expect(message?.customType).toBe(ASYNC_PROGRESS_MESSAGE_TYPE);
		expect(jobs).toHaveLength(2);
		expect(jobs[0]?.text).toBe(`first\nsecond\n${longEvent}`);
		expect(content(message)).toContain("first");
		expect(content(message)).toContain("second");
		expect(content(message)).toContain(longEvent);
		expect(content(message)).toContain("important");
		expect(content(message)).toContain("<system-notice>");
		expect(content(message)).toContain('<job-progress id="bg_1" type="bash" elapsed="5.0s">');
		expect(content(message)).not.toContain("background jobs emitted output");
		expect(content(message)).not.toContain("Resume your work");
		expect(content(message)).toEndWith("</system-notice>");
	});

	test("retains the outer output around rate-limited progress events", () => {
		const message = buildAsyncProgressBatchMessage([
			{
				...entry("bg_chatty", "line 1\nline 2\nline 98\nline 99", 21),
				artifactId: "chatty-output",
				suppressedEvents: 9,
			},
		]);
		if (!message) throw new Error("Expected progress message");

		const xml = content(message);
		const output = "<output>";
		const suppressed = '<suppressed reason="rate-limit" events="9" full-output="artifact://chatty-output" />';
		expect(xml).toContain(
			`${output}\n<head>\nline 1\nline 2\n</head>\n${suppressed}\n<tail>\nline 98\nline 99\n</tail>`,
		);
		expect(xml.indexOf(output)).toBeLessThan(xml.indexOf(suppressed));
		expect(xml.indexOf(suppressed)).toBeLessThan(xml.indexOf("</output>"));
		expect(xml).not.toContain(`${suppressed}\n<output`);
		expect(xml).not.toContain("<system-reminder>");
		const rendered = Bun.stripANSI(buildAsyncProgressBlock(message).render(100).join("\n"));
		expect(rendered).toContain("line 1");
		expect(rendered).toContain("line 99");
		expect(rendered).toContain("9 progress events suppressed (rate limit)");
		expect(rendered).toContain("Read artifact://chatty-output for full output");
	});

	test("repeats the system prompt's chatty Bash guidance on every fifth suppression report", () => {
		const message = buildAsyncProgressBatchMessage([
			{
				...entry("bg_chatty", "", 62),
				artifactId: "chatty-output",
				suppressedEvents: 9,
				reminder: "chatty-monitor",
			},
		]);

		expect(content(message)).toContain(
			'<output>\n<suppressed reason="rate-limit" events="9" full-output="artifact://chatty-output" />\n</output>',
		);
		expect(content(message)).toContain("Repeated non-actionable progress → NEVER narrate or echo each event.");
		expect(content(message)).toContain(
			"Transient burst? Ignore it and await completion. Sustained/chatty? Reduce source verbosity.",
		);
		expect(content(message)).toContain("Safe restart? Stop/cancel; relaunch with native quiet/warning-only flags.");
		expect(content(message)).toContain("Unsafe restart? Let it finish silently.");
		expect(content(message)).not.toContain("Retune its monitor");
		expect(content(message)).toEndWith("</system-reminder>");
	});

	test("repeats the matching Hub guidance for a chatty process monitor", () => {
		const message = buildAsyncProgressBatchMessage([
			{
				...entry("monitor-web", "still compiling", 62),
				job: undefined,
				source: { id: "daemon-web", type: "process", label: "web", startedAt: 0 },
				artifactId: "monitor-output",
				suppressedEvents: 4,
				reminder: "chatty-monitor",
			},
		]);

		expect(content(message)).toContain("<system-reminder>");
		expect(content(message)).toContain("Sustained/chatty? Reduce source verbosity.");
		expect(content(message)).toContain("Unsafe restart? Let it finish silently.");
		expect(content(message)).toContain("Retune its monitor to `ambient` or `off`.");
	});

	test("does not emit an empty chatty reminder for unsupported progress sources", () => {
		const message = buildAsyncProgressBatchMessage([
			{
				...entry("task-chatty", "still working", 62),
				job: { ...job("task-chatty"), type: "task" },
				suppressedEvents: 4,
				reminder: "chatty-monitor",
			},
		]);

		expect(content(message)).toContain('<suppressed reason="rate-limit" events="4"');
		expect(content(message)).not.toContain("<system-reminder>");
	});

	test("asks the agent to resume only when progress wakes a follow-up turn", () => {
		const wakeEntry = { ...entry("bg_3", "ready"), delivery: "wake" as const };
		const message = buildAsyncProgressBatchMessage([wakeEntry]);

		expect(content(message)).toContain("Resume your work using this update.");
		expect(content(message)).toContain("<output>\nready\n</output>");
		expect(content(message)).not.toContain("Background job bg_3 emitted output");
	});

	test("bounds model output and points truncated progress at its stable artifact", () => {
		const middle = "middle-data\n".repeat(500);
		const message = buildAsyncProgressBatchMessage([
			{
				...entry("bg_4", `HEAD\n${middle}TAIL`),
				artifactId: "async-output-4",
			},
		]);
		if (!message) throw new Error("Expected progress message");

		expect(message.details?.jobs[0]).toMatchObject({
			jobId: "bg_4",
			artifactId: "async-output-4",
			truncated: true,
		});
		const preview = message.details?.jobs[0];
		expect(preview?.text).toBeUndefined();
		expect(preview?.head).toStartWith("HEAD");
		expect(preview?.tail).toEndWith("TAIL");
		expect(preview?.head).not.toContain("TAIL");
		expect(preview?.tail).not.toContain("HEAD");
		expect(Buffer.byteLength(`${preview?.head ?? ""}${preview?.tail ?? ""}`, "utf8")).toBeLessThanOrEqual(3_000);
		expect(content(message)).toContain("<output>\n<head>\nHEAD");
		expect(content(message)).toContain(
			'<suppressed reason="preview-limit" full-output="artifact://async-output-4" />',
		);
		expect(content(message)).toContain("TAIL\n</tail>\n</output>");
		expect(content(message)).not.toContain("<output>\nHEAD");
		const rendered = Bun.stripANSI(buildAsyncProgressBlock(message).render(100).join("\n"));
		expect(rendered).toContain("HEAD");
		expect(rendered).toContain("TAIL");
		expect(rendered).toContain("Read artifact://async-output-4 for full output");
	});

	test("renders a fitting source-truncated line verbatim behind a suppression marker", () => {
		const line = `${"H".repeat(250)}${"T".repeat(250)}`;
		const message = buildAsyncProgressBatchMessage([
			{
				...entry("bg_5", line),
				artifactId: "async-output-5",
				sourceTruncated: true,
			},
		]);
		if (!message) throw new Error("Expected progress message");

		// The window fits the preview budget, so its text must stay verbatim -
		// never byte-split into a fabricated head/tail pair.
		expect(message.details?.jobs[0]).toMatchObject({
			text: line,
			artifactId: "async-output-5",
			truncated: true,
		});
		expect(content(message)).toContain(
			`<suppressed reason="preview-limit" full-output="artifact://async-output-5" />\n${line}\n</output>`,
		);
		expect(content(message)).not.toContain("<head>");
	});

	test("renders the custom message as sanitized progress rather than a completion", () => {
		const message = buildAsyncProgressBatchMessage([
			entry("bg_7", `\u001b[31m${os.homedir()}/private/output\rone\tvalue\u001b[0m`),
		]);
		if (!message) throw new Error("Expected progress message");
		const raw = buildAsyncProgressBlock(message).render(80).join("\n");
		const rendered = Bun.stripANSI(raw);

		expect(rendered).toContain("Background command progress bg_7");
		expect(rendered).toContain(`${theme.status.running} Background command progress`);
		expect(raw).toContain(theme.fg("accent", theme.status.running));
		expect(raw).toContain(theme.fg("accent", "Background command progress bg_7"));
		expect(rendered).toContain("~/private/outputone");
		expect(rendered).toMatch(/one +value/);
		expect(rendered).not.toContain("\t");
		expect(rendered).not.toContain("\r");
		expect(rendered).not.toContain(os.homedir());
		expect(rendered).not.toContain("completed");
	});

	test("names the work instead of rendering an implementation badge", () => {
		const runningJob = job("bg_8");
		const progressMessage = buildAsyncProgressBatchMessage([{ ...entry("bg_8", "working"), job: runningJob }]);
		const completionMessage = buildAsyncResultBatchMessage([
			{ jobId: "bg_8", result: "done", job: runningJob, durationMs: 5_000, epoch: 0 },
		]);
		if (!progressMessage || !completionMessage) throw new Error("Expected progress and completion messages");

		const progress = Bun.stripANSI(buildAsyncProgressBlock(progressMessage).render(80).join("\n"));
		const completion = Bun.stripANSI(buildAsyncResultBlock(completionMessage).render(80).join("\n"));

		expect(progress).toContain("Background command progress bg_8");
		expect(completion).toContain("Background command completed bg_8");
		expect(progress).not.toContain("[bash]");
		expect(completion).not.toContain("[bash]");
	});

	test("sanitizes and bounds a model-supplied job name in the header", () => {
		// Hub job ids are the model-supplied process name: tabs, ANSI, and paths
		// must be cleaned and width-bounded like the preview lines below.
		const nastyName = `${os.homedir()}/secret\u001b[31m\tname ${"x".repeat(100)}`;
		const message = buildAsyncProgressBatchMessage([entry(nastyName, "one line")]);
		if (!message) throw new Error("Expected progress message");
		const raw = buildAsyncProgressBlock(message).render(200).join("\n");
		const rendered = Bun.stripANSI(raw);
		const headerLine = rendered.split("\n").find(line => line.includes("Background command progress"));
		if (!headerLine) throw new Error("Expected progress header");
		expect(raw).not.toContain("\u001b[31m");
		expect(headerLine).not.toContain("\t");
		expect(headerLine).not.toContain(os.homedir());
		expect(headerLine).toContain("~/");
		// The 100-char run cannot survive the TITLE-width bound.
		expect(headerLine).not.toContain("x".repeat(60));
	});

	test("hides progress rows when tool activity is hidden", () => {
		const message = buildAsyncProgressBatchMessage([entry("bg_9", "hidden progress line")]);
		if (!message) throw new Error("Expected progress message");
		const block = buildAsyncProgressBlock(message);
		expect(Bun.stripANSI(block.render(100).join("\n"))).toContain("hidden progress line");
		block.setToolActivityVisible(false);
		expect(block.render(100)).toEqual([]);
		block.setToolActivityVisible(true);
		expect(Bun.stripANSI(block.render(100).join("\n"))).toContain("hidden progress line");
	});
});
