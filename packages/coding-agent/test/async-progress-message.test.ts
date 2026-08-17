import { beforeAll, describe, expect, test } from "bun:test";
import * as os from "node:os";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { buildAsyncProgressBlock } from "@oh-my-pi/pi-coding-agent/modes/utils/transcript-render-helpers";
import {
	ASYNC_PROGRESS_MESSAGE_TYPE,
	type AsyncProgressEntry,
	buildAsyncProgressBatchMessage,
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
	return { jobId, text, seq, job: job(jobId), elapsedMs: 5_000, epoch: 0 };
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
	test("keeps the latest sequence and applies shared line/character caps", () => {
		const message = buildAsyncProgressBatchMessage([
			entry("bg_1", "stale", 1),
			entry("bg_1", `discarded\nline2\nline3\n${"x".repeat(5_000)}`, 2),
			entry("bg_2", "important", 1),
		]);
		const jobs = message?.details?.jobs ?? [];

		expect(message?.customType).toBe(ASYNC_PROGRESS_MESSAGE_TYPE);
		expect(jobs).toHaveLength(2);
		expect(jobs.reduce((total, item) => total + item.text.length, 0)).toBeLessThanOrEqual(4_000);
		expect(jobs[0]?.text.split("\n").length).toBeLessThanOrEqual(3);
		expect(content(message)).not.toContain("stale");
		expect(content(message)).toContain("important");
		expect(content(message)).toContain("STILL RUNNING");
		expect(content(message)).toContain("no action is required");

		const lineCapped = buildAsyncProgressBatchMessage([entry("bg_3", "one\ntwo\nthree\nfour")]);
		expect(lineCapped?.details?.jobs[0]?.text).toBe("two\nthree\nfour");
	});

	test("renders the custom message as sanitized progress rather than a completion", () => {
		const message = buildAsyncProgressBatchMessage([
			entry("bg_7", `\u001b[31m${os.homedir()}/private/output\rone\tvalue\u001b[0m`),
		]);
		if (!message) throw new Error("Expected progress message");
		const rendered = Bun.stripANSI(buildAsyncProgressBlock(message).render(80).join("\n"));

		expect(rendered).toContain("Background job progress [bash] bg_7");
		expect(rendered).toContain("~/private/outputone");
		expect(rendered).toMatch(/one +value/);
		expect(rendered).not.toContain("\t");
		expect(rendered).not.toContain("\r");
		expect(rendered).not.toContain(os.homedir());
		expect(rendered).not.toContain("completed");
	});
});
