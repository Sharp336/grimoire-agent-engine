import { describe, expect, test } from "bun:test";
import {
	inspectSessionEmptiness,
	isRespondingAssistantEntry,
	type SessionEmptiness,
} from "@oh-my-pi/pi-coding-agent/session/session-emptiness";
import type { FileEntry, SessionHeader } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { assistantMsg, userMsg } from "../utilities";

/** A mid-turn reply: the model asked for a tool and stopped. */
function toolCallMsg(text: string, toolName = "bash") {
	const base = assistantMsg(text);
	return {
		...base,
		content: [...base.content, { type: "toolCall" as const, id: `call-${text}`, name: toolName, arguments: {} }],
		stopReason: "toolUse" as const,
	};
}

/** The tool traffic that hangs under an assistant tool call. */
function toolResultMsg(text: string, toolName = "bash") {
	return {
		role: "toolResult" as const,
		toolCallId: `call-${text}`,
		toolName,
		content: [{ type: "text" as const, text }],
		isError: false,
		timestamp: Date.now(),
	};
}

/** A reply that died: the turn never ended of its own accord. */
function failedAssistantMsg(text: string, reason: "error" | "aborted") {
	return { ...assistantMsg(text), stopReason: reason, errorMessage: `test ${reason}` };
}

const HEADER: SessionHeader = {
	type: "session",
	version: 3,
	id: "019f6d5f-4aee-7000-a3ab-3b62adc9b302",
	timestamp: "2026-08-14T00:00:00.000Z",
	cwd: "/tmp/omp-session-emptiness",
};

/** The shape `loadEntriesFromFile` returns: header followed by logical entries. */
function fileEntries(build: (session: SessionManager) => void): FileEntry[] {
	const session = SessionManager.inMemory();
	build(session);
	return [HEADER, ...session.getEntries()];
}

function expected(overrides: Partial<SessionEmptiness> = {}): SessionEmptiness {
	return {
		hasResponse: false,
		userMessages: 0,
		assistantMessages: 0,
		assistantTextChars: 0,
		unfinishedAttempts: 0,
		...overrides,
	};
}

describe("inspectSessionEmptiness", () => {
	test("the user's 35-message all-toolUse session is not a candidate when one message carries text", () => {
		const entries = fileEntries(session => {
			session.appendMessage(userMsg("do the work"));
			for (let i = 0; i < 35; i++) {
				const text = i === 17 ? "a fully delivered assistant message" : "";
				session.appendMessage(toolCallMsg(text, `tool-${i}`));
			}
		});

		expect(inspectSessionEmptiness(entries)).toEqual(
			expected({
				hasResponse: true,
				userMessages: 1,
				assistantMessages: 35,
				assistantTextChars: 35,
				unfinishedAttempts: 34,
			}),
		);
	});

	test("pure tool calls with zero assistant text ending aborted are a candidate", () => {
		const entries = fileEntries(session => {
			session.appendMessage(userMsg("run it"));
			session.appendMessage(toolCallMsg(""));
			session.appendMessage(toolResultMsg("tool output"));
			session.appendMessage(failedAssistantMsg("", "aborted"));
		});

		expect(inspectSessionEmptiness(entries)).toEqual(
			expected({ userMessages: 1, assistantMessages: 2, unfinishedAttempts: 2 }),
		);
	});

	test("a user-only session is a candidate", () => {
		const entries = fileEntries(session => {
			session.appendMessage(userMsg("hello?"));
			session.appendMessage(userMsg("still there?"));
		});

		expect(inspectSessionEmptiness(entries)).toEqual(expected({ userMessages: 2 }));
	});

	test("a header-only session is a candidate", () => {
		expect(inspectSessionEmptiness([HEADER])).toEqual(expected());
	});

	test("one normal completed reply is not a candidate even with no text", () => {
		const entries = fileEntries(session => {
			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg(""));
		});

		expect(inspectSessionEmptiness(entries)).toEqual(
			expected({ hasResponse: true, userMessages: 1, assistantMessages: 1 }),
		);
	});

	test('stopReason "length" with text is not a candidate', () => {
		const entries = fileEntries(session => {
			session.appendMessage(userMsg("write an essay"));
			session.appendMessage({ ...assistantMsg("chapter one"), stopReason: "length" as const });
		});

		expect(inspectSessionEmptiness(entries)).toEqual(
			expected({ hasResponse: true, userMessages: 1, assistantMessages: 1, assistantTextChars: 11 }),
		);
	});

	test("whitespace-only assistant text does not count as a response", () => {
		const entries = fileEntries(session => {
			session.appendMessage(userMsg("run it"));
			session.appendMessage(toolCallMsg(" \n\t "));
		});

		expect(inspectSessionEmptiness(entries)).toEqual(
			expected({ userMessages: 1, assistantMessages: 1, unfinishedAttempts: 1 }),
		);
	});

	test("assistantTextChars accumulates trimmed prose across messages", () => {
		const entries = fileEntries(session => {
			session.appendMessage(toolCallMsg("  first  "));
			session.appendMessage(failedAssistantMsg("second", "error"));
			session.appendMessage(toolCallMsg("\t\n"));
		});

		expect(inspectSessionEmptiness(entries)).toEqual(
			expected({
				hasResponse: true,
				assistantMessages: 3,
				assistantTextChars: 11,
				unfinishedAttempts: 1,
			}),
		);
	});

	test("a response on an abandoned branch keeps the whole session", () => {
		const entries = fileEntries(session => {
			const root = session.appendMessage(userMsg("root"));
			session.appendMessage(toolCallMsg("answered over here"));
			session.branch(root);
			session.appendMessage(userMsg("asked again"));
		});

		expect(inspectSessionEmptiness(entries)).toEqual(
			expected({ hasResponse: true, userMessages: 2, assistantMessages: 1, assistantTextChars: 18 }),
		);
	});
});

describe("isRespondingAssistantEntry", () => {
	test("text answers regardless of stop reason, while a blank unfinished attempt does not", () => {
		const entries = fileEntries(session => {
			session.appendMessage(userMsg("ask"));
			session.appendMessage(toolCallMsg("mid-turn prose"));
			session.appendMessage(toolCallMsg(""));
			session.appendMessage(failedAssistantMsg("error prose", "error"));
			session.appendMessage(assistantMsg(""));
		});

		expect(entries.map(entry => isRespondingAssistantEntry(entry))).toEqual([false, false, true, false, true, true]);
	});
});
