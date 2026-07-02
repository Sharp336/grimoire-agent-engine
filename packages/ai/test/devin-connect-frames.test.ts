import { describe, expect, it } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { streamDevin } from "@oh-my-pi/pi-ai/providers/devin";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { GetChatMessageResponseSchema } from "@oh-my-pi/pi-catalog/discovery/devin-gen/exa/api_server_pb/api_server_pb";
import { GetUserJwtResponseSchema } from "@oh-my-pi/pi-catalog/discovery/devin-gen/exa/auth_pb/auth_pb";
import { StopReason } from "@oh-my-pi/pi-catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb";

function frameConnectMessage(payload: Uint8Array): Uint8Array {
	const out = new Uint8Array(5 + payload.length);
	const view = new DataView(out.buffer);
	view.setUint8(0, 0);
	view.setUint32(1, payload.length, false);
	out.set(payload, 5);
	return out;
}

const devinModel: Model<"devin-agent"> = buildModel({
	id: "devin-test",
	name: "Devin Test",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "https://server.codeium.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1,
	maxTokens: 1,
});

const context: Context = { messages: [{ role: "user", content: "hello devin", timestamp: 1 }] };

describe("streamDevin Connect frame-parser guards", () => {
	it("surfaces the provider envelope error when a frame header declares len > MAX_CONNECT_FRAME_PAYLOAD", async () => {
		const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));

		// MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024 = 16777216
		// We declare a frame with length 16777217 (16 * 1024 * 1024 + 1)
		const largeHeader = new Uint8Array(5);
		const view = new DataView(largeHeader.buffer);
		view.setUint8(0, 0); // flag
		view.setUint32(1, 16777216 + 1, false);

		const fetchImpl = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("GetUserJwt")) {
				return new Response(authPayload);
			}
			return new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						controller.enqueue(largeHeader);
						controller.close();
					},
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		const stream = streamDevin(devinModel, context, { apiKey: "token", fetch: fetchImpl });
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Devin Connect frame too large");
		expect(result.errorMessage).toContain("16777217");
	});

	it("surfaces the truncated-stream envelope error when response body ends with a partial frame still buffered", async () => {
		const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));

		const partialHeader = new Uint8Array(5);
		const view = new DataView(partialHeader.buffer);
		view.setUint8(0, 0); // flag
		view.setUint32(1, 10, false); // len = 10, but we will close stream with only 5 bytes buffered

		const fetchImpl = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("GetUserJwt")) {
				return new Response(authPayload);
			}
			return new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						controller.enqueue(partialHeader);
						controller.close();
					},
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		const stream = streamDevin(devinModel, context, { apiKey: "token", fetch: fetchImpl });
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Devin Connect stream truncated");
		expect(result.errorMessage).toContain("5 buffered bytes");
	});

	it("streams normally for a well-formed frame sequence", async () => {
		const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));

		const msg1 = create(GetChatMessageResponseSchema, {
			messageId: "msg-1",
			deltaText: "Hello",
		});
		const msg2 = create(GetChatMessageResponseSchema, {
			messageId: "msg-1",
			deltaText: " world!",
			stopReason: StopReason.STOP_PATTERN,
		});

		const chunk1 = frameConnectMessage(toBinary(GetChatMessageResponseSchema, msg1));
		const chunk2 = frameConnectMessage(toBinary(GetChatMessageResponseSchema, msg2));
		const chunks = [chunk1, chunk2];
		let index = 0;

		const fetchImpl = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("GetUserJwt")) {
				return new Response(authPayload);
			}
			return new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						if (index < chunks.length) {
							controller.enqueue(chunks[index++]);
						} else {
							controller.close();
						}
					},
				}),
				{ status: 200 },
			);
		}) as typeof fetch;

		const stream = streamDevin(devinModel, context, { apiKey: "token", fetch: fetchImpl });
		const deltas: string[] = [];
		for await (const event of stream) {
			if (event.type === "text_delta") {
				deltas.push(event.delta);
			}
		}
		const result = await stream.result();

		expect(deltas).toEqual(["Hello", " world!"]);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "Hello world!" }]);
	});
});
