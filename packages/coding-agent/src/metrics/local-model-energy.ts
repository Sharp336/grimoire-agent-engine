import type { StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { $which, ptree } from "@oh-my-pi/pi-utils";

const LOCAL_ENGINE_PROVIDERS = new Set(["ollama", "llama.cpp", "lm-studio", "vllm"]);
const NVIDIA_SMI_QUERY_ARGS = ["--query-gpu=index,power.draw", "--format=csv,noheader,nounits"];
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_TIMEOUT_MS = 1_000;
const POLL_BACKOFF_MS = 30_000;

export interface LocalModelEnergySnapshot {
	joules: number;
	active: boolean;
	available: boolean;
	lastWatts: number | null;
}

export interface LocalModelEnergyUsage {
	end(): void;
}

interface LocalModelEnergyMonitorOptions {
	now?: () => number;
	pollPowerWatts?: () => Promise<number | null>;
	autoPoll?: boolean;
	pollIntervalMs?: number;
}

function isLoopbackUrl(baseUrl: string): boolean {
	try {
		const host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
		return host === "localhost" || host === "::1" || host === "0.0.0.0" || host.startsWith("127.");
	} catch {
		return false;
	}
}

export function isLocalEnergyModel(model: Pick<Model, "provider" | "baseUrl" | "transport"> | undefined): boolean {
	if (!model) return false;
	if (model.transport === "pi-native") return false;
	if (!LOCAL_ENGINE_PROVIDERS.has(model.provider)) return false;
	return isLoopbackUrl(model.baseUrl);
}

export function parseNvidiaSmiPowerWatts(output: string): number | null {
	let total = 0;
	let validRows = 0;
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const fields = line.split(",");
		const rawValue = (fields.at(-1) ?? "").trim().replace(/\s*W$/i, "");
		const watts = Number(rawValue);
		if (!Number.isFinite(watts) || watts < 0) continue;
		total += watts;
		validRows++;
	}
	return validRows > 0 ? total : null;
}

export async function queryNvidiaSmiPowerWatts(): Promise<number | null> {
	const nvidiaSmi = $which("nvidia-smi");
	if (!nvidiaSmi) return null;
	const result = await ptree.exec([nvidiaSmi, ...NVIDIA_SMI_QUERY_ARGS], {
		timeout: DEFAULT_POLL_TIMEOUT_MS,
		allowAbort: true,
		allowNonZero: true,
	});
	if (!result.ok) return null;
	return parseNvidiaSmiPowerWatts(result.stdout);
}

export function formatLocalModelEnergy(joules: number): string | null {
	if (!Number.isFinite(joules) || joules < 0) return null;
	if (joules < 1) return "0J";
	const wattHours = joules / 3_600;
	if (wattHours < 0.1) return `${Math.round(joules)}J`;
	if (wattHours < 10) return `${wattHours.toFixed(1)}Wh`;
	if (wattHours < 1_000) return `${Math.round(wattHours)}Wh`;
	return `${(wattHours / 1_000).toFixed(2)}kWh`;
}

export class LocalModelEnergyMonitor {
	#now: () => number;
	#pollPowerWatts: () => Promise<number | null>;
	#autoPoll: boolean;
	#pollIntervalMs: number;
	#activeCount = 0;
	#timer: NodeJS.Timeout | undefined;
	#pollInFlight = false;
	#disabledUntilMs = 0;
	#lastSampleTimeMs: number | undefined;
	#lastWatts: number | null = null;
	#totalJoules = 0;
	#listeners = new Set<() => void>();

