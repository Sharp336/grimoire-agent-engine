import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	BidiAppendRequestSchema,
	BidiPollResponseSchema,
	BidiRequestIdSchema,
} from "@oh-my-pi/pi-catalog/discovery/cursor-gen/bidi_pb";
import { Http2Config } from "@oh-my-pi/pi-catalog/discovery/cursor-gen/server_config_pb";
import { $ } from "bun";
import {
	CursorAgentService,
	CursorBidiService,
	CursorServerConfigService,
} from "../src/providers/cursor/transport-descriptors";

describe("transport descriptor parity", () => {
	it("CursorAgentService.Run is BiDiStreaming", () => {
		expect(CursorAgentService.method.run.methodKind).toBe("bidi_streaming");
	});

	it("CursorAgentService.RunSSE is ServerStreaming", () => {
		expect(CursorAgentService.method.runSSE.methodKind).toBe("server_streaming");
	});

	it("CursorAgentService.RunPoll is ServerStreaming", () => {
		const runPoll = CursorAgentService.method.runPoll;
		expect(runPoll).toBeDefined();
		expect(runPoll.methodKind).toBe("server_streaming");
	});

	it("CursorAgentService.RunPoll parent typeName is agent.v1.AgentService", () => {
		expect(CursorAgentService.method.runPoll.parent.typeName).toBe("agent.v1.AgentService");
	});

	it("CursorAgentService.Run parent typeName is agent.v1.AgentService", () => {
		expect(CursorAgentService.method.run.parent.typeName).toBe("agent.v1.AgentService");
	});

	it("CursorBidiService.BidiAppend is Unary", () => {
		expect(CursorBidiService.method.bidiAppend.methodKind).toBe("unary");
	});

	it("CursorServerConfigService.GetServerConfig is Unary", () => {
		expect(CursorServerConfigService.method.getServerConfig.methodKind).toBe("unary");
	});

	it("Http2Config enum has correct vendor values", () => {
		expect(Http2Config.UNSPECIFIED).toBe(0);
		expect(Http2Config.FORCE_ALL_DISABLED).toBe(1);
		expect(Http2Config.FORCE_ALL_ENABLED).toBe(2);
		expect(Http2Config.FORCE_BIDI_DISABLED).toBe(3);
		expect(Http2Config.FORCE_BIDI_ENABLED).toBe(4);
	});

	it("BidiAppendRequest field 2 is BidiRequestId message type", () => {
		const requestIdField = BidiAppendRequestSchema.fields.find(f => f.number === 2);
		expect(requestIdField).toBeDefined();
		expect(requestIdField?.fieldKind).toBe("message");
		expect(requestIdField?.message?.typeName).toBe("aiserver.v1.BidiRequestId");
	});

	it("BidiPollResponse field 2 data is scalar string", () => {
		const dataField = BidiPollResponseSchema.fields.find(f => f.number === 2);
		expect(dataField).toBeDefined();
		expect(dataField?.scalar).toBe(9); // T:9 = string
	});

	it("BidiRequestId has request_id field 1 as string", () => {
		const req = create(BidiRequestIdSchema, { requestId: "test-id" });
		expect(req.requestId).toBe("test-id");
	});
});

describe("proto generation idempotency", () => {
	it("running generate:cursor-proto twice produces identical output", async () => {
		// Run generation once and capture the output.
		await $`bun run generate:cursor-proto`.cwd("packages/catalog").quiet();
		const genDir = "packages/catalog/src/discovery/cursor-gen";
		const files = await fs.readdir(genDir);
		const snapshots: Record<string, string> = {};
		for (const file of files) {
			snapshots[file] = await fs.readFile(path.join(genDir, file), "utf8");
		}

		// Run generation again; the output must be identical.
		await $`bun run generate:cursor-proto`.cwd("packages/catalog").quiet();
		for (const file of files) {
			const content = await fs.readFile(path.join(genDir, file), "utf8");
			expect(content).toBe(snapshots[file]);
		}
	});
});
