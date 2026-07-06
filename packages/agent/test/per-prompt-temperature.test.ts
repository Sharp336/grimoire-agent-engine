// Per-prompt temperature override: a `temperature` on a single prompt run reaches the
// provider request for that run only; absent leaves exact current behavior, and the
// agent's persistent temperature is never mutated.
import { describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";

/** Wrap a mock stream so we record the `temperature` of each provider request, then delegate. */
function capturingMock(responses: { content: string[] }[]) {
	const mock = createMockModel({ responses });
	const captured: (number | undefined)[] = [];
	const streamFn = ((...args: unknown[]) => {
		for (const arg of args) {
			if (arg && typeof arg === "object" && "temperature" in arg) {
				const t = (arg as { temperature?: unknown }).temperature;
				if (typeof t === "number" || t === undefined) {
					captured.push(t as number | undefined);
					break;
				}
			}
		}
		return (mock.stream as (...a: unknown[]) => unknown)(...args);
	}) as typeof mock.stream;
	return { model: mock.model, streamFn, captured };
}

function newAgent(temperature: number, m: ReturnType<typeof capturingMock>): Agent {
	return new Agent({
		initialState: { model: m.model, systemPrompt: ["t"], tools: [], messages: [] },
		temperature,
		streamFn: m.streamFn,
	});
}

describe("per-prompt temperature override", () => {
	it("a temperature override reaches the provider request for that prompt only", async () => {
		const m = capturingMock([{ content: ["ok"] }, { content: ["ok"] }]);
		const agent = newAgent(0.2, m);

		await agent.prompt("with override", { temperature: 0.9 });
		expect(m.captured.at(-1)).toBe(0.9);
		// the agent's persistent temperature is untouched by the per-run override
		expect(agent.temperature).toBe(0.2);

		// a subsequent prompt with NO override falls back to the agent temperature
		await agent.prompt("no override");
		expect(m.captured.at(-1)).toBe(0.2);
	});

	it("a literal 0 override is honored (not coalesced away to the agent temperature)", async () => {
		const m = capturingMock([{ content: ["ok"] }]);
		const agent = newAgent(0.7, m);
		await agent.prompt("deterministic", { temperature: 0 });
		expect(m.captured.at(-1)).toBe(0);
		expect(agent.temperature).toBe(0.7);
	});
});
