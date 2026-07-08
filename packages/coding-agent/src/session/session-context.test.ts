import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { INTERRUPTED_THINKING_MESSAGE_TYPE } from "./messages";
import { buildSessionContext } from "./session-context";
import type { SessionEntry } from "./session-entries";

const entryTimestamp = "2026-07-08T00:00:00.000Z";

const assistantUsage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userEntry(id: string, parentId: string | null, content: string, timestamp: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: entryTimestamp,
		message: { role: "user", content, timestamp } as AgentMessage,
	};
}

function assistantEntry(
	id: string,
	parentId: string | null,
	stopReason: AssistantMessage["stopReason"],
	text: string,
	timestamp: number,
): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: entryTimestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: assistantUsage,
			stopReason,
			timestamp,
		} satisfies AssistantMessage,
	};
}

function hiddenContinuityEntry(id: string, parentId: string | null): SessionEntry {
	return {
		type: "custom_message",
		id,
		parentId,
		timestamp: entryTimestamp,
		customType: INTERRUPTED_THINKING_MESSAGE_TYPE,
		content: "preserved interrupted thinking",
		display: false,
		attribution: "agent",
	};
}

function expectUserTail(messages: AgentMessage[], content: string): void {
	const tail = messages.at(-1);
	expect(tail?.role).toBe("user");
	if (tail?.role !== "user") {
		throw new Error(`Expected user tail, received ${tail?.role ?? "none"}`);
	}
	expect(tail.content).toBe(content);
}

async function runCycleCaseInSubprocess(): Promise<string[]> {
	const sessionContextUrl = new URL("./session-context.ts", import.meta.url).href;
	const script = `
import { buildSessionContext } from ${JSON.stringify(sessionContextUrl)};
const timestamp = ${JSON.stringify(entryTimestamp)};
const entries = [
	{ type: "message", id: "A", parentId: "B", timestamp, message: { role: "user", content: "from A", timestamp: 1 } },
	{ type: "message", id: "B", parentId: "A", timestamp, message: { role: "user", content: "from B", timestamp: 2 } },
];
const context = buildSessionContext(entries, "A");
console.log(JSON.stringify(context.messages.map(message => message.role === "user" ? message.content : message.role)));
`;
	const proc = Bun.spawn([process.execPath, "--eval", script], {
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});

	let timedOut = false;
	// This guards a synchronous nontermination regression in a child process; fake timers cannot preempt a wedged parent walk.
	const timeout = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, 1_000);

	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	clearTimeout(timeout);

	if (timedOut) {
		throw new Error("buildSessionContext did not return within 1000ms for cyclic parent links");
	}
	if (exitCode !== 0) {
		throw new Error(`cycle subprocess exited ${exitCode}: ${stderr}`);
	}
	return JSON.parse(stdout) as string[];
}

describe("buildSessionContext", () => {
	it("terminates on cyclic parent links and includes each reachable message once", async () => {
		const contents = await runCycleCaseInSubprocess();

		expect(contents).toHaveLength(2);
		expect(contents.toSorted()).toEqual(["from A", "from B"]);
	}, 2_000);

	it("omits a terminal aborted assistant from normal context", () => {
		const context = buildSessionContext([
			userEntry("user", null, "continue", 1),
			assistantEntry("assistant", "user", "aborted", "partial unsafe replay", 2),
		]);

		expect(context.messages.some(message => message.role === "assistant")).toBe(false);
		expectUserTail(context.messages, "continue");
	});

	it("preserves a terminal aborted assistant in transcript mode", () => {
		const context = buildSessionContext(
			[
				userEntry("user", null, "continue", 1),
				assistantEntry("assistant", "user", "aborted", "visible transcript error", 2),
			],
			undefined,
			undefined,
			{ transcript: true },
		);

		const assistant = context.messages.find(message => message.role === "assistant");
		expect(assistant?.role).toBe("assistant");
		if (assistant?.role !== "assistant") {
			throw new Error(`Expected transcript assistant, received ${assistant?.role ?? "none"}`);
		}
		expect(assistant.stopReason).toBe("aborted");
		expect(assistant.content).toEqual([{ type: "text", text: "visible transcript error" }]);
	});

	it("omits a terminal error assistant from normal context", () => {
		const context = buildSessionContext([
			userEntry("user", null, "retry with smaller input", 1),
			assistantEntry("assistant", "user", "error", "provider rejected the request", 2),
		]);

		expect(context.messages.some(message => message.role === "assistant")).toBe(false);
		expectUserTail(context.messages, "retry with smaller input");
	});

	it("keeps an aborted assistant when hidden interrupted-thinking continuity follows it", () => {
		const context = buildSessionContext([
			userEntry("user", null, "keep reasoning continuity", 1),
			assistantEntry("assistant", "user", "aborted", "partial answer before interrupt", 2),
			hiddenContinuityEntry("continuity", "assistant"),
		]);

		const assistant = context.messages.find(message => message.role === "assistant");
		expect(assistant?.role).toBe("assistant");
		if (assistant?.role !== "assistant") {
			throw new Error(`Expected assistant before continuity, received ${assistant?.role ?? "none"}`);
		}
		expect(assistant.stopReason).toBe("aborted");
		expect(context.messages.at(-1)?.role).toBe("custom");
	});
});
