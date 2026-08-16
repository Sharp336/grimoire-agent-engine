import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatBytes, refreshDirsFromEnv } from "@oh-my-pi/pi-utils";
import {
	buildSystemPrompt,
	parseDfDisks,
	parseDmiMemory,
	parseOsRelease,
	parseWmicDisks,
	parseWmicMemory,
} from "../src/system-prompt";

interface ProbeRunResult {
	elapsedMs: number;
	childElapsedMs: number;
	cached: unknown;
	count: number;
	ramCached: unknown;
	ramCount: number;
}

// In-process buildSystemPrompt calls probe real hardware and persist
// gpu_cache.json / ram_cache.json. Point the dirs resolver at a throwaway
// XDG cache root so tests (especially the platform-spoofing one below) can
// never write into the developer's or CI profile's real caches.
const DIRS_ENV_KEYS = ["XDG_CACHE_HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR"];
let savedDirsEnv: Record<string, string | undefined> = {};
let tempCacheRoot = "";

beforeEach(async () => {
	tempCacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prompt-cache-"));
	savedDirsEnv = {};
	for (const key of DIRS_ENV_KEYS) {
		savedDirsEnv[key] = process.env[key];
		delete process.env[key];
	}
	process.env.XDG_CACHE_HOME = tempCacheRoot;
	// The dirs resolver only adopts an XDG root whose omp/ subdir already exists.
	await fs.mkdir(path.join(tempCacheRoot, "omp"), { recursive: true });
	refreshDirsFromEnv();
});

