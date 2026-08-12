import { describe, expect, it } from "bun:test";
import {
	isPrimeDaemonFrame,
	parsePrimeDaemonCommandEnvelope,
	parsePrimeDaemonFrame,
	parsePrimeDaemonOutbound,
} from "../src";

const protocol = { name: "prime-agent.daemon", version: 7 } as const;

const hello = {
	type: "daemon_hello",
	socketPath: "/tmp/prime.sock",
	protocol,
	clientId: "client-1",
	serverCapabilities: ["event_sequence"],
	futureHelloField: { retained: true },
};

describe("Prime daemon protocol", () => {
	it("accepts a protocol-7 hello and preserves unknown fields", () => {
		const parsed = parsePrimeDaemonFrame(hello);

		expect(parsed).toEqual(hello);
		expect(parsed.type).toBe("daemon_hello");
		expect(parsePrimeDaemonOutbound(hello)).toEqual(hello);
	});
	it("accepts newer numeric protocol versions", () => {
		const newer = { ...hello, protocol: { name: "prime-agent.daemon", version: 8 } };

		expect(parsePrimeDaemonFrame(newer)).toEqual(newer);
		expect(isPrimeDaemonFrame(newer)).toBe(true);
	});

	it("accepts a command envelope through the runtime parser", () => {
		const command = {
			type: "command",
			id: "command-1",
			protocol,
			clientId: "client-1",
			command: { type: "attach", activeSessionId: "session-1" },
			futureCommandField: { retained: true },
		} as const;

		expect(parsePrimeDaemonCommandEnvelope(command)).toEqual(command);
	});

	it("accepts protocol-7 response and event frames", () => {
		const response = {
			type: "response",
			id: "command-1",
			command: "attach",
			success: true,
			data: { activeSessionId: "session-1" },
			protocol,
			futureResponseField: "retained",
		};
		const event = {
			type: "session_status",
			activeSessionId: "session-1",
			meta: {
				id: "event-1",
				protocol,
				cursor: { generation: "generation-1", sequence: 4 },
				emittedAt: "2026-08-11T00:00:00.000Z",
			},
			futureEventField: ["retained"],
		};
		const eventEnvelope = {
			type: "event",
			id: "event-2",
			protocol,
			sequence: 4,
			cursor: { generation: "generation-1", sequence: 4 },
			emittedAt: "2026-08-11T00:00:00.000Z",
			event: { type: "session_status", activeSessionId: "session-1" },
			futureEventField: ["retained"],
		};

		expect(parsePrimeDaemonFrame(response)).toEqual(response);
		expect(parsePrimeDaemonFrame(event)).toEqual(event);
		expect(parsePrimeDaemonFrame(eventEnvelope)).toEqual(eventEnvelope);
	});

	it("rejects an unknown protocol name", () => {
		expect(() =>
			parsePrimeDaemonFrame({
				...hello,
				protocol: { name: "other.daemon", version: 7 },
			}),
		).toThrow(/protocol name/i);
	});

	it("rejects malformed known hello and event fields", () => {
		expect(() =>
			parsePrimeDaemonFrame({
				...hello,
				serverCapabilities: ["event_sequence", 7],
			}),
		).toThrow(/serverCapabilities/i);

		expect(() =>
			parsePrimeDaemonFrame({
				type: "event",
				id: "event-1",
				protocol,
				event: { type: "session_status" },
			}),
		).toThrow(/emittedAt/i);
	});

	it("rejects malformed response errors and event replay markers", () => {
		const malformedResponse = {
			type: "response",
			command: "attach",
			success: true,
			error: 42,
		};
		const malformedEvent = {
			type: "session_status",
			meta: {
				id: "event-1",
				protocol,
				emittedAt: "2026-08-11T00:00:00.000Z",
				replayed: 1,
			},
		};

		expect(() => parsePrimeDaemonFrame(malformedResponse)).toThrow(/error/i);
		expect(isPrimeDaemonFrame(malformedResponse)).toBe(false);
		expect(() => parsePrimeDaemonFrame(malformedEvent)).toThrow(/replayed/i);
		expect(isPrimeDaemonFrame(malformedEvent)).toBe(false);
	});

	it("requires generation and sequence together", () => {
		const event = {
			type: "event",
			id: "event-1",
			protocol,
			event: { type: "session_status" },
			emittedAt: "2026-08-11T00:00:00.000Z",
		};

		expect(() => parsePrimeDaemonFrame({ ...event, cursor: { generation: "generation-1" } })).toThrow(
			/generation.*sequence|sequence.*generation/i,
		);
		expect(() => parsePrimeDaemonFrame({ ...event, cursor: { sequence: 4 } })).toThrow(
			/generation.*sequence|sequence.*generation/i,
		);
	});
});
