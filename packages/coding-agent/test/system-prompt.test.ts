import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { formatBytes, refreshDirsFromEnv } from "@oh-my-pi/pi-utils";
import {
	buildSystemPrompt,
	type CpuTopologyData,
	parseDfDisks,
	parseDmiMemory,
	parseOsRelease,
	parseWmicCpu,
	parseWmicDisks,
	parseWmicMemory,
	summarizeCpuTopology,
	summarizeNetworkDevices,
} from "../src/system-prompt";

interface ProbeRunResult {
	elapsedMs: number;
	childElapsedMs: number;
	cached: Record<string, unknown> | null;
	count: number;
	ramCount: number;
}

// In-process buildSystemPrompt calls kick off background hardware probes that
// persist hardware_cache.json. Point the dirs resolver at a throwaway XDG
// cache root so tests (especially the platform-spoofing one below) can never
// write into the developer's or CI profile's real cache.
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

/** lspci output that satisfies both the GPU and network probes. */
const LSPCI_VALID_OUTPUT = [
	"00:02.0 VGA compatible controller: NVIDIA TestGPU",
	"00:03.0 Ethernet controller: FakeNIC 10GbE Controller",
].join("\n");

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
			'#!/usr/bin/env sh\ncase "$0" in *lspci) printf x >> "$OMP_GPU_PROBE_COUNT" ;; *) if [ "$1" = "path" ] && [ "$2" = "win32_VideoController" ]; then printf x >> "$OMP_GPU_PROBE_COUNT"; fi ;; esac\nif [ -n "$OMP_GPU_PROBE_VALID_OUTPUT" ]; then printf "%s\\n" "$OMP_GPU_PROBE_VALID_OUTPUT"; fi\nif [ "$OMP_GPU_PROBE_DESCENDANT_HOLDS_STDOUT" = "true" ]; then sleep "$OMP_GPU_PROBE_SLEEP" & exit 0; fi\nif [ "$OMP_GPU_PROBE_HOLD_STDOUT_OPEN" = "true" ]; then sleep "$OMP_GPU_PROBE_SLEEP" & wait "$!"; fi\nif [ -n "$OMP_GPU_PROBE_SLEEP" ]; then exec sleep "$OMP_GPU_PROBE_SLEEP"; fi\nexit 0\n',
		);
		await fs.chmod(probePath, 0o755);

		// Deterministic stand-ins for the RAM (udevadm) and disk (df) probes so
		// scenarios stay isolated from the host's real hardware.
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
			`import { getHardwareCachePath, refreshDirsFromEnv } from ${JSON.stringify(path.resolve(import.meta.dir, "../../utils/src/index.ts"))};
import { buildSystemPrompt } from ${JSON.stringify(path.join(import.meta.dir, "../src/system-prompt.ts"))};

Object.defineProperty(process, "platform", { value: ${JSON.stringify(options.platform ?? "linux")} });
refreshDirsFromEnv();
const legacyCache = process.env.OMP_GPU_PROBE_LEGACY_CACHE;
if (legacyCache !== undefined) {
	await Bun.write(getHardwareCachePath().replace("hardware_cache.json", "gpu_cache.json"), legacyCache);
}
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
	const built = await buildSystemPrompt(buildOptions);
	await built.hardwareRefreshed;
}
const cacheFile = Bun.file(getHardwareCachePath());
const cached = await cacheFile.exists() ? await cacheFile.json() : null;
const countFile = Bun.file(process.env.OMP_GPU_PROBE_COUNT ?? "");
const count = await countFile.exists() ? (await countFile.text()).length : 0;
const ramCountFile = Bun.file(process.env.OMP_RAM_PROBE_COUNT ?? "");
const ramCount = await ramCountFile.exists() ? (await ramCountFile.text()).length : 0;
console.log(JSON.stringify({ elapsedMs: Math.round(performance.now() - startedAt), cached, count, ramCount }));
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
		// win and the test cannot touch the developer/CI profile's real hardware_cache.json.
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
			throw new Error(`hardware probe scenario failed with exit ${exitCode}: ${stderr}`);
		}
		return { ...JSON.parse(stdout.trim()), childElapsedMs };
	} finally {
		await fs.rm(tempRoot, { recursive: true, force: true });
	}
}

describe.skipIf(process.platform !== "linux")("system prompt hardware probes", () => {
	it("caches a valid GPU probe and reuses it without re-running lspci", async () => {
		const result = await runProbeScenario({ runs: 2, validOutput: LSPCI_VALID_OUTPUT });

		expect(result.cached?.gpu).toBe("02.0 VGA compatible controller: NVIDIA TestGPU");
		expect(result.cached?.network).toBe("FakeNIC 10GbE Controller");
		expect(result.count).toBe(1);
	}, 20_000);

	it("retries failed probes on the next build instead of caching the failure", async () => {
		const result = await runProbeScenario({ runs: 2 });

		expect(result.cached).not.toBeNull();
		expect(result.cached).not.toHaveProperty("gpu");
		// One lspci attempt per build: failures are never persisted.
		expect(result.count).toBe(2);
	}, 20_000);

	it("kills a hung probe at the deadline without blocking the prompt build", async () => {
		const result = await runProbeScenario({ runs: 1, sleepSeconds: 12, holdStdoutOpen: true });

		expect(result.cached).not.toHaveProperty("gpu");
		// The probe is SIGKILLed at ~4.5s; waiting on the descendant would push
		// the settle well past the 12s sleep.
		expect(result.elapsedMs).toBeLessThan(6500);
		// Codex#3838: the child process MUST exit shortly after the deadline, not
		// linger until a descendant holding stdout (sleep 12) exits on its own.
		expect(result.childElapsedMs).toBeLessThan(9000);
	}, 20_000);

	it("does not wait on stdout held by a descendant after a successful probe", async () => {
		const result = await runProbeScenario({ runs: 1, sleepSeconds: 8, descendantHoldsStdout: true });

		expect(result.cached).not.toHaveProperty("gpu");
		// Probe exits 0 immediately but leaves a backgrounded sleep holding the
		// stdout pipe. The success path MUST bound the drain wait.
		expect(result.elapsedMs).toBeLessThan(2000);
		expect(result.childElapsedMs).toBeLessThan(5000);
	}, 20_000);

	it("keeps probe output captured before a descendant delays EOF", async () => {
		const result = await runProbeScenario({
			runs: 1,
			sleepSeconds: 8,
			descendantHoldsStdout: true,
			validOutput: LSPCI_VALID_OUTPUT,
		});

		// Probe exited 0 with valid output before bg sleep held stdout open.
		// Captured stdout MUST be cached, not discarded as if the probe failed.
		expect(result.cached?.gpu).toBe("02.0 VGA compatible controller: NVIDIA TestGPU");
		expect(result.elapsedMs).toBeLessThan(2000);
		expect(result.childElapsedMs).toBeLessThan(5000);
	}, 20_000);

	it("prefers a physical Windows GPU over first-listed virtual adapters", async () => {
		const result = await runProbeScenario({
			runs: 1,
			platform: "win32",
			validOutput: "Name\nGameViewer Virtual Display Adapter\nNVIDIA GeForce RTX 2080 Ti",
		});

		expect(result.cached?.gpu).toBe("NVIDIA GeForce RTX 2080 Ti");
		expect(result.count).toBe(1);
	});

	it("keeps the first Windows adapter when every adapter is virtual", async () => {
		const result = await runProbeScenario({
			runs: 1,
			platform: "win32",
			validOutput: "Name\nRemote Display Adapter\nCitrix Virtual Adapter",
		});

		expect(result.cached?.gpu).toBe("Remote Display Adapter");
		expect(result.count).toBe(1);
	});

	it("ignores the superseded GPU cache and re-probes the Windows GPU", async () => {
		const result = await runProbeScenario({
			runs: 1,
			platform: "win32",
			validOutput: "Name\nGameViewer Virtual Display Adapter\nNVIDIA GeForce RTX 2080 Ti",
			legacyCache: JSON.stringify({ gpu: "GameViewer Virtual Display Adapter" }),
		});

		expect(result.cached?.gpu).toBe("NVIDIA GeForce RTX 2080 Ti");
		expect(result.count).toBe(1);
	});

	it("caches the parsed DMI RAM summary and reuses it across builds", async () => {
		const result = await runProbeScenario({ runs: 2, ramDmiOutput: DMI_MEMORY_FIXTURE });

		expect(result.cached?.ram).toBe(DMI_MEMORY_SUMMARY);
		expect(result.ramCount).toBe(1);
	}, 20_000);

	it("caches the capacity fallback when DMI reports no populated device", async () => {
		const result = await runProbeScenario({ runs: 1 });

		expect(result.cached?.ram).toBe(formatBytes(os.totalmem()));
	}, 15_000);
});

describe.skipIf(process.platform !== "linux")("system prompt hardware refresh signal", () => {
	it("reports probe completion through the build result even when awaited after settling", async () => {
		const buildOptions = {
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
		};
		const first = await buildSystemPrompt(buildOptions);
		// The cold build never blocks: RAM is only present after the refresh.
		expect(first.systemPrompt.join("\n")).not.toContain("- RAM: ");
		expect(await first.hardwareRefreshed).toBe(true);
		// Late registration (after settling) must still observe the outcome —
		// the signal is per-result, not consumed-once global state.
		expect(await first.hardwareRefreshed).toBe(true);

		// A rebuild now renders the probed fields (RAM always resolves on Linux).
		const second = await buildSystemPrompt(buildOptions);
		expect(second.systemPrompt.join("\n")).toContain("- RAM: ");
		expect(await second.hardwareRefreshed).toBe(false);
	}, 20_000);

	it("scopes in-flight refreshes per cache path so a profile switch is never starved", async () => {
		const buildOptions = {
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
		};
		// Schedule a refresh for profile A but do not await it yet.
		const first = await buildSystemPrompt(buildOptions);

		// Switch to profile B while A's refresh may still be in flight.
		const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-prompt-cache-b-"));
		try {
			process.env.XDG_CACHE_HOME = otherRoot;
			await fs.mkdir(path.join(otherRoot, "omp"), { recursive: true });
			refreshDirsFromEnv();

			// B must get its own refresh (not A's stale in-flight promise) and
			// populate its own cache file.
			const second = await buildSystemPrompt(buildOptions);
			expect(await second.hardwareRefreshed).toBe(true);
			const cached = await Bun.file(path.join(otherRoot, "omp", "hardware_cache.json")).json();
			expect(typeof cached.ram).toBe("string");
		} finally {
			await first.hardwareRefreshed;
			await fs.rm(otherRoot, { recursive: true, force: true });
		}
	}, 20_000);
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
		} finally {
			cpus.mockRestore();
			Object.defineProperty(process, "platform", { value: originalPlatform });
		}
	});
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

	it("reports a mixed-speed DMI kit at the slowest stick's rate and derives bandwidth from it", () => {
		const mixed = [
			"E: MEMORY_DEVICE_0_SIZE=17179869184",
			"E: MEMORY_DEVICE_0_TYPE=DDR4",
			"E: MEMORY_DEVICE_0_DATA_WIDTH=64",
			"E: MEMORY_DEVICE_0_CONFIGURED_SPEED_MTS=3200",
			"E: MEMORY_DEVICE_0_BANK_LOCATOR=P0 CHANNEL A",
			"E: MEMORY_DEVICE_1_SIZE=17179869184",
			"E: MEMORY_DEVICE_1_TYPE=DDR4",
			"E: MEMORY_DEVICE_1_DATA_WIDTH=64",
			"E: MEMORY_DEVICE_1_CONFIGURED_SPEED_MTS=2400",
			"E: MEMORY_DEVICE_1_BANK_LOCATOR=P0 CHANNEL B",
		].join("\n");

		expect(parseDmiMemory(mixed)).toBe("32.0GB DDR4 @ 2400 MT/s (2x 16.0GB, 2 channels, ~38 GB/s peak)");
	});

	it("omits rate and bandwidth when a populated stick lacks a configured speed", () => {
		const partial = [
			"E: MEMORY_DEVICE_0_SIZE=17179869184",
			"E: MEMORY_DEVICE_0_TYPE=DDR4",
			"E: MEMORY_DEVICE_0_DATA_WIDTH=64",
			"E: MEMORY_DEVICE_0_CONFIGURED_SPEED_MTS=3200",
			"E: MEMORY_DEVICE_0_BANK_LOCATOR=P0 CHANNEL A",
			"E: MEMORY_DEVICE_1_SIZE=17179869184",
			"E: MEMORY_DEVICE_1_TYPE=DDR4",
			"E: MEMORY_DEVICE_1_DATA_WIDTH=64",
			"E: MEMORY_DEVICE_1_SPEED_MTS=3600",
			"E: MEMORY_DEVICE_1_BANK_LOCATOR=P0 CHANNEL B",
		].join("\n");

		expect(parseDmiMemory(partial)).toBe("32.0GB DDR4 (2x 16.0GB, 2 channels)");
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

	it("collapses same-device subvolume mounts and reports filesystem types without free space", () => {
		const df = [
			"Filesystem     1024-blocks       Used  Available Capacity Mounted on",
			"/dev/mapper/vg-root 1998672896 1123456789 812345600      59% /nix",
			"/dev/mapper/vg-root 1998672896 1123456789 812345600      59% /",
			"/dev/mapper/vg-root 1998672896 1123456789 812345600      59% /home",
			"tmpfs                  48000000          0  48000000       0% /dev/shm",
			"/dev/loop3               128000     128000         0     100% /snap/foo",
			"/dev/nvme1n1p1           511744      31744    480000       7% /boot",
		].join("\n");

		expect(parseDfDisks(df, { "/": "btrfs", "/boot": "vfat", "/dev/shm": "tmpfs" })).toBe(
			"/ 1.9TB btrfs; /boot 499.8MB vfat",
		);
	});

	it("keeps a container overlay root despite its non-device filesystem name", () => {
		const df = [
			"Filesystem     1024-blocks     Used Available Capacity Mounted on",
			"overlay            65531436 30030628  32138952      49% /",
			"tmpfs                 65536        0     65536       0% /dev",
		].join("\n");

		expect(parseDfDisks(df)).toBe("/ 62.5GB");
	});

	it("returns null when df lists no persistent filesystem", () => {
		expect(parseDfDisks("Filesystem 1024-blocks Used Available Capacity Mounted on\ntmpfs 1 0 1 0% /run")).toBeNull();
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

	it("reports a mixed-speed wmic kit at the slowest stick's configured rate", () => {
		const wmic = [
			"Capacity=17179869184",
			"ConfiguredClockSpeed=3200",
			"SMBIOSMemoryType=26",
			"Speed=3600",
			"",
			"Capacity=17179869184",
			"ConfiguredClockSpeed=2400",
			"SMBIOSMemoryType=26",
			"Speed=2400",
		].join("\r\n");

		expect(parseWmicMemory(wmic)).toBe("32.0GB DDR4 @ 2400 MT/s (2x 16.0GB)");
	});

	it("summarizes wmic logicaldisk list output with filesystem types", () => {
		const wmic = [
			"Caption=C:",
			"FileSystem=NTFS",
			"FreeSpace=107374182400",
			"Size=511101108224",
			"",
			"Caption=D:",
			"FileSystem=NTFS",
			"FreeSpace=53687091200",
			"Size=107374182400",
		].join("\r\n");

		expect(parseWmicDisks(wmic)).toBe("C: 476.0GB NTFS; D: 100.0GB NTFS");
	});

	it("summarizes wmic cpu list output", () => {
		const wmic = [
			"L2CacheSize=16384",
			"L3CacheSize=131072",
			"MaxClockSpeed=5700",
			"Name=AMD Ryzen 9 7950X3D 16-Core Processor",
			"NumberOfCores=16",
			"NumberOfLogicalProcessors=32",
		].join("\r\n");

		expect(parseWmicCpu(wmic)).toBe(
			"AMD Ryzen 9 7950X3D 16-Core Processor — 16c/32t, boost 5.70GHz, L2 16.0MB, L3 128.0MB",
		);
	});

	it("summarizes an AMD dual-CCD topology with SMT stride, boost, and caches", () => {
		const data: CpuTopologyData = {
			model: "AMD Ryzen 9 7950X3D 16-Core Processor",
			isAmd: true,
			threadCount: 32,
			coreCount: 16,
			siblingLists: Array.from({ length: 16 }, (_, core) => `${core},${core + 16}`),
			maxFreqKhz: 5763356,
			l2TotalKb: 16384,
			l3Domains: [
				{ sizeKb: 98304, cpuList: "0-7,16-23" },
				{ sizeKb: 32768, cpuList: "8-15,24-31" },
			],
		};

		expect(summarizeCpuTopology(data)).toBe(
			"AMD Ryzen 9 7950X3D 16-Core Processor — 16c/32t, SMT siblings t,t+16, boost 5.76GHz, L2 16.0MB, L3 96.0MB+32.0MB (CCD0 0-7,16-23; CCD1 8-15,24-31)",
		);
	});

	it("summarizes an Intel hybrid topology with P/E cores", () => {
		const data: CpuTopologyData = {
			model: "13th Gen Intel(R) Core(TM) i7-13700K",
			isAmd: false,
			threadCount: 24,
			coreCount: 16,
			siblingLists: [
				...Array.from({ length: 8 }, (_, core) => `${core * 2}-${core * 2 + 1}`),
				...Array.from({ length: 8 }, (_, core) => `${core + 16}`),
			],
			maxFreqKhz: 5400000,
			l2TotalKb: 24576,
			l3Domains: [{ sizeKb: 30720, cpuList: "0-23" }],
			pCores: "0-15",
			eCores: "16-23",
		};

		expect(summarizeCpuTopology(data)).toBe(
			"13th Gen Intel(R) Core(TM) i7-13700K — 16c/24t, P-cores 0-15, E-cores 16-23, SMT siblings t,t+1, boost 5.40GHz, L2 24.0MB, L3 30.0MB",
		);
	});

	it("matches lspci network devices to interface names and strips revisions", () => {
		const lspci = [
			"01:00.0 VGA compatible controller: NVIDIA Corporation AD102 (rev a1)",
			"07:00.0 Ethernet controller: Realtek Semiconductor Co., Ltd. RTL8126 5GbE Controller (rev 01)",
			"08:00.0 Network controller: Qualcomm Technologies, Inc WCN785x Wi-Fi 7(802.11be) 320MHz 2x2 [FastConnect 7800] (rev 01)",
		].join("\n");
		const interfaces = [
			{ name: "enp7s0", pciAddr: "0000:07:00.0" },
			{ name: "wlp8s0", pciAddr: "0000:08:00.0" },
		];

		expect(summarizeNetworkDevices(lspci, interfaces)).toBe(
			"Realtek Semiconductor Co., Ltd. RTL8126 5GbE Controller (enp7s0); Qualcomm Technologies, Inc WCN785x Wi-Fi 7(802.11be) 320MHz 2x2 [FastConnect 7800] (wlp8s0)",
		);
	});

	it("lists unmatched network devices without an interface suffix", () => {
		const lspci = "03:00.0 Network controller: MediaTek MT7922 802.11ax";

		expect(summarizeNetworkDevices(lspci, [])).toBe("MediaTek MT7922 802.11ax");
	});
});