afterEach(async () => {
	for (const [key, value] of Object.entries(savedDirsEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	refreshDirsFromEnv();
	await fs.rm(tempCacheRoot, { recursive: true, force: true });
});

/** udev dmi/id export for a 2x48GB DDR5-6000 kit on two channels, with empty slots interleaved. */
const DMI_MEMORY_FIXTURE = [
	"E: MEMORY_ARRAY_LOCATION=System Board Or Motherboard",
	"E: MEMORY_DEVICE_0_PRESENT=0",
	"E: MEMORY_DEVICE_0_TYPE=Unknown",
	"E: MEMORY_DEVICE_1_SIZE=51539607552",
	"E: MEMORY_DEVICE_1_TYPE=DDR5",
	"E: MEMORY_DEVICE_1_DATA_WIDTH=64",
	"E: MEMORY_DEVICE_1_SPEED_MTS=6800",
	"E: MEMORY_DEVICE_1_CONFIGURED_SPEED_MTS=6000",
	"E: MEMORY_DEVICE_1_BANK_LOCATOR=P0 CHANNEL A",
	"E: MEMORY_DEVICE_2_PRESENT=0",
	"E: MEMORY_DEVICE_3_SIZE=51539607552",
	"E: MEMORY_DEVICE_3_TYPE=DDR5",
	"E: MEMORY_DEVICE_3_DATA_WIDTH=64",
	"E: MEMORY_DEVICE_3_SPEED_MTS=6800",
	"E: MEMORY_DEVICE_3_CONFIGURED_SPEED_MTS=6000",
	"E: MEMORY_DEVICE_3_BANK_LOCATOR=P0 CHANNEL B",
].join("\n");

const DMI_MEMORY_SUMMARY = "96.0GB DDR5 @ 6000 MT/s (2x 48.0GB, 2 channels, ~96 GB/s peak)";

async function runProbeScenario(options: {
	runs: number;
	platform?: "linux" | "win32";
	sleepSeconds?: number;
	holdStdoutOpen?: boolean;
	descendantHoldsStdout?: boolean;
	validOutput?: string;
	legacyCache?: string;
	ramDmiOutput?: string;
}): Promise<ProbeRunResult> {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gpu-probe-"));
	try {
		const binDir = path.join(tempRoot, "bin");
		const cacheRoot = path.join(tempRoot, "cache");
		const probeCountPath = path.join(tempRoot, "probe-count");
		const ramProbeCountPath = path.join(tempRoot, "ram-probe-count");
		await fs.mkdir(binDir, { recursive: true });
		await fs.mkdir(path.join(cacheRoot, "omp"), { recursive: true });
		const probePath = path.join(binDir, options.platform === "win32" ? "wmic" : "lspci");
		await Bun.write(
			probePath,
			'#!/usr/bin/env sh\nprintf x >> "$OMP_GPU_PROBE_COUNT"\nif [ -n "$OMP_GPU_PROBE_VALID_OUTPUT" ]; then printf "%s\\n" "$OMP_GPU_PROBE_VALID_OUTPUT"; fi\nif [ "$OMP_GPU_PROBE_DESCENDANT_HOLDS_STDOUT" = "true" ]; then sleep "$OMP_GPU_PROBE_SLEEP" & exit 0; fi\nif [ "$OMP_GPU_PROBE_HOLD_STDOUT_OPEN" = "true" ]; then sleep "$OMP_GPU_PROBE_SLEEP" & wait "$!"; fi\nif [ -n "$OMP_GPU_PROBE_SLEEP" ]; then exec sleep "$OMP_GPU_PROBE_SLEEP"; fi\nexit 0\n',
		);
		await fs.chmod(probePath, 0o755);

		// Deterministic stand-ins for the RAM (udevadm) and disk (df) probes so
		// GPU-focused scenarios stay isolated from the host's real hardware.
		const udevadmPath = path.join(binDir, "udevadm");
		await Bun.write(
			udevadmPath,
			'#!/usr/bin/env sh\nprintf x >> "$OMP_RAM_PROBE_COUNT"\nprintf "%s\\n" "$OMP_RAM_PROBE_DMI"\nexit 0\n',
		);
		await fs.chmod(udevadmPath, 0o755);
		const dfPath = path.join(binDir, "df");
		await Bun.write(dfPath, '#!/usr/bin/env sh\nprintf "%s\\n" "$OMP_DF_OUTPUT"\nexit 0\n');
		await fs.chmod(dfPath, 0o755);

		const scenarioPath = path.join(tempRoot, "scenario.ts");
		await Bun.write(
			scenarioPath,
			`import { getGpuCachePath, getRamCachePath, refreshDirsFromEnv } from ${JSON.stringify(path.resolve(import.meta.dir, "../../utils/src/index.ts"))};
import { buildSystemPrompt } from ${JSON.stringify(path.join(import.meta.dir, "../src/system-prompt.ts"))};

Object.defineProperty(process, "platform", { value: ${JSON.stringify(options.platform ?? "linux")} });
refreshDirsFromEnv();
const legacyCache = process.env.OMP_GPU_PROBE_LEGACY_CACHE;
if (legacyCache !== undefined) await Bun.write(getGpuCachePath(), legacyCache);
const buildOptions = {
	contextFiles: [],
	skills: [],
	toolNames: [],
	workspaceTree: {
		rootPath: process.cwd(),
		rendered: "",
		truncated: false,
		totalLines: 0,
		agentsMdFiles: [],
	},
	activeRepoContext: null,
};
const startedAt = performance.now();
for (let index = 0; index < Number(process.env.OMP_GPU_PROBE_RUNS ?? "1"); index += 1) {
	await buildSystemPrompt(buildOptions);
}
const cacheFile = Bun.file(getGpuCachePath());
const cached = await cacheFile.exists() ? await cacheFile.json() : null;
const ramCacheFile = Bun.file(getRamCachePath());
const ramCached = await ramCacheFile.exists() ? await ramCacheFile.json() : null;
const countFile = Bun.file(process.env.OMP_GPU_PROBE_COUNT ?? "");
const count = await countFile.exists() ? (await countFile.text()).length : 0;
const ramCountFile = Bun.file(process.env.OMP_RAM_PROBE_COUNT ?? "");
const ramCount = await ramCountFile.exists() ? (await ramCountFile.text()).length : 0;
console.log(JSON.stringify({ elapsedMs: Math.round(performance.now() - startedAt), cached, ramCached, count, ramCount }));
`,
		);

		const env: Record<string, string | undefined> = {
			...process.env,
			HOME: tempRoot,
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
			XDG_CACHE_HOME: cacheRoot,
			OMP_GPU_PROBE_COUNT: probeCountPath,
			OMP_RAM_PROBE_COUNT: ramProbeCountPath,
			OMP_RAM_PROBE_DMI: options.ramDmiOutput ?? "",
			OMP_DF_OUTPUT: "",
			OMP_GPU_PROBE_RUNS: String(options.runs),
		};
		// Strip inherited dirs-resolver overrides so the temporary HOME/XDG roots
		// win and the test cannot touch the developer/CI profile's real gpu_cache.json.
		for (const key of ["PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR"]) {
			delete env[key];
		}
		if (options.sleepSeconds === undefined) {
			delete env.OMP_GPU_PROBE_SLEEP;
		} else {
			env.OMP_GPU_PROBE_SLEEP = String(options.sleepSeconds);
		}
		if (options.holdStdoutOpen) {
			env.OMP_GPU_PROBE_HOLD_STDOUT_OPEN = "true";
		} else {
			delete env.OMP_GPU_PROBE_HOLD_STDOUT_OPEN;
		}
		if (options.descendantHoldsStdout) {
			env.OMP_GPU_PROBE_DESCENDANT_HOLDS_STDOUT = "true";
		} else {
			delete env.OMP_GPU_PROBE_DESCENDANT_HOLDS_STDOUT;
		}
		if (options.validOutput !== undefined) {
			env.OMP_GPU_PROBE_VALID_OUTPUT = options.validOutput;
		} else {
			delete env.OMP_GPU_PROBE_VALID_OUTPUT;
		}
		if (options.legacyCache !== undefined) {
			env.OMP_GPU_PROBE_LEGACY_CACHE = options.legacyCache;
		} else {
			delete env.OMP_GPU_PROBE_LEGACY_CACHE;
		}

		const childStartedAt = performance.now();
		const child = Bun.spawn([process.execPath, scenarioPath], { stdout: "pipe", stderr: "pipe", env });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		const childElapsedMs = Math.round(performance.now() - childStartedAt);
		if (exitCode !== 0) {
			throw new Error(`GPU probe scenario failed with exit ${exitCode}: ${stderr}`);
		}
		return { ...JSON.parse(stdout.trim()), childElapsedMs };
	} finally {
		await fs.rm(tempRoot, { recursive: true, force: true });
	}
}

describe.skipIf(process.platform !== "linux")("system prompt GPU probe", () => {
	it("caches empty GPU probe results", async () => {
		const result = await runProbeScenario({ runs: 2 });

		expect(result.cached).toEqual({ version: 1, gpu: null });
		expect(result.count).toBe(1);
	}, 15_000);

	it("kills the GPU probe at the prep deadline", async () => {
		const result = await runProbeScenario({ runs: 1, sleepSeconds: 12, holdStdoutOpen: true });

		expect(result.cached).toEqual({ version: 1, gpu: null });
		// Probe is SIGKILLed at ~4.5s and the drain wait is bounded, so in-child
		// time sits near the deadline; waiting on the descendant would push it
		// past the 12s sleep.
		expect(result.elapsedMs).toBeLessThan(6500);
		// Codex#3838: the child process MUST exit shortly after the deadline, not
		// linger until a descendant holding stdout (sleep 12) exits on its own.
		// The bound over in-child time budgets bun spawn/startup on loaded runners
		// while staying far below the descendant's 12s exit.
		expect(result.childElapsedMs).toBeLessThan(9000);
	}, 20_000);

	it("does not wait on stdout held by a descendant after a successful probe", async () => {
		const result = await runProbeScenario({ runs: 1, sleepSeconds: 8, descendantHoldsStdout: true });

		expect(result.cached).toEqual({ version: 1, gpu: null });
		// Probe exits 0 immediately but leaves a backgrounded sleep holding the stdout
		// pipe. The success path MUST bound the drain wait, not block until sleep exits.
		expect(result.elapsedMs).toBeLessThan(2000);
		// Budgets bun spawn/startup overhead; blocking on the descendant would
		// take at least the 8s sleep.
		expect(result.childElapsedMs).toBeLessThan(5000);
	}, 20_000);

	it("keeps probe output captured before a descendant delays EOF", async () => {
		const result = await runProbeScenario({
			runs: 1,
			sleepSeconds: 8,
			descendantHoldsStdout: true,
			validOutput: "00:02.0 VGA compatible controller: NVIDIA TestGPU",
		});

		// Probe exited 0 with valid output before bg sleep held stdout open.
		// Captured stdout MUST be cached, not discarded as if the probe failed.
		expect(result.cached).toEqual({ version: 1, gpu: "02.0 VGA compatible controller: NVIDIA TestGPU" });
		expect(result.elapsedMs).toBeLessThan(2000);
		// Budgets bun spawn/startup overhead; blocking on the descendant would
		// take at least the 8s sleep.
		expect(result.childElapsedMs).toBeLessThan(5000);
	}, 20_000);

	it("prefers a physical Windows GPU over first-listed virtual adapters", async () => {
		const result = await runProbeScenario({
			runs: 1,
			platform: "win32",
			validOutput: "Name\nGameViewer Virtual Display Adapter\nNVIDIA GeForce RTX 2080 Ti",
		});

		expect(result.cached).toEqual({ version: 1, gpu: "NVIDIA GeForce RTX 2080 Ti" });
		expect(result.count).toBe(1);
	});

	it("keeps the first Windows adapter when every adapter is virtual", async () => {
		const result = await runProbeScenario({
			runs: 1,
			platform: "win32",
			validOutput: "Name\nRemote Display Adapter\nCitrix Virtual Adapter",
		});

		expect(result.cached).toEqual({ version: 1, gpu: "Remote Display Adapter" });
		expect(result.count).toBe(1);
	});

	it("rejects a pre-versioning cache and re-probes the Windows GPU", async () => {
		const result = await runProbeScenario({
			runs: 1,
			platform: "win32",
			validOutput: "Name\nGameViewer Virtual Display Adapter\nNVIDIA GeForce RTX 2080 Ti",
			legacyCache: JSON.stringify({ gpu: "GameViewer Virtual Display Adapter" }),
		});

		// The old unversioned cache holds the virtual adapter the previous parser
		// picked; it MUST be discarded and re-probed, not served indefinitely.
		expect(result.cached).toEqual({ version: 1, gpu: "NVIDIA GeForce RTX 2080 Ti" });
		expect(result.count).toBe(1);
	});
});

describe.skipIf(process.platform !== "linux")("system prompt CPU model", () => {
	it("does not call os.cpus while building the workstation block", async () => {
		const cpus = spyOn(os, "cpus").mockImplementation(() => [
			{
				model: "Synthetic Slow CPU",
				speed: 0,
				times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
			},
		]);
		try {
			await buildSystemPrompt({
				resolvedCustomPrompt: "Base prompt",
				contextFiles: [],
				skills: [],
				rules: [],
				workspaceTree: {
					rootPath: import.meta.dir,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				activeRepoContext: null,
			});

			expect(cpus).not.toHaveBeenCalled();
		} finally {
			cpus.mockRestore();
		}
	});
});

describe("non-Linux system prompt CPU model", () => {
	it("includes the model returned by os.cpus", async () => {
		const originalPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "darwin" });
		const cpus = spyOn(os, "cpus").mockImplementation(() => [
			{
				model: "Synthetic Non-Linux CPU",
				speed: 0,
				times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
			},
		]);
		try {
			const systemPrompt = await buildSystemPrompt({
				resolvedCustomPrompt: "Base prompt",
				contextFiles: [],
				skills: [],
				rules: [],
				workspaceTree: {
					rootPath: import.meta.dir,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				activeRepoContext: null,
			});

			expect(cpus).toHaveBeenCalledTimes(1);
			expect(systemPrompt.systemPrompt.join("\n")).toContain("- CPU: Synthetic Non-Linux CPU");
			// Spoofed non-Linux platform takes the capacity-only RAM fallback.
			expect(systemPrompt.systemPrompt.join("\n")).toContain(`- RAM: ${formatBytes(os.totalmem())}`);
		} finally {
			cpus.mockRestore();
			Object.defineProperty(process, "platform", { value: originalPlatform });
		}
	});
});

describe.skipIf(process.platform !== "linux")("system prompt RAM probe", () => {
	it("caches the parsed DMI RAM summary and reuses it across builds", async () => {
		const result = await runProbeScenario({ runs: 2, ramDmiOutput: DMI_MEMORY_FIXTURE });

		expect(result.ramCached).toEqual({ ram: DMI_MEMORY_SUMMARY });
		expect(result.ramCount).toBe(1);
	}, 20_000);

	it("caches the capacity fallback when DMI reports no populated device", async () => {
		const result = await runProbeScenario({ runs: 1 });

		expect(result.ramCached).toEqual({ ram: formatBytes(os.totalmem()) });
	}, 15_000);
});

describe("workstation hardware parsers", () => {
	it("summarizes populated DMI memory devices with channels and peak bandwidth", () => {
		expect(parseDmiMemory(DMI_MEMORY_FIXTURE)).toBe(DMI_MEMORY_SUMMARY);
	});

	it("omits channel and bandwidth detail when bank locators are unavailable", () => {
		const withoutLocators = DMI_MEMORY_FIXTURE.split("\n")
			.filter(line => !line.includes("BANK_LOCATOR"))
			.join("\n");
		expect(parseDmiMemory(withoutLocators)).toBe("96.0GB DDR5 @ 6000 MT/s (2x 48.0GB)");
	});

	it("dedupes repeated channel tokens across a 4-DIMM two-channel kit", () => {
		const fourDimms = [1, 2, 3, 4]
			.flatMap(slot => [
				`E: MEMORY_DEVICE_${slot}_SIZE=17179869184`,
				`E: MEMORY_DEVICE_${slot}_TYPE=DDR4`,
				`E: MEMORY_DEVICE_${slot}_DATA_WIDTH=64`,
				`E: MEMORY_DEVICE_${slot}_CONFIGURED_SPEED_MTS=3200`,
				`E: MEMORY_DEVICE_${slot}_BANK_LOCATOR=P0 CHANNEL ${slot <= 2 ? "A" : "B"}`,
			])
			.join("\n");

		expect(parseDmiMemory(fourDimms)).toBe("64.0GB DDR4 @ 3200 MT/s (4x 16.0GB, 2 channels, ~51 GB/s peak)");
	});

	it("never counts slot-level bank labels as channels", () => {
		const slotBanks = [0, 1, 2, 3]
			.flatMap(slot => [
				`E: MEMORY_DEVICE_${slot}_SIZE=17179869184`,
				`E: MEMORY_DEVICE_${slot}_TYPE=DDR4`,
				`E: MEMORY_DEVICE_${slot}_CONFIGURED_SPEED_MTS=3200`,
				`E: MEMORY_DEVICE_${slot}_BANK_LOCATOR=BANK ${slot}`,
			])
			.join("\n");

		expect(parseDmiMemory(slotBanks)).toBe("64.0GB DDR4 @ 3200 MT/s (4x 16.0GB)");
	});

	it("returns null when no DMI memory device is populated", () => {
		expect(parseDmiMemory("E: MEMORY_DEVICE_0_PRESENT=0\nE: MEMORY_DEVICE_0_TYPE=Unknown")).toBeNull();
	});

	it("prefers os-release PRETTY_NAME and falls back to NAME + VERSION_ID", () => {
		const nixos = ['NAME="NixOS"', 'PRETTY_NAME="NixOS 25.11 (Xantusia)"', 'VERSION_ID="25.11"'].join("\n");
		expect(parseOsRelease(nixos)).toBe("NixOS 25.11 (Xantusia)");

		const debian = ['NAME="Debian GNU/Linux"', 'VERSION_ID="12"', "ID=debian"].join("\n");
		expect(parseOsRelease(debian)).toBe("Debian GNU/Linux 12");

		expect(parseOsRelease("ID=mystery")).toBeNull();
	});

	it("collapses same-device subvolume mounts and skips pseudo filesystems in df output", () => {
		const df = [
			"Filesystem     1024-blocks       Used  Available Capacity Mounted on",
			"/dev/mapper/vg-root 1998672896 1123456789 812345600      59% /nix",
			"/dev/mapper/vg-root 1998672896 1123456789 812345600      59% /",
			"/dev/mapper/vg-root 1998672896 1123456789 812345600      59% /home",
			"tmpfs                  48000000          0  48000000       0% /dev/shm",
			"/dev/loop3               128000     128000         0     100% /snap/foo",
			"/dev/nvme1n1p1           511744      31744    480000       7% /boot",
		].join("\n");

		expect(parseDfDisks(df)).toBe("/ 1.9TB (774.7GB free); /boot 499.8MB (468.8MB free)");
	});

	it("keeps a container overlay root despite its non-device filesystem name", () => {
		const df = [
			"Filesystem     1024-blocks     Used Available Capacity Mounted on",
			"overlay            65531436 30030628  32138952      49% /",
			"tmpfs                 65536        0     65536       0% /dev",
		].join("\n");

		expect(parseDfDisks(df)).toBe("/ 62.5GB (30.7GB free)");
	});

	it("returns undefined when df lists no persistent filesystem", () => {
		expect(
			parseDfDisks("Filesystem 1024-blocks Used Available Capacity Mounted on\ntmpfs 1 0 1 0% /run"),
		).toBeUndefined();
	});

	it("summarizes wmic memorychip list output", () => {
		const wmic = [
			"Capacity=17179869184",
			"ConfiguredClockSpeed=3200",
			"SMBIOSMemoryType=26",
			"Speed=3600",
			"",
			"Capacity=17179869184",
			"ConfiguredClockSpeed=3200",
			"SMBIOSMemoryType=26",
			"Speed=3600",
		].join("\r\n");

		expect(parseWmicMemory(wmic)).toBe("32.0GB DDR4 @ 3200 MT/s (2x 16.0GB)");
	});

	it("summarizes wmic logicaldisk list output", () => {
		const wmic = [
			"Caption=C:",
			"FreeSpace=107374182400",
			"Size=511101108224",
			"",
			"Caption=D:",
			"FreeSpace=53687091200",
			"Size=107374182400",
		].join("\r\n");

		expect(parseWmicDisks(wmic)).toBe("C: 476.0GB (100.0GB free); D: 100.0GB (50.0GB free)");
	});
});
