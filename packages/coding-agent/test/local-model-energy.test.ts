import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@oh-my-pi/pi-ai";
import { renderSegment, type SegmentContext } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	formatLocalModelEnergy,
	isLocalEnergyModel,
	LocalModelEnergyMonitor,
	parseNvidiaSmiPowerWatts,
} from "../src/metrics/local-model-energy";

function makeModel(provider: string, baseUrl: string, overrides: Partial<Model> = {}): Model {
	return {
		id: "local-model",
		name: "Local Model",
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4_096,
		...overrides,
	} as Model;
}

const OLLAMA_LOCAL = makeModel("ollama", "http://127.0.0.1:11434/v1");

beforeAll(async () => {
	await initTheme();
});

describe("local model energy monitoring", () => {
	it("parses nvidia-smi power rows and sums valid GPUs", () => {
		const watts = parseNvidiaSmiPowerWatts("0, 125.5\n1, N/A\n2, 10 W\n");
		expect(watts).toBe(135.5);
		expect(parseNvidiaSmiPowerWatts("0, [Not Supported]\n")).toBeNull();
	});

	it("only treats known local engines on loopback URLs as local energy models", () => {
		expect(isLocalEnergyModel(OLLAMA_LOCAL)).toBe(true);
		expect(isLocalEnergyModel(makeModel("lm-studio", "http://localhost:1234/v1"))).toBe(true);
		expect(isLocalEnergyModel(makeModel("vllm", "http://0.0.0.0:8000/v1"))).toBe(true);
		expect(isLocalEnergyModel(makeModel("ollama-cloud", "https://ollama.com"))).toBe(false);
		expect(isLocalEnergyModel(makeModel("ollama", "https://ollama.example.test/v1"))).toBe(false);
		expect(isLocalEnergyModel(makeModel("litellm", "http://127.0.0.1:4000/v1"))).toBe(false);
		expect(isLocalEnergyModel(makeModel("ollama", "http://127.0.0.1:11434/v1", { transport: "pi-native" }))).toBe(
			false,
		);
	});

	it("integrates sampled watts over active local model time", async () => {
		let now = 0;
		const readings = [100, 200];
		const monitor = new LocalModelEnergyMonitor({
			now: () => now,
			pollPowerWatts: async () => readings.shift() ?? null,
			autoPoll: false,
		});

		const usage = monitor.begin(OLLAMA_LOCAL);
		await monitor.pollOnceForTest();
		now = 1_000;
		await monitor.pollOnceForTest();
		now = 1_500;
		usage.end();

		expect(monitor.snapshot().joules).toBe(250);
		expect(formatLocalModelEnergy(monitor.snapshot().joules)).toBe("250J");
	});

	it("samples once for overlapping local runs instead of double-counting", async () => {
		let now = 0;
		const monitor = new LocalModelEnergyMonitor({
			now: () => now,
			pollPowerWatts: async () => 100,
			autoPoll: false,
		});

		const first = monitor.begin(OLLAMA_LOCAL);
		const second = monitor.begin(OLLAMA_LOCAL);
		await monitor.pollOnceForTest();
		now = 500;
		first.end();
		now = 1_000;
		await monitor.pollOnceForTest();
		now = 2_000;
		second.end();

		expect(monitor.snapshot().joules).toBe(200);
	});

	it("does not expose a snapshot for unsupported nvidia-smi output", async () => {
		const monitor = new LocalModelEnergyMonitor({
			pollPowerWatts: async () => null,
			autoPoll: false,
		});

		const usage = monitor.begin(OLLAMA_LOCAL);
		await monitor.pollOnceForTest();

		expect(monitor.snapshot().available).toBe(false);
		expect(monitor.snapshotForModel(OLLAMA_LOCAL)).toBeNull();
		usage.end();
	});

	it("treats thrown power polls as unavailable hardware", async () => {
		const monitor = new LocalModelEnergyMonitor({
			pollPowerWatts: async () => {
				throw new Error("nvidia-smi failed");
			},
			autoPoll: false,
		});

		const usage = monitor.begin(OLLAMA_LOCAL);
		await monitor.pollOnceForTest();

		expect(monitor.snapshot().available).toBe(false);
		usage.end();
	});

	it("renders accumulated local energy beside the model name", () => {
		const rendered = renderSegment("model", {
			session: {
				state: { model: { id: "llama3", name: "Llama 3" } },
				isFastModeActive: () => false,
				isAutoThinking: false,
			},
			options: { model: { showThinkingLevel: true } },
			localModelEnergy: {
				joules: 250,
				active: false,
				available: true,
				lastWatts: null,
			},
		} as unknown as SegmentContext);

		expect(stripVTControlCharacters(rendered.content)).toContain("Llama 3");
		expect(stripVTControlCharacters(rendered.content)).toContain("250J");
	});
});
