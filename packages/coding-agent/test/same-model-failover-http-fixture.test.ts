import { afterEach, describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	createProviderRetryBudgetHook,
	withProviderRetryBudget,
} from "@oh-my-pi/pi-coding-agent/session/provider-retry-budget";
import {
	DUMMY_BEARER_TOKEN,
	MARKER_FILE,
	MARKER_TEXT,
	parseSameModelFailoverFixtureCliArgs,
	RETRY_AFTER_SECONDS,
	type SameModelFailoverFixture,
	type SameModelFailoverFixtureEvent,
	startSameModelFailoverFixture,
	TOOL_CALL_ID,
} from "./fixtures/same-model-failover-http";

const MODEL = "same-model-test";
const SENSITIVE_SENTINEL = "must-not-appear-in-fixture-logs";

let fixture: SameModelFailoverFixture | undefined;

afterEach(() => {
	fixture?.stop();
	fixture = undefined;
});

function chat(
	messages: unknown[],
	authorization = `Bearer ${DUMMY_BEARER_TOKEN}`,
	requestOptions: { stream?: boolean; tools?: unknown[] } = {
		stream: true,
		tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }],
	},
): Promise<Response> {
	if (!fixture) throw new Error("Fixture is not running");
	return fetch(`${fixture.url}/v1/chat/completions`, {
		method: "POST",
		headers: {
			authorization,
			"content-type": "application/json",
			"x-sensitive-test-value": SENSITIVE_SENTINEL,
		},
		body: JSON.stringify({ model: MODEL, messages, sensitive: SENSITIVE_SENTINEL, ...requestOptions }),
	});
}

describe("same-model failover HTTP fixture", () => {
	it("emits one fixed tool call and starts returning Retry-After only after its settled result", async () => {
		const events: SameModelFailoverFixtureEvent[] = [];
		fixture = startSameModelFailoverFixture({ model: MODEL, logger: event => events.push(event) });

		expect(new URL(fixture.url).hostname).toBe("127.0.0.1");
		expect(fixture.port).toBeGreaterThan(0);

		const unauthorized = await chat([{ role: "user", content: SENSITIVE_SENTINEL }], "Bearer wrong-token");
		expect(unauthorized.status).toBe(401);
		expect(fixture.phase).toBe("tool_call_ready");

		const validationProbe = await chat([{ role: "user", content: "ping" }], undefined, {
			stream: false,
		});
		expect(validationProbe.status).toBe(200);
		expect(fixture.phase).toBe("tool_call_ready");

		const first = await chat([{ role: "user", content: SENSITIVE_SENTINEL }]);
		expect(first.status).toBe(200);
		const stream = await first.text();
		const firstFrameLine = stream.split("\n").find(line => line.startsWith("data: {") && line.includes(TOOL_CALL_ID));
		if (!firstFrameLine) throw new Error("Tool-call SSE frame missing");
		const firstFrame = JSON.parse(firstFrameLine.slice("data: ".length)) as {
			choices: Array<{
				delta: { tool_calls: Array<{ id: string; function: { arguments: string; name: string } }> };
			}>;
		};
		const toolCall = firstFrame.choices[0]?.delta.tool_calls[0];
		expect(toolCall?.id).toBe(TOOL_CALL_ID);
		expect(toolCall?.function.name).toBe("bash");
		expect(JSON.parse(toolCall?.function.arguments ?? "null")).toEqual({
			command: `printf '%s\\n' '${MARKER_TEXT}' >> ${MARKER_FILE}`,
		});
		expect(fixture.phase).toBe("awaiting_tool_result");

		const prematureRetry = await chat([{ role: "user", content: "repeat without tool result" }]);
		expect(prematureRetry.status).toBe(409);
		expect(prematureRetry.headers.get("retry-after")).toBeNull();
		expect(fixture.phase).toBe("awaiting_tool_result");

		const afterTool = await chat([
			{ role: "assistant", tool_calls: [{ id: TOOL_CALL_ID }] },
			{ role: "tool", tool_call_id: TOOL_CALL_ID, content: "settled" },
		]);
		expect(afterTool.status).toBe(429);
		expect(afterTool.headers.get("retry-after")).toBe(String(RETRY_AFTER_SECONDS));
		expect(fixture.phase).toBe("rate_limited");

		const subsequent = await chat([{ role: "user", content: "ignored after terminal fault phase" }]);
		expect(subsequent.status).toBe(429);
		expect(subsequent.headers.get("retry-after")).toBe(String(RETRY_AFTER_SECONDS));

		const serializedEvents = JSON.stringify(events);
		expect(serializedEvents).not.toContain(SENSITIVE_SENTINEL);
		expect(serializedEvents).not.toContain(DUMMY_BEARER_TOKEN);
		expect(events.every(event => event.toolCallId === TOOL_CALL_ID)).toBeTrue();
	});

	it("normalizes a configured 45-second Retry-After through the Engine provider hook", async () => {
		const retryAfterSeconds = 45;
		const events: SameModelFailoverFixtureEvent[] = [];
		const options = parseSameModelFailoverFixtureCliArgs([
			"--model",
			MODEL,
			"--retry-after-seconds",
			String(retryAfterSeconds),
		]);
		const startedFixture = startSameModelFailoverFixture({ ...options, logger: event => events.push(event) });
		fixture = startedFixture;
		expect(startedFixture.retryAfterSeconds).toBe(retryAfterSeconds);
		expect(events[0]).toMatchObject({ event: "ready", retryAfterSeconds });

		await chat([{ role: "user", content: "start" }]);
		const afterTool = await chat([
			{ role: "assistant", tool_calls: [{ id: TOOL_CALL_ID }] },
			{ role: "tool", tool_call_id: TOOL_CALL_ID, content: "settled" },
		]);
		expect(afterTool.headers.get("retry-after")).toBe(String(retryAfterSeconds));

		const model = getBundledModel("openai", "gpt-4o-mini");
		if (!model) throw new Error("Expected bundled OpenAI model");
		const error = await withProviderRetryBudget(1, () => {
			const guardedFetch = createProviderRetryBudgetHook().wrapFetch(model, fetch);
			return guardedFetch(`${startedFixture.url}/v1/chat/completions`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${DUMMY_BEARER_TOKEN}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ model: MODEL, messages: [], stream: true, tools: [] }),
			}).catch(reason => reason);
		});

		expect(String(error)).toContain(`retry-after-ms=${retryAfterSeconds * 1_000}`);
		expect(() => parseSameModelFailoverFixtureCliArgs(["--retry-after-seconds", "0"])).toThrow();
		expect(() => parseSameModelFailoverFixtureCliArgs(["--retry-after-seconds", "3601"])).toThrow();
	});
});
