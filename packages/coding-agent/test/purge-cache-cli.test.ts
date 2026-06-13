import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { readModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import * as piUtils from "@oh-my-pi/pi-utils";
import { runPurgeCacheCommand } from "../src/cli/purge-cache-cli";

const TTL_MS = 24 * 60 * 60 * 1000;
const SEED_MODEL = buildModel({
	id: "m1",
	name: "M1",
	api: "openai-completions",
	provider: "ollama-cloud",
	baseUrl: "https://ollama.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 1024,
});

// `runPurgeCacheCommand` resolves its model DB and weight-cache locations from
// pi-utils getters; redirect them to a sandbox so the real clearModelCache +
// fs.rm run against temp paths, never the user's actual caches.
describe("runPurgeCacheCommand", () => {
	let base = "";
	let dbPath = "";
	let fastembed = "";
	let tiny = "";
	let gpu = "";

	beforeEach(async () => {
		base = await fs.mkdtemp(path.join(os.tmpdir(), "purge-cache-cli-"));
		dbPath = path.join(base, "models.db");
		fastembed = path.join(base, "fastembed");
		tiny = path.join(base, "tiny-models");
		gpu = path.join(base, "gpu_cache.json");
		spyOn(piUtils, "getModelDbPath").mockReturnValue(dbPath);
	});

	afterEach(async () => {
		mock.restore();
		if (base) {
			await fs.rm(base, { recursive: true, force: true });
			base = "";
		}
	});

	it("with --all clears the metadata cache and removes exactly the weight-cache locations", async () => {
		await fs.mkdir(fastembed, { recursive: true });
		await fs.mkdir(tiny, { recursive: true });
		await fs.writeFile(gpu, "{}");
		const survivor = path.join(base, "unrelated");
		await fs.mkdir(survivor, { recursive: true });
		spyOn(piUtils, "getFastembedCacheDir").mockReturnValue(fastembed);
		spyOn(piUtils, "getTinyModelsCacheDir").mockReturnValue(tiny);
		spyOn(piUtils, "getGpuCachePath").mockReturnValue(gpu);
		// Guard: never run the deletion against the real cache dirs if a spy missed.
		expect(piUtils.getFastembedCacheDir()).toBe(fastembed);

		writeModelCache("ollama-cloud", Date.now(), [SEED_MODEL], true, "fp", dbPath);
		expect(readModelCache("ollama-cloud", TTL_MS, Date.now, dbPath)).not.toBeNull();

		await runPurgeCacheCommand({ all: true, json: true });

		expect(readModelCache("ollama-cloud", TTL_MS, Date.now, dbPath)).toBeNull();
		await expect(fs.access(fastembed)).rejects.toThrow();
		await expect(fs.access(tiny)).rejects.toThrow();
		await expect(fs.access(gpu)).rejects.toThrow();
		// fs.rm targeted exactly the three caches, not their shared parent.
		expect((await fs.stat(survivor)).isDirectory()).toBe(true);
	});

	it("without --all purges the metadata cache and never touches the weight caches", async () => {
		const feSpy = spyOn(piUtils, "getFastembedCacheDir").mockImplementation(() => {
			throw new Error("weight-cache getter must not run without --all");
		});
		writeModelCache("ollama-cloud", Date.now(), [SEED_MODEL], true, "fp", dbPath);

		await expect(runPurgeCacheCommand({ all: false, json: true })).resolves.toBeUndefined();

		expect(readModelCache("ollama-cloud", TTL_MS, Date.now, dbPath)).toBeNull();
		expect(feSpy).not.toHaveBeenCalled();
	});
});