	constructor(options: LocalModelEnergyMonitorOptions = {}) {
		this.#now = options.now ?? Date.now;
		this.#pollPowerWatts = options.pollPowerWatts ?? queryNvidiaSmiPowerWatts;
		this.#autoPoll = options.autoPoll ?? true;
		this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	begin(model: Model | undefined): LocalModelEnergyUsage {
		if (!isLocalEnergyModel(model)) return NOOP_USAGE;
		this.#activeCount++;
		if (this.#activeCount === 1) {
			this.#lastSampleTimeMs = undefined;
			this.#lastWatts = null;
			if (this.#autoPoll) {
				void this.#pollOnce();
				this.#ensureTimer();
			}
		}

		let ended = false;
		return {
			end: () => {
				if (ended) return;
				ended = true;
				this.#end();
			},
		};
	}

	snapshot(): LocalModelEnergySnapshot {
		return {
			joules: this.#totalJoules,
			active: this.#activeCount > 0,
			available: this.#lastWatts !== null || this.#totalJoules > 0,
			lastWatts: this.#lastWatts,
		};
	}

	snapshotForModel(model: Model | undefined): LocalModelEnergySnapshot | null {
		if (!isLocalEnergyModel(model)) return null;
		const snapshot = this.snapshot();
		return snapshot.available ? snapshot : null;
	}

	async pollOnceForTest(): Promise<void> {
		await this.#pollOnce();
	}

	dispose(): void {
		this.#stopTimer();
		this.#activeCount = 0;
		this.#lastSampleTimeMs = undefined;
		this.#lastWatts = null;
	}

	#end(): void {
		if (this.#activeCount === 0) return;
		this.#activeCount--;
		if (this.#activeCount > 0) return;
		this.#integrateUntil(this.#now());
		this.#lastSampleTimeMs = undefined;
		this.#lastWatts = null;
		this.#stopTimer();
		this.#emit();
	}

	#ensureTimer(): void {
		if (this.#timer) return;
		this.#timer = setInterval(() => {
			void this.#pollOnce();
		}, this.#pollIntervalMs);
		this.#timer.unref?.();
	}

	#stopTimer(): void {
		if (!this.#timer) return;
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	async #pollOnce(): Promise<void> {
		if (this.#pollInFlight || this.#activeCount === 0) return;
		const now = this.#now();
		if (now < this.#disabledUntilMs) return;

		this.#pollInFlight = true;
		try {
			let watts: number | null;
			try {
				watts = await this.#pollPowerWatts();
			} catch {
				watts = null;
			}
			const sampleTimeMs = this.#now();
			if (watts === null) {
				this.#lastSampleTimeMs = undefined;
				this.#lastWatts = null;
				this.#disabledUntilMs = sampleTimeMs + POLL_BACKOFF_MS;
				this.#emit();
				return;
			}
			if (this.#activeCount === 0) return;
			this.#integrateSample(sampleTimeMs, watts);
			this.#disabledUntilMs = 0;
			this.#emit();
		} finally {
			this.#pollInFlight = false;
		}
	}

	#integrateSample(sampleTimeMs: number, watts: number): void {
		if (this.#lastSampleTimeMs !== undefined && this.#lastWatts !== null) {
			const elapsedSeconds = Math.max(0, sampleTimeMs - this.#lastSampleTimeMs) / 1_000;
			this.#totalJoules += ((this.#lastWatts + watts) / 2) * elapsedSeconds;
		}
		this.#lastSampleTimeMs = sampleTimeMs;
		this.#lastWatts = watts;
	}

	#integrateUntil(now: number): void {
		if (this.#lastSampleTimeMs === undefined || this.#lastWatts === null) return;
		const elapsedSeconds = Math.max(0, now - this.#lastSampleTimeMs) / 1_000;
		this.#totalJoules += this.#lastWatts * elapsedSeconds;
		this.#lastSampleTimeMs = now;
	}

	#emit(): void {
		for (const listener of this.#listeners) {
			listener();
		}
	}
}

const NOOP_USAGE: LocalModelEnergyUsage = { end: () => {} };
const localModelEnergyMonitor = new LocalModelEnergyMonitor();
const wrappedStreamFns = new WeakMap<StreamFn, StreamFn>();

export function getLocalModelEnergyMonitor(): LocalModelEnergyMonitor {
	return localModelEnergyMonitor;
}

export function withLocalModelEnergyStreamFn(streamFn: StreamFn): StreamFn {
	const existing = wrappedStreamFns.get(streamFn);
	if (existing) return existing;

	const wrapped: StreamFn = (model, context, options) => streamWithLocalModelEnergy(model, context, options, streamFn);
	wrappedStreamFns.set(streamFn, wrapped);
	wrappedStreamFns.set(wrapped, wrapped);
	return wrapped;
}

export async function streamWithLocalModelEnergy(
	model: Model,
	context: Context,
	options: SimpleStreamOptions | undefined,
	streamFn: StreamFn,
): Promise<AssistantMessageEventStream> {
	const usage = localModelEnergyMonitor.begin(model);
	try {
		const stream = await streamFn(model, context, options);
		const trackedStream = new AssistantMessageEventStream();
		void (async () => {
			try {
				for await (const event of stream) {
					trackedStream.push(event);
				}
				if (!trackedStream.done) {
					trackedStream.end();
				}
			} catch (error) {
				trackedStream.fail(error);
			} finally {
				usage.end();
			}
		})();
		return trackedStream;
	} catch (error) {
		usage.end();
		throw error;
	}
}
