import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { shutdownSttClient, sttClient } from "../stt/asr-client";
import { isSttModelCached } from "../stt/downloader";
import { resolveNemotronWorkerPath } from "../stt/nemotron-worker-client";

/**
 * Native Nemotron STT worker end-to-end test. Requires the built
 * `stt-nemotron` binary and the FluidAudio latin/1120ms model cache (shared
 * with VoxKey). Skips cleanly on machines without either so the suite stays
 * portable; on a configured machine this proves spawn → framing → stream →
 * stop → transcript through the same SttClient the editor uses.
 */

const binary = resolveNemotronWorkerPath();
const modelReady = binary !== null && (await isSttModelCached("nemotron"));
const wavPath = process.env.OMP_STT_TEST_WAV ?? "/tmp/omp-stt-test.wav";
const wavAvailable = fs.existsSync(wavPath);

/** Decode a 16 kHz mono s16-le WAV into normalized Float32 samples. */
function readTestWav(file: string): Float32Array {
	const data = fs.readFileSync(file);
	const dataOffset = data.indexOf(Buffer.from("data"), 0, "ascii") + 8;
	const pcm = new Int16Array(data.buffer, data.byteOffset + dataOffset, (data.length - dataOffset) / 2);
	const samples = new Float32Array(pcm.length);
	for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
	return samples;
}

describe("nemotron stt worker", () => {
	test("binary + model resolve", () => {
		if (!binary) return; // portable skip
		expect(fs.statSync(binary).isFile()).toBe(true);
		expect(modelReady).toBe(true);
	});

	test("stream: partials then final transcript via sttClient", async () => {
		if (!(binary && modelReady && wavAvailable)) return;
		const samples = readTestWav(wavPath);
		const partials: string[] = [];
		const segments: string[] = [];
		const stream = sttClient.startStream("nemotron", {
			language: "en",
			onPartial: text => partials.push(text),
			onSegment: text => segments.push(text),
		});
		const frameSamples = 4000;
		for (let i = 0; i < samples.length; i += frameSamples) {
			stream.pushAudio(samples.subarray(i, i + frameSamples));
		}
		const text = await stream.stop();
		expect(text.trim().length).toBeGreaterThan(0);
		// The worker streams true partials (no endpointer segmentation).
		expect(partials.length).toBeGreaterThan(0);
		// One final segment, emitted at stop.
		expect(segments.length).toBeLessThanOrEqual(1);
		await shutdownSttClient();
	}, 120_000);
});
