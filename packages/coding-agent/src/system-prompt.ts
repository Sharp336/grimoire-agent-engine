/**
 * System prompt construction and project context loading
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ToolExample, TSchema } from "@oh-my-pi/pi-ai";
import { renderToolInventory } from "@oh-my-pi/pi-ai/dialect";
import {
	$env,
	formatBytes,
	getAgentDir,
	getHardwareCachePath,
	getProjectDir,
	hasFsCode,
	isEnoent,
	logger,
	prompt,
} from "@oh-my-pi/pi-utils";
import { contextFileCapability } from "./capability/context-file";
import { systemPromptCapability } from "./capability/system-prompt";
import { findConfigFile } from "./config";
import type { Personality, SkillsSettings } from "./config/settings";
import { type ContextFile, loadCapability, type SystemPrompt as SystemPromptFile } from "./discovery";
import { expandAtImports } from "./discovery/at-imports";
import { loadSkills, type Skill } from "./extensibility/skills";
import { hasObsidian } from "./internal-urls/vault-protocol";
import activeRepoContextTemplate from "./prompts/system/active-repo-context.md" with { type: "text" };
import computerSafetyPrompt from "./prompts/system/computer-safety.md" with { type: "text" };
import customSystemPromptTemplate from "./prompts/system/custom-system-prompt.md" with { type: "text" };
import defaultPersonality from "./prompts/system/personalities/default.md" with { type: "text" };
import friendlyPersonality from "./prompts/system/personalities/friendly.md" with { type: "text" };
import pragmaticPersonality from "./prompts/system/personalities/pragmatic.md" with { type: "text" };
import projectPromptTemplate from "./prompts/system/project-prompt.md" with { type: "text" };
import systemPromptTemplate from "./prompts/system/system-prompt.md" with { type: "text" };
import { normalizeConcurrencyLimit } from "./task/parallel";
import { usesCodexTaskPrompt } from "./task/prompt-policy";
import { type ActiveRepoContext, resolveActiveRepoContext } from "./utils/active-repo-context";
import { normalizePromptPath } from "./utils/prompt-path";
import { AGENTS_MD_LIMIT, buildWorkspaceTree, type WorkspaceTree } from "./workspace-tree";

/** Bundled personality specs, keyed by the `personality` setting value. */
const PERSONALITY_SPECS: Record<Exclude<Personality, "none">, string> = {
	default: defaultPersonality,
	friendly: friendlyPersonality,
	pragmatic: pragmaticPersonality,
};

/**
 * Load the user-level PERSONALITY.md override for the system prompt's
 * personality block from `<agentDir>/PERSONALITY.md` (`~/.omp/agent` by
 * default; profile, XDG, and `PI_CODING_AGENT_DIR` aware). Returns null when
 * the file is absent, empty, or unreadable; callers then render the configured
 * preset. Read failures other than a missing file warn instead of failing the
 * build.
 */
async function loadPersonalityOverride(): Promise<string | null> {
	const filePath = path.join(getAgentDir(), "PERSONALITY.md");
	try {
		const content = (await Bun.file(filePath).text()).trim();
		if (content) return content;
		logger.warn("PERSONALITY.md is empty; using the configured personality preset", { path: filePath });
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Failed to read PERSONALITY.md; using the configured personality preset", {
				path: filePath,
				error: String(error),
			});
		}
	}
	return null;
}

interface AlwaysApplyRule {
	name: string;
	content: string;
	path: string;
}

function normalizePromptBlock(content: string): string {
	return prompt.format(content, { renderPhase: "post-render" }).trim();
}

function splitComparablePromptBlocks(content: string | null | undefined): string[] {
	const normalized = firstNonEmpty(content);
	if (!normalized) return [];
	const rendered = normalizePromptBlock(normalized);
	// Split on blank-line paragraph boundaries, but not inside fenced code
	// blocks. A rule that appears only inside a fenced example in another file
	// is an example, not an instruction, so it must not count as containment.
	const blocks: string[] = [];
	let current: string[] = [];
	let inFence = false;
	for (const line of rendered.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			current.push(line);
			continue;
		}
		if (!inFence && line.trim() === "" && current.length > 0 && current[current.length - 1].trim() !== "") {
			const block = current.join("\n").trim();
			if (block.length > 0) blocks.push(block);
			current = [];
			continue;
		}
		current.push(line);
	}
	const tail = current.join("\n").trim();
	if (tail.length > 0) blocks.push(tail);
	return blocks;
}

/**
 * Check whether `ruleBlocks` appears as a contiguous subsequence of
 * `sourceBlocks`. Both inputs must already be normalized and split via
 * {@link splitComparablePromptBlocks}.
 */
function promptBlocksContain(sourceBlocks: string[], ruleBlocks: string[]): boolean {
	if (sourceBlocks.length === 0 || ruleBlocks.length === 0 || ruleBlocks.length > sourceBlocks.length) {
		return false;
	}
	for (let start = 0; start <= sourceBlocks.length - ruleBlocks.length; start += 1) {
		if (ruleBlocks.every((block, offset) => sourceBlocks[start + offset] === block)) return true;
	}
	return false;
}

function promptSourceContainsRule(source: string | null | undefined, ruleContent: string): boolean {
	return promptBlocksContain(splitComparablePromptBlocks(source), splitComparablePromptBlocks(ruleContent));
}

function dedupeAlwaysApplyRules(
	alwaysApplyRules: AlwaysApplyRule[] | undefined,
	promptSources: Array<string | null | undefined>,
): AlwaysApplyRule[] {
	if (!alwaysApplyRules || alwaysApplyRules.length === 0) return [];

	return alwaysApplyRules.filter(
		rule => !promptSources.some(source => promptSourceContainsRule(source, rule.content)),
	);
}

function dedupePromptSource(source: string | null | undefined, otherSources: Array<string | null | undefined>): string {
	const resolvedSource = firstNonEmpty(source);
	if (!resolvedSource) return "";

	return otherSources.some(otherSource => promptSourceContainsRule(otherSource, resolvedSource)) ? "" : resolvedSource;
}

function firstNonEmpty(...values: (string | undefined | null)[]): string | null {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return null;
}

function renderActiveRepoContextPrompt(activeRepoContext: ActiveRepoContext | null): string {
	if (!activeRepoContext) return "";
	return prompt
		.render(activeRepoContextTemplate, {
			relativeRepoRoot: normalizePromptPath(activeRepoContext.relativeRepoRoot),
		})
		.trim();
}

function parseWindowsGpuModel(output: string): string | null {
	const adapters = output
		.split("\n")
		.map(line => line.trim())
		.filter(line => Boolean(line) && line.toLowerCase() !== "name");
	const physicalAdapters = adapters.filter(adapter => !/\b(?:virtual|mirror|remote|citrix)\b/i.test(adapter));
	return (
		physicalAdapters.find(adapter => /\b(?:nvidia|amd|radeon|intel)\b/i.test(adapter)) ??
		physicalAdapters[0] ??
		adapters[0] ??
		null
	);
}

const SYSTEM_PROMPT_PREP_TIMEOUT_MS = 5000;
/** Kept below prep timeout so timed-out probes can still write the null cache before fallback. */
const HOST_PROBE_TIMEOUT_MS = SYSTEM_PROMPT_PREP_TIMEOUT_MS - 500;
/** Drop stdout from a probe descendant that inherited the pipe after the probe exited. */
const HOST_PROBE_STDOUT_DRAIN_MS = 250;

interface HostProbeOptions {
	/** Return captured stdout even on a non-zero exit (df exits 1 when any single mount cannot be statted). */
	lenientExit?: boolean;
}

async function runHostProbe(cmd: string[], options: HostProbeOptions = {}): Promise<string | null> {
	try {
		const proc = Bun.spawn({
			cmd,
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
			timeout: HOST_PROBE_TIMEOUT_MS,
			// SIGKILL so a probe ignoring SIGTERM (PATH wrapper, wedged WMI) still
			// dies at the deadline and lets the cached-probe path reach its
			// null-cache write.
			killSignal: "SIGKILL",
		});
		const stdoutReader = proc.stdout.getReader();
		let stdout = "";
		const decoder = new TextDecoder();
		const stdoutDone = (async () => {
			while (true) {
				const chunk = await stdoutReader.read();
				if (chunk.done) break;
				stdout += decoder.decode(chunk.value, { stream: true });
			}
			stdout += decoder.decode();
		})();
		const exitCode = await proc.exited;
		// Even on exit 0, a probe wrapper can leave a descendant holding stdout open.
		// Bound the EOF wait so a cached probe cannot outlive its child in either path;
		// keep whatever bytes the reader already captured before cancelling.
		const drained = await Promise.race([
			stdoutDone.then(() => "ok" as const).catch(() => "err" as const),
			Bun.sleep(HOST_PROBE_STDOUT_DRAIN_MS).then(() => "timeout" as const),
		]);
		if (drained !== "ok") {
			await stdoutReader.cancel().catch(() => undefined);
			await stdoutDone.catch(() => undefined);
		}
		if (exitCode !== 0 && !(options.lenientExit && stdout.trim().length > 0)) return null;
		return stdout;
	} catch {
		return null;
	}
}

/**
 * Pick the most interesting GPU. On Linux the caller supplies one shared
 * `lspci` capture (the network probe consumes the same output).
 */
async function getGpuModel(lspciText: string | null): Promise<string | null> {
	switch (process.platform) {
		case "win32": {
			const output = await runHostProbe(["wmic", "path", "win32_VideoController", "get", "name"]);
			return output ? parseWindowsGpuModel(output) : null;
		}
		case "linux": {
			if (!lspciText) return null;
			const gpus: Array<{ name: string; priority: number }> = [];
			for (const line of lspciText.split("\n")) {
				if (!/(VGA|3D|Display)/i.test(line)) continue;
				const parts = line.split(":");
				const name = parts.length > 1 ? parts.slice(1).join(":").trim() : line.trim();
				const nameLower = name.toLowerCase();
				// Skip BMC/server management adapters
				if (/aspeed|matrox g200|mgag200/i.test(name)) continue;
				// Prioritize discrete GPUs
				let priority = 0;
				if (
					nameLower.includes("nvidia") ||
					nameLower.includes("geforce") ||
					nameLower.includes("quadro") ||
					nameLower.includes("rtx")
				) {
					priority = 3;
				} else if (nameLower.includes("amd") || nameLower.includes("radeon") || nameLower.includes("rx ")) {
					priority = 3;
				} else if (nameLower.includes("intel")) {
					priority = 1;
				} else {
					priority = 2;
				}
				gpus.push({ name, priority });
			}
			if (gpus.length === 0) return null;
			gpus.sort((a, b) => b.priority - a.priority);
			return gpus[0].name;
		}
		default:
			return null;
	}
}

/** SMBIOS memory-device type codes (DMTF spec 7.18.2) as reported by wmic's `SMBIOSMemoryType`. */
const SMBIOS_MEMORY_TYPE: Record<string, string> = {
	"18": "DDR",
	"19": "DDR2",
	"24": "DDR3",
	"26": "DDR4",
	"27": "LPDDR",
	"28": "LPDDR2",
	"29": "LPDDR3",
	"30": "LPDDR4",
	"34": "DDR5",
	"35": "LPDDR5",
};

/**
 * A mixed-speed kit runs the whole set at a common supported rate, and only
 * the firmware-configured per-stick speed reflects that rate — a stick's
 * rated maximum (DMI `Speed`) can exceed it. Report the lowest configured
 * speed, and only when every populated stick exposes one; otherwise omit the
 * rate (and the bandwidth derived from it) rather than overstate the
 * hardware.
 */
function commonSpeedMts(configuredSpeeds: number[]): number {
	return configuredSpeeds.length > 0 && configuredSpeeds.every(speed => speed > 0) ? Math.min(...configuredSpeeds) : 0;
}

/**
 * Parse the `E: MEMORY_DEVICE_<n>_<KEY>=<value>` properties that systemd's
 * dmi/id udev builtin exports (readable without root, unlike `dmidecode`)
 * into a one-line RAM summary, e.g.
 * `96.0GB DDR5 @ 6000 MT/s (2x 48.0GB, 2 channels, ~96 GB/s peak)`.
 *
 * Channel count and the derived theoretical peak bandwidth
 * (`channels x data width x transfer rate`) appear only when the locators name
 * channels unambiguously (`CHANNEL A` / `DIMM_A1` style). The memory-controller
 * clock ratio (UCLK 1:1 vs 1:2) is firmware state that DMI does not expose, so
 * it is intentionally absent.
 *
 * Exported for tests. Returns null when no populated memory device is found.
 */
export function parseDmiMemory(udevText: string): string | null {
	const devices = new Map<string, Record<string, string>>();
	for (const line of udevText.split("\n")) {
		const match = /^E:\s*MEMORY_DEVICE_(\d+)_([A-Z0-9_]+)=(.*)$/.exec(line.trim());
		if (!match) continue;
		let device = devices.get(match[1]);
		if (!device) {
			device = {};
			devices.set(match[1], device);
		}
		device[match[2]] = match[3].trim();
	}

	const populated = [...devices.values()].filter(device => {
		if (device.PRESENT === "0") return false;
		const size = Number(device.SIZE);
		return Number.isFinite(size) && size > 0;
	});
	if (populated.length === 0) return null;

	const sizes = populated.map(device => Number(device.SIZE));
	const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
	const type = populated.map(device => device.TYPE).find(value => value && value !== "Unknown");
	const speedMts = commonSpeedMts(populated.map(device => Number(device.CONFIGURED_SPEED_MTS) || 0));
	// Channel count: only trust an explicit channel token in the locators.
	// Deduping raw bank locators would count slot-level labels ("BANK 0".."BANK 3")
	// as one fictitious channel per DIMM and overstate the peak bandwidth.
	const channelTokens = populated.map(device => {
		const locators = `${device.BANK_LOCATOR ?? ""} ${device.LOCATOR ?? ""}`;
		const named = /CHANNEL[\s_-]*([A-Z0-9]+)/i.exec(locators);
		if (named) return named[1].toUpperCase();
		const dimmSlot = /\bDIMM[\s_-]?([A-Z])\d*\b/i.exec(locators);
		return dimmSlot ? dimmSlot[1].toUpperCase() : null;
	});
	const channels = channelTokens.every(token => token !== null) ? new Set(channelTokens).size : 0;
	const dataWidthBits = Math.max(0, ...populated.map(device => Number(device.DATA_WIDTH) || 0)) || 64;

	let summary = formatBytes(totalBytes);
	if (type) summary += ` ${type}`;
	if (speedMts > 0) summary += ` @ ${speedMts} MT/s`;
	const details: string[] = [
		sizes.every(size => size === sizes[0])
			? `${populated.length}x ${formatBytes(sizes[0])}`
			: `${populated.length} DIMMs`,
	];
	if (channels > 0) {
		details.push(`${channels} ${channels === 1 ? "channel" : "channels"}`);
		if (speedMts > 0) {
			details.push(`~${Math.round((channels * dataWidthBits * speedMts) / 8000)} GB/s peak`);
		}
	}
	return `${summary} (${details.join(", ")})`;
}

/** Split `wmic ... /format:list` output (blank-line separated `Key=Value` blocks) into per-record maps. */
function parseWmicList(output: string): Array<Record<string, string>> {
	const records: Array<Record<string, string>> = [];
	for (const block of output.split(/\r?\n\s*\r?\n/)) {
		const record: Record<string, string> = {};
		for (const line of block.split("\n")) {
			const trimmed = line.trim();
			const separator = trimmed.indexOf("=");
			if (separator > 0) record[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
		}
		if (Object.keys(record).length > 0) records.push(record);
	}
	return records;
}

/**
 * Parse `wmic memorychip get ... /format:list` output (blank-line separated
 * `Key=Value` blocks, one per DIMM) into a one-line RAM summary.
 * Exported for tests. Returns null when no stick reports a capacity.
 */
export function parseWmicMemory(output: string): string | null {
	const populated = parseWmicList(output).filter(stick => Number(stick.Capacity) > 0);

	if (populated.length === 0) return null;

	const sizes = populated.map(stick => Number(stick.Capacity));
	const totalBytes = sizes.reduce((sum, size) => sum + size, 0);
	const type = populated
		.map(stick => SMBIOS_MEMORY_TYPE[stick.SMBIOSMemoryType ?? ""])
		.find(value => value !== undefined);
	const speedMts = commonSpeedMts(populated.map(stick => Number(stick.ConfiguredClockSpeed) || 0));

	let summary = formatBytes(totalBytes);
	if (type) summary += ` ${type}`;
	if (speedMts > 0) summary += ` @ ${speedMts} MT/s`;
	const sticksDetail = sizes.every(size => size === sizes[0])
		? `${populated.length}x ${formatBytes(sizes[0])}`
		: `${populated.length} DIMMs`;
	return `${summary} (${sticksDetail})`;
}

async function getRamInfo(): Promise<string | null> {
	switch (process.platform) {
		case "linux": {
			// systemd's dmi/id udev builtin re-exports the SMBIOS memory tables
			// that only root can read from /sys/firmware/dmi, so DDR generation,
			// transfer rate, and slot population are available unprivileged.
			const output = await runHostProbe(["udevadm", "info", "/sys/devices/virtual/dmi/id"]);
			const parsed = output ? parseDmiMemory(output) : null;
			if (parsed) return parsed;
			break;
		}
		case "win32": {
			const output = await runHostProbe([
				"wmic",
				"memorychip",
				"get",
				"Capacity,ConfiguredClockSpeed,Speed,SMBIOSMemoryType",
				"/format:list",
			]);
			const parsed = output ? parseWmicMemory(output) : null;
			if (parsed) return parsed;
			break;
		}
	}
	// Capacity-only fallback (macOS, containers, hosts without DMI export).
	// os.totalmem() reports usable RAM, slightly below the installed total.
	const totalBytes = os.totalmem();
	return totalBytes > 0 ? formatBytes(totalBytes) : null;
}

/**
 * Parse POSIX `df -kP` output into a one-line per-mount disk summary, e.g.
 * `/ 1.9TB btrfs; /boot 499.8MB vfat`.
 *
 * Deliberately stable: total size and filesystem type only. Free space is
 * omitted because it changes constantly and would bust prompt KV caching.
 * Keeps block-device-backed filesystems (plus the root mount, so container
 * overlayfs roots survive), collapses bind/subvolume mounts sharing a device
 * to the shortest mount point, and skips loop/ram pseudo-disks (snaps).
 * Exported for tests. Returns null when nothing qualifies.
 */
export function parseDfDisks(dfText: string, fstypeByMount: Record<string, string> = {}): string | null {
	const byDevice = new Map<string, { mount: string; totalBytes: number }>();
	for (const line of dfText.split("\n").slice(1)) {
		const match = /^(\S+)\s+(\d+)\s+\d+\s+\d+\s+\S+\s+(.+)$/.exec(line.trim());
		if (!match) continue;
		const [, device, totalKb, mount] = match;
		if (/^\/dev\/(loop|ram)/.test(device)) continue;
		if (!device.startsWith("/") && mount !== "/") continue;
		const existing = byDevice.get(device);
		if (existing && existing.mount.length <= mount.length) continue;
		byDevice.set(device, { mount, totalBytes: Number(totalKb) * 1024 });
	}
	const disks = [...byDevice.values()].sort((a, b) =>
		a.mount === "/" ? -1 : b.mount === "/" ? 1 : a.mount.localeCompare(b.mount),
	);
	if (disks.length === 0) return null;
	return disks
		.slice(0, 6)
		.map(disk => {
			const fstype = fstypeByMount[disk.mount];
			return `${disk.mount} ${formatBytes(disk.totalBytes)}${fstype ? ` ${fstype}` : ""}`;
		})
		.join("; ");
}

/**
 * Parse `wmic logicaldisk get ... /format:list` output into a one-line
 * per-drive disk summary (size + filesystem, no volatile free space).
 * Exported for tests.
 */
export function parseWmicDisks(output: string): string | null {
	const drives = parseWmicList(output).filter(record => record.Caption && Number(record.Size) > 0);
	if (drives.length === 0) return null;
	return drives
		.slice(0, 6)
		.map(record => {
			const fstype = record.FileSystem?.trim();
			return `${record.Caption} ${formatBytes(Number(record.Size))}${fstype ? ` ${fstype}` : ""}`;
		})
		.join("; ");
}

/**
 * Disk inventory for the workstation block: mount, total size, and filesystem
 * type (a btrfs root implies CoW and transparent compression, which matters
 * for I/O-sensitive work). The filesystem type comes from /proc/self/mounts
 * on Linux; other platforms omit it rather than guess.
 */
async function getDiskInfo(): Promise<string | null> {
	if (process.platform === "win32") {
		const output = await runHostProbe(["wmic", "logicaldisk", "get", "Caption,FileSystem,Size", "/format:list"]);
		return output ? parseWmicDisks(output) : null;
	}
	const output = await runHostProbe(["df", "-kP"], { lenientExit: true });
	if (!output) return null;
	const fstypeByMount: Record<string, string> = {};
	if (process.platform === "linux") {
		try {
			for (const line of (await Bun.file("/proc/self/mounts").text()).split("\n")) {
				const [, mount, fstype] = line.split(" ");
				// Octal-escaped spaces in mount points per fstab(5).
				if (mount && fstype) fstypeByMount[mount.replace(/\\040/g, " ")] = fstype;
			}
		} catch (error) {
			logger.debug("Could not read /proc/self/mounts", { error: String(error) });
		}
	}
	return parseDfDisks(output, fstypeByMount);
}

function getTerminalName(): string | undefined {
	const termProgram = Bun.env.TERM_PROGRAM;
	const termProgramVersion = Bun.env.TERM_PROGRAM_VERSION;
	if (termProgram) {
		return termProgramVersion ? `${termProgram} ${termProgramVersion}` : termProgram;
	}

	if (Bun.env.WT_SESSION) return "Windows Terminal";

	const term = firstNonEmpty(Bun.env.TERM, Bun.env.COLORTERM, Bun.env.TERMINAL_EMULATOR);
	return term ?? undefined;
}

/** Read a small sysfs/procfs attribute; a missing attribute is normal and yields null. */
async function readSysFile(filePath: string): Promise<string | null> {
	try {
		return (await Bun.file(filePath).text()).trim() || null;
	} catch {
		return null;
	}
}

/** CPU facts gathered from /proc and /sys, kept as data so the summary is testable. */
export interface CpuTopologyData {
	model: string | null;
	/** AMD gets its L3 domains labelled as CCDs. */
	isAmd: boolean;
	threadCount: number;
	coreCount: number;
	/** `thread_siblings_list` contents, one per logical CPU (e.g. "0,16" or "0-1"). */
	siblingLists: string[];
	/** Highest cpufreq `cpuinfo_max_freq` across CPUs, in kHz (0 = unknown). */
	maxFreqKhz: number;
	/** Total across distinct L2 cache domains, in KB. */
	l2TotalKb: number;
	/** Distinct L3 cache domains in CPU order. */
	l3Domains: Array<{ sizeKb: number; cpuList: string }>;
	/** Intel hybrid core lists (/sys/devices/cpu_core/cpus, cpu_atom/cpus) when exposed. */
	pCores?: string;
	eCores?: string;
}

/**
 * Render gathered CPU topology into one line, e.g.
 * `AMD Ryzen 9 7950X3D 16-Core Processor — 16c/32t, SMT siblings t,t+16,
 * boost 5.76GHz, L2 16.0MB, L3 96.0MB+32.0MB (CCD0 0-7,16-23; CCD1 8-15,24-31)`.
 * Every part is optional; unknown facts are omitted rather than guessed.
 * Exported for tests.
 */
export function summarizeCpuTopology(data: CpuTopologyData): string | null {
	if (!data.model) return null;
	const parts: string[] = [];
	if (data.coreCount > 0 && data.threadCount > 0) parts.push(`${data.coreCount}c/${data.threadCount}t`);
	if (data.pCores && data.eCores) parts.push(`P-cores ${data.pCores}, E-cores ${data.eCores}`);
	// SMT layout: name the sibling stride when it is uniform across all cores.
	const strides = new Set<number>();
	let hasSmt = false;
	let uniform = true;
	for (const list of new Set(data.siblingLists)) {
		const ids = list
			.split(/[,-]/)
			.map(Number)
			.filter(id => Number.isFinite(id));
		if (ids.length === 2) {
			hasSmt = true;
			strides.add(ids[1] - ids[0]);
		} else if (ids.length > 2) {
			hasSmt = true;
			uniform = false;
		}
	}
	if (hasSmt) {
		parts.push(uniform && strides.size === 1 ? `SMT siblings t,t+${[...strides][0]}` : "SMT");
	}
	if (data.maxFreqKhz > 0) parts.push(`boost ${(data.maxFreqKhz / 1e6).toFixed(2)}GHz`);
	if (data.l2TotalKb > 0) parts.push(`L2 ${formatBytes(data.l2TotalKb * 1024)}`);
	if (data.l3Domains.length === 1) {
		parts.push(`L3 ${formatBytes(data.l3Domains[0].sizeKb * 1024)}`);
	} else if (data.l3Domains.length > 1) {
		const sizes = data.l3Domains.map(domain => formatBytes(domain.sizeKb * 1024)).join("+");
		const label = data.isAmd ? "CCD" : "L3 domain";
		const detail = data.l3Domains.map((domain, index) => `${label}${index} ${domain.cpuList}`).join("; ");
		parts.push(`L3 ${sizes} (${detail})`);
	}
	return parts.length > 0 ? `${data.model} — ${parts.join(", ")}` : data.model;
}

/**
 * Parse `wmic cpu get ... /format:list` output into the same one-line shape.
 * Cache sizes are reported in KB by WMI. Exported for tests.
 */
export function parseWmicCpu(output: string): string | null {
	const cpu = parseWmicList(output)[0];
	const model = cpu?.Name?.trim();
	if (!model) return null;
	const parts: string[] = [];
	const cores = Number(cpu.NumberOfCores);
	const threads = Number(cpu.NumberOfLogicalProcessors);
	if (cores > 0 && threads > 0) parts.push(`${cores}c/${threads}t`);
	const maxMhz = Number(cpu.MaxClockSpeed);
	if (maxMhz > 0) parts.push(`boost ${(maxMhz / 1000).toFixed(2)}GHz`);
	const l2Kb = Number(cpu.L2CacheSize);
	if (l2Kb > 0) parts.push(`L2 ${formatBytes(l2Kb * 1024)}`);
	const l3Kb = Number(cpu.L3CacheSize);
	if (l3Kb > 0) parts.push(`L3 ${formatBytes(l3Kb * 1024)}`);
	return parts.length > 0 ? `${model} — ${parts.join(", ")}` : model;
}

async function getCpuInfo(): Promise<string | null> {
	if (process.platform === "win32") {
		const output = await runHostProbe([
			"wmic",
			"cpu",
			"get",
			"Name,MaxClockSpeed,NumberOfCores,NumberOfLogicalProcessors,L2CacheSize,L3CacheSize",
			"/format:list",
		]);
		return output ? parseWmicCpu(output) : null;
	}
	if (process.platform !== "linux") return null;
	try {
		const cpuInfoText = await Bun.file("/proc/cpuinfo").text();
		const cpuRoot = "/sys/devices/system/cpu";
		const cpuDirs = (await fs.readdir(cpuRoot))
			.filter(name => /^cpu\d+$/.test(name))
			.sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
		const siblingLists: string[] = [];
		const coreIds = new Set<string>();
		let maxFreqKhz = 0;
		const l2Domains = new Map<string, number>();
		const l3Domains = new Map<string, { sizeKb: number; cpuList: string }>();
		for (const cpu of cpuDirs) {
			const base = `${cpuRoot}/${cpu}`;
			const siblings = await readSysFile(`${base}/topology/thread_siblings_list`);
			if (siblings) siblingLists.push(siblings);
			const coreId = await readSysFile(`${base}/topology/core_id`);
			if (coreId !== null) {
				coreIds.add(`${await readSysFile(`${base}/topology/physical_package_id`)}:${coreId}`);
			}
			maxFreqKhz = Math.max(maxFreqKhz, Number(await readSysFile(`${base}/cpufreq/cpuinfo_max_freq`)) || 0);
			let cacheIndexes: string[] = [];
			try {
				cacheIndexes = (await fs.readdir(`${base}/cache`)).filter(name => /^index\d+$/.test(name));
			} catch {
				// No cache topology exposed (VMs, some ARM parts).
			}
			for (const index of cacheIndexes) {
				const level = await readSysFile(`${base}/cache/${index}/level`);
				if (level !== "2" && level !== "3") continue;
				const sizeText = await readSysFile(`${base}/cache/${index}/size`);
				const sizeMatch = sizeText ? /^(\d+)([KM])?$/.exec(sizeText) : null;
				if (!sizeMatch) continue;
				const sizeKb = Number(sizeMatch[1]) * (sizeMatch[2] === "M" ? 1024 : 1);
				const shared = (await readSysFile(`${base}/cache/${index}/shared_cpu_list`)) ?? cpu;
				if (level === "2" && !l2Domains.has(shared)) l2Domains.set(shared, sizeKb);
				if (level === "3" && !l3Domains.has(shared)) l3Domains.set(shared, { sizeKb, cpuList: shared });
			}
		}
		return summarizeCpuTopology({
			model: /^model name\s*:\s*(.+)$/m.exec(cpuInfoText)?.[1]?.trim() ?? null,
			isAmd: /^vendor_id\s*:\s*AuthenticAMD/m.test(cpuInfoText),
			threadCount: cpuDirs.length,
			coreCount: coreIds.size,
			siblingLists,
			maxFreqKhz,
			l2TotalKb: [...l2Domains.values()].reduce((sum, sizeKb) => sum + sizeKb, 0),
			l3Domains: [...l3Domains.values()],
			pCores: (await readSysFile("/sys/devices/cpu_core/cpus")) ?? undefined,
			eCores: (await readSysFile("/sys/devices/cpu_atom/cpus")) ?? undefined,
		});
	} catch (error) {
		logger.debug("Could not gather CPU topology", { error: String(error) });
		return null;
	}
}

/**
 * Match `lspci` network devices to their interface names, e.g.
 * `Realtek ... RTL8126 5GbE Controller (enp7s0); Qualcomm ... WCN785x Wi-Fi 7 (wlp8s0)`.
 * Exported for tests.
 */
export function summarizeNetworkDevices(
	lspciText: string,
	interfaces: Array<{ name: string; pciAddr: string }>,
): string | null {
	const entries: string[] = [];
	for (const line of lspciText.split("\n")) {
		const match = /^(\S+)\s+(?:Ethernet|Network) controller:\s*(.+?)(?:\s*\(rev [^)]*\))?$/.exec(line.trim());
		if (!match) continue;
		const [, addr, desc] = match;
		const iface = interfaces.find(entry => entry.pciAddr.endsWith(addr));
		entries.push(iface ? `${desc} (${iface.name})` : desc);
	}
	return entries.length > 0 ? entries.slice(0, 6).join("; ") : null;
}

async function getNetworkInfo(lspciText: string | null): Promise<string | null> {
	if (process.platform === "win32") {
		const output = await runHostProbe([
			"wmic",
			"nic",
			"where",
			"PhysicalAdapter=true",
			"get",
			"Name,NetConnectionID",
			"/format:list",
		]);
		if (!output) return null;
		const nics = parseWmicList(output).filter(nic => nic.Name);
		if (nics.length === 0) return null;
		return nics
			.slice(0, 6)
			.map(nic => (nic.NetConnectionID ? `${nic.Name} (${nic.NetConnectionID})` : nic.Name))
			.join("; ");
	}
	if (process.platform !== "linux" || !lspciText) return null;
	const interfaces: Array<{ name: string; pciAddr: string }> = [];
	try {
		for (const name of await fs.readdir("/sys/class/net")) {
			try {
				// Virtual interfaces (bridges, veth, tailscale) have no backing
				// device; realpath throws and they are skipped.
				const devicePath = await fs.realpath(`/sys/class/net/${name}/device`);
				if (devicePath.includes("/virtual/")) continue;
				interfaces.push({ name, pciAddr: path.basename(devicePath) });
			} catch {
				// Not a physical device.
			}
		}
	} catch (error) {
		logger.debug("Could not enumerate network interfaces", { error: String(error) });
	}
	return summarizeNetworkDevices(lspciText, interfaces);
}

/** Firmware placeholder strings that must not surface as hardware identity. */
const DMI_PLACEHOLDER =
	/^(default string|to be filled.*|none|not applicable|n\/a|unknown|system (product name|version|manufacturer)|oem.*)$/i;

async function getMotherboardInfo(): Promise<string | null> {
	if (process.platform === "win32") {
		const output = await runHostProbe(["wmic", "baseboard", "get", "Manufacturer,Product,Version", "/format:list"]);
		const board = output ? parseWmicList(output)[0] : undefined;
		if (!board) return null;
		const fields = [board.Manufacturer, board.Product, board.Version].filter(
			(value): value is string => !!value && !DMI_PLACEHOLDER.test(value.trim()),
		);
		return fields.length > 0 ? fields.join(" ") : null;
	}
	if (process.platform !== "linux") return null;
	const fields: string[] = [];
	for (const attr of ["board_vendor", "board_name", "board_version"]) {
		const value = await readSysFile(`/sys/devices/virtual/dmi/id/${attr}`);
		if (value && !DMI_PLACEHOLDER.test(value)) fields.push(value);
	}
	return fields.length > 0 ? fields.join(" ") : null;
}

/**
 * PSU identity/rating. Only power supplies with a software interface (laptop
 * adapters, UPSes, PMBus/USB-monitored units) are enumerable; a plain desktop
 * PSU exposes nothing, so this field is usually absent.
 */
async function getPsuInfo(): Promise<string | null> {
	if (process.platform !== "linux") return null;
	try {
		const entries: string[] = [];
		for (const name of await fs.readdir("/sys/class/power_supply")) {
			const base = `/sys/class/power_supply/${name}`;
			const type = await readSysFile(`${base}/type`);
			if (type !== "Mains" && type !== "UPS") continue;
			const model = [await readSysFile(`${base}/manufacturer`), await readSysFile(`${base}/model_name`)]
				.filter(Boolean)
				.join(" ");
			const microWatts = Number(await readSysFile(`${base}/input_power_limit`)) || 0;
			const watts = microWatts > 0 ? ` ${Math.round(microWatts / 1e6)}W` : "";
			entries.push(`${model || name}${watts}`.trim());
		}
		return entries.length > 0 ? entries.join("; ") : null;
	} catch (error) {
		if (!isEnoent(error)) {
			logger.debug("Could not enumerate power supplies", { error: String(error) });
		}
		return null;
	}
}

/**
 * One consolidated probe cache (~/.omp/hardware_cache.json). Every field is
 * independent: a present key is the last successful probe; an absent key is
 * re-probed in the background on the next session. Failed probes are never
 * persisted, so a missing command or bad output only costs a retry.
 */
interface HardwareCache {
	cpu?: string;
	gpu?: string;
	ram?: string;
	network?: string;
	motherboard?: string;
	psu?: string;
	disks?: string;
}
const HARDWARE_FIELDS = ["cpu", "gpu", "ram", "network", "motherboard", "psu", "disks"] as const;
type HardwareField = (typeof HARDWARE_FIELDS)[number];

/** Deduplicates concurrent background refreshes per cache path (profiles have distinct caches). */
const hardwareRefreshInFlight = new Map<string, Promise<boolean>>();

/** A cache snapshot plus the completion signal of the refresh it scheduled. */
interface HardwareLoad {
	cache: HardwareCache;
	/**
	 * Settles when the background probe finishes; true when it added fields.
	 * Already-settled `false` when nothing was missing. Held per load result —
	 * not global state — so a caller that registers after a fast probe already
	 * finished still observes the outcome.
	 */
	refreshed: Promise<boolean>;
}

/**
 * Load cached hardware facts without ever blocking on probes: the session
 * renders whatever fields are present, and missing fields kick off one
 * deduplicated background refresh. Callers may await `refreshed` to learn
 * when a prompt rebuild would pick up new fields; results persist in
 * hardware_cache.json for later sessions either way.
 */
async function loadHardwareInfo(): Promise<HardwareLoad> {
	const cachePath = getHardwareCachePath();
	const cache: HardwareCache = {};
	try {
		const content = await Bun.file(cachePath).json();
		if (content && typeof content === "object") {
			for (const field of HARDWARE_FIELDS) {
				const value = (content as Record<string, unknown>)[field];
				if (typeof value === "string" && value.length > 0) cache[field] = value;
			}
		}
	} catch (error) {
		if (!isEnoent(error)) {
			logger.debug("Could not read hardware cache", { path: cachePath, error: String(error) });
		}
	}
	const missing = HARDWARE_FIELDS.filter(field => cache[field] === undefined);
	if (missing.length === 0) return { cache, refreshed: Promise.resolve(false) };
	// Capture the resolved cache path in the key and the closure: the refresh
	// outlives this call and must not re-resolve against (or block refreshes
	// for) a different profile activated meanwhile.
	let refresh = hardwareRefreshInFlight.get(cachePath);
	if (!refresh) {
		refresh = refreshHardwareCache(cachePath, cache, missing)
			.catch(error => {
				logger.warn("Background hardware probe failed", { error: String(error) });
				return false;
			})
			.finally(() => {
				hardwareRefreshInFlight.delete(cachePath);
			});
		hardwareRefreshInFlight.set(cachePath, refresh);
	}
	return { cache, refreshed: refresh };
}

async function refreshHardwareCache(
	cachePath: string,
	existing: HardwareCache,
	missing: HardwareField[],
): Promise<boolean> {
	// GPU and network identity both come from lspci on Linux; probe it once.
	const needsLspci = process.platform === "linux" && (missing.includes("gpu") || missing.includes("network"));
	const lspciText = needsLspci ? await runHostProbe(["lspci"]) : null;
	const probes: Record<HardwareField, () => Promise<string | null>> = {
		cpu: getCpuInfo,
		gpu: () => getGpuModel(lspciText),
		ram: getRamInfo,
		network: () => getNetworkInfo(lspciText),
		motherboard: getMotherboardInfo,
		psu: getPsuInfo,
		disks: getDiskInfo,
	};
	const updated: HardwareCache = { ...existing };
	let changed = false;
	await Promise.all(
		missing.map(async field => {
			try {
				const value = await probes[field]();
				if (value) {
					updated[field] = value;
					changed = true;
				} else {
					logger.debug("Hardware probe found nothing; field omitted", { field });
				}
			} catch (error) {
				logger.warn("Hardware probe failed; field omitted", { field, error: String(error) });
			}
		}),
	);
	try {
		await Bun.write(cachePath, JSON.stringify(updated, null, "\t"));
	} catch (error) {
		logger.debug("Could not write hardware cache", { path: cachePath, error: String(error) });
	}
	// Retire the per-part caches this file replaces.
	for (const legacy of ["gpu_cache.json", "ram_cache.json"]) {
		void fs.unlink(path.join(path.dirname(cachePath), legacy)).catch(() => undefined);
	}
	return changed;
}

async function getCpuModel(): Promise<string | undefined> {
	if (process.platform !== "linux") return os.cpus()[0]?.model;
	try {
		const cpuInfo = await Bun.file("/proc/cpuinfo").text();
		const match = /^model name\s*:\s*(.+)$/m.exec(cpuInfo);
		return match?.[1]?.trim() || undefined;
	} catch (error) {
		if (!isEnoent(error)) {
			logger.debug("Could not read Linux CPU model", { error: String(error) });
		}
		return undefined;
	}
}

/**
 * Resolve a human distro identity from os-release(5) content: `PRETTY_NAME`
 * (already includes the version), else `NAME` + `VERSION_ID`, else null.
 * Exported for tests.
 */
export function parseOsRelease(text: string): string | null {
	const fields: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const match = /^([A-Z_]+)=("?)(.*)\2\s*$/.exec(line.trim());
		if (match) fields[match[1]] = match[3];
	}
	if (fields.PRETTY_NAME) return fields.PRETTY_NAME;
	if (fields.NAME) return fields.VERSION_ID ? `${fields.NAME} ${fields.VERSION_ID}` : fields.NAME;
	return null;
}

/** Linux distro identity for the Distro field; non-Linux keeps the os.type() fallback. */
async function getDistro(): Promise<string | undefined> {
	if (process.platform !== "linux") return undefined;
	try {
		return parseOsRelease(await Bun.file("/etc/os-release").text()) ?? undefined;
	} catch (error) {
		if (!isEnoent(error)) {
			logger.debug("Could not read /etc/os-release", { error: String(error) });
		}
		return undefined;
	}
}

/**
 * Kernel identity for the workstation block. Prefers the uname build string
 * from `os.version()`, but Bun on macOS 15+ (Darwin 24/25) returns the literal
 * `"unknown"` when `uv_os_uname()`'s `version` field is empty — which surfaces
 * `Kernel: unknown` in the system prompt and makes the model misidentify the
 * host as Windows (#4141). Fall back to `<type> <release>` (uname -s + -r) so
 * macOS is always tagged as `Darwin <release>` and Linux keeps its build info.
 */
function getKernelIdentity(): string {
	const version = os.version()?.trim();
	if (version && version.toLowerCase() !== "unknown") return version;
	return `${os.type()} ${os.release()}`.trim();
}

function getEnvironmentInfo(
	cpuModel: string | undefined,
	distro: string | undefined,
	hardware: HardwareCache,
): Array<{ label: string; value: string }> {
	const entries: Array<{ label: string; value: string | undefined }> = [
		{ label: "OS", value: `${os.platform()} ${os.release()}` },
		{ label: "Distro", value: distro ?? os.type() },
		{ label: "Kernel", value: getKernelIdentity() },
		{ label: "Arch", value: os.arch() },
		{ label: "CPU", value: hardware.cpu ?? cpuModel },
		{ label: "RAM", value: hardware.ram },
		{ label: "GPU", value: hardware.gpu },
		{ label: "Motherboard", value: hardware.motherboard },
		{ label: "PSU", value: hardware.psu },
		{ label: "Network", value: hardware.network },
		{ label: "Disks", value: hardware.disks },
		{ label: "Terminal", value: getTerminalName() },
	];
	return entries.filter((e): e is { label: string; value: string } => !!e.value);
}

/** Discover TITLE_SYSTEM.md file for automatic session-title prompt overrides */
export function discoverTitleSystemPromptFile(cwd?: string): string | undefined {
	const projectPath = findConfigFile("TITLE_SYSTEM.md", { user: false, cwd });
	if (projectPath) {
		return projectPath;
	}
	const globalPath = findConfigFile("TITLE_SYSTEM.md", { user: true, cwd });
	if (globalPath) {
		return globalPath;
	}
	return undefined;
}

/** Resolve input as file path or literal string */
export async function resolvePromptInput(input: string | undefined, description: string): Promise<string | undefined> {
	if (!input) {
		return undefined;
	} else if (input.includes("\n")) {
		return input;
	}

	try {
		return await Bun.file(input).text();
	} catch (error) {
		if (!hasFsCode(error, "ENAMETOOLONG") && !isEnoent(error)) {
			logger.warn(`Could not read ${description} file`, { path: input, error: String(error) });
		}
		return input;
	}
}

export interface LoadContextFilesOptions {
	/** Working directory to start walking up from. Default: getProjectDir() */
	cwd?: string;
	/** Disabled extension IDs to honor instead of the process-global settings. */
	disabledExtensions?: string[];
}

/**
 * Deduplicate context files by paragraph containment.
 *
 * Files are sorted by depth descending (farther from cwd first) so that a
 * file is omitted only when a more-authoritative (closer-to-cwd) file
 * contains its entire normalized paragraph sequence as a contiguous run.
 * This makes the function self-contained — it does not rely on callers
 * pre-sorting the array, which matters because some callers concatenate
 * independently sorted workspace roots where array position does not reflect
 * authority. Files whose paragraphs are merely paraphrased or interleaved are
 * kept — containment is exact after normalization, not fuzzy.
 *
 * @internal Exported for testing.
 */
export function dedupeContainedContextFiles(
	contextFiles: Array<{ path: string; content: string; depth?: number }>,
): Array<{ path: string; content: string; depth?: number }> {
	// Sort by depth descending: higher depth (farther from cwd, less
	// authoritative) first, lower depth (closer to cwd, more authoritative)
	// last. Stable sort preserves caller order among equal-depth files.
	const sorted = [...contextFiles].sort((a, b) => {
		const depthA = a.depth ?? Number.POSITIVE_INFINITY;
		const depthB = b.depth ?? Number.POSITIVE_INFINITY;
		return depthB - depthA;
	});
	const blocks = sorted.map(file => splitComparablePromptBlocks(file.content));
	return sorted.filter(
		(_file, index) =>
			!blocks.some(
				(candidateBlocks, candidateIndex) =>
					candidateIndex > index && promptBlocksContain(candidateBlocks, blocks[index]),
			),
	);
}

/**
 * Load all project context files using the capability API.
 * Returns {path, content, depth} entries for all discovered context files.
 * Files are sorted by depth (descending) so files closer to cwd appear last/more prominent.
 */
export async function loadProjectContextFiles(
	options: LoadContextFilesOptions = {},
): Promise<Array<{ path: string; content: string; depth?: number }>> {
	const resolvedCwd = options.cwd ?? getProjectDir();

	const result = await loadCapability(contextFileCapability.id, {
		cwd: resolvedCwd,
		disabledExtensions: options.disabledExtensions,
	});

	// Materialize ContextFile items, expanding any `@path/to/file` includes
	// in their content. The expansion uses the file's own directory as the
	// resolution base so relative imports work the same way Claude Code,
	// Goose, and other tools document.
	const files = await Promise.all(
		result.items.map(async item => {
			const contextFile = item as ContextFile;
			return {
				path: contextFile.path,
				content: await expandAtImports(contextFile.content, contextFile.path),
				depth: contextFile.depth,
			};
		}),
	);

	// Sort by depth (descending): higher depth (farther from cwd) comes first,
	// so files closer to cwd appear later and are more prominent
	files.sort((a, b) => {
		const depthA = a.depth ?? -1;
		const depthB = b.depth ?? -1;
		return depthB - depthA;
	});

	return dedupeContainedContextFiles(files);
}

/**
 * Load the effective system prompt customization from SYSTEM.md.
 * Project-level SYSTEM.md overrides user-level SYSTEM.md.
 */
export async function loadSystemPromptFiles(options: LoadContextFilesOptions = {}): Promise<string | null> {
	const resolvedCwd = options.cwd ?? getProjectDir();

	const result = await loadCapability<SystemPromptFile>(systemPromptCapability.id, { cwd: resolvedCwd });

	if (result.items.length === 0) return null;

	const projectLevel = result.items.find(item => item.level === "project");
	if (projectLevel) {
		return projectLevel.content;
	}

	const userLevel = result.items.find(item => item.level === "user");
	return userLevel?.content ?? null;
}

export const DEFAULT_SYSTEM_PROMPT_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;

export interface SystemPromptToolMetadata {
	label: string;
	description: string;
	/** Tool name the model sees on the provider wire. Defaults to the internal tool name. */
	wireName?: string;
	/** Tool parameters schema (Zod or JSON Schema), fed to the verbose inventory renderer. */
	parameters?: TSchema;
	/** Illustrative examples rendered into the verbose inventory. */
	examples?: readonly ToolExample[];
}

export type SystemPromptToolMetadataProjection =
	| {
			mode: "compact";
			toolNames: readonly string[];
			overrides?: Partial<Record<string, Partial<SystemPromptToolMetadata>>>;
	  }
	| {
			mode: "full";
			overrides?: Partial<Record<string, Partial<SystemPromptToolMetadata>>>;
	  };

export function buildSystemPromptToolMetadata(
	tools: Map<string, AgentTool>,
	overrides: Partial<Record<string, Partial<SystemPromptToolMetadata>>> = {},
): Map<string, SystemPromptToolMetadata> {
	return projectSystemPromptToolMetadata(tools, { mode: "full", overrides });
}

/** Builds a mode-specific metadata snapshot for internal prompt assembly. */
export function projectSystemPromptToolMetadata(
	tools: Map<string, AgentTool>,
	projection: SystemPromptToolMetadataProjection,
): Map<string, SystemPromptToolMetadata> {
	const metadata = new Map<string, SystemPromptToolMetadata>();
	const addTool = (name: string, tool: AgentTool): void => {
		const override = projection.overrides?.[name];
		const labelValue = override?.label ?? tool.label;
		const wireNameValue = override?.wireName ?? tool.customWireName;
		const label = typeof labelValue === "string" ? labelValue : "";
		const wireName = typeof wireNameValue === "string" ? wireNameValue : undefined;

		if (projection.mode === "compact") {
			metadata.set(name, { label, description: "", wireName });
			return;
		}

		const descriptionValue = override?.description ?? tool.description;
		metadata.set(name, {
			label,
			description: typeof descriptionValue === "string" ? descriptionValue : "",
			parameters: tool.parameters,
			examples: tool.examples,
			wireName,
		});
	};

	if (projection.mode === "compact") {
		for (const name of projection.toolNames) {
			const tool = tools.get(name);
			if (tool) addTool(name, tool);
		}
	} else {
		for (const [name, tool] of tools) addTool(name, tool);
	}

	return metadata;
}

export interface BuildSystemPromptOptions {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Already-loaded custom system prompt text; bypasses path resolution. */
	resolvedCustomPrompt?: string;
	/** Tools to include in prompt. */
	tools?: Map<string, SystemPromptToolMetadata>;
	/** Tool names to include in prompt. */
	toolNames?: string[];
	/**
	 * Names actually exposed as provider-callable tools. Defaults to `toolNames`.
	 * Code Mode passes its direct keep-set so the rendered tool inventory matches
	 * the wire surface while capability and safety gates still see every
	 * bridge-reachable tool in `toolNames`.
	 */
	directToolNames?: readonly string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Already-loaded append prompt text; bypasses path resolution. */
	resolvedAppendSystemPrompt?: string;
	/** Inline full tool descriptors in the system prompt. Default: false */
	inlineToolDescriptors?: boolean;
	/**
	 * Whether provider-native tool calling is active (no owned/in-band syntax).
	 * When true and `inlineToolDescriptors` is false, the inventory renders as a
	 * compact tool-name list; otherwise it renders the full Harmony-style
	 * `namespace functions { … }` catalog. Default: true
	 */
	nativeTools?: boolean;
	/** Skills settings for discovery. */
	skillsSettings?: SkillsSettings;
	/** Working directory. Default: getProjectDir() */
	cwd?: string;
	/** Additional workspace directories beyond cwd (multi-root), absolute. Injected into the project prompt. */
	additionalWorkspaceRoots?: string[];
	/** Pre-loaded context files (skips discovery if provided). */
	contextFiles?: Array<{ path: string; content: string; depth?: number }>;
	/** Skills provided directly to system prompt construction. */
	skills?: readonly Skill[];
	/** Pre-loaded rulebook rules (descriptions, excluding TTSR and always-apply). */
	rules?: Array<{ name: string; description?: string; path: string; globs?: string[] }>;
	/** Intent field name injected into every tool schema. If set, explains the field in the prompt. */
	intentField?: string;
	/** Encourage the agent to delegate via tasks unless changes are trivial. */
	eagerTasks?: boolean;
	/** When true, the Eager Tasks section uses the hard MUST/ONLY wording (`task.eager: always`) rather than the softer `preferred` nudge. */
	eagerTasksAlways?: boolean;
	/** Whether `task.batch` is enabled; selects the centralized delegation guidance's call shape. */
	taskBatch?: boolean;
	/** Effective task concurrency limit displayed in centralized delegation guidance. Zero means unlimited. */
	taskMaxConcurrency?: number;
	/** Whether IRC-backed parallel coordination can be included in delegation policy. */
	taskIrcEnabled?: boolean;
	/** Whether the read-only `scout` subagent is spawnable (not disabled, allowed by spawn policy). Defaults to true. */
	scoutAvailable?: boolean;

	/** Rules with alwaysApply=true — their full content is injected into the prompt. */
	alwaysApplyRules?: AlwaysApplyRule[];
	/** Whether secret obfuscation is active. When true, explains the redaction format in the prompt. */
	secretsEnabled?: boolean;
	/** Pre-loaded workspace tree (skips discovery if provided). May be a Promise to allow early kick-off. */
	workspaceTree?: WorkspaceTree | Promise<WorkspaceTree>;
	/** Whether the local memory://root summary is active. */
	memoryRootEnabled?: boolean;
	/** Whether the read-only security:// resource namespace is active. */
	securityEnabled?: boolean;
	/** Active model identifier (e.g. "anthropic/claude-opus-4") used by prompt policy and optionally surfaced. */
	model?: string;
	/** Whether to surface `model` in the workstation block. Model-specific prompt policy still uses it. Default: true. */
	includeModelInPrompt?: boolean;
	/** Personality preset rendered into the default system prompt. "none" omits the block. Default: "default" */
	personality?: Personality;
	/** Whether to include the workspace directory tree in the system prompt. Default: false */
	includeWorkspaceTree?: boolean;
	/** Whether Mermaid fenced blocks render as terminal ASCII diagrams. Default: true */
	renderMermaid?: boolean;
	/** Pre-resolved nested active repo context. Undefined resolves from cwd. */
	activeRepoContext?: ActiveRepoContext | null;
	/** Tools mounted under `xd://`; renders the protocol section when non-empty. `dynamic` marks external devices whose summary is third-party metadata. */
	xdevTools?: Array<{ name: string; summary: string; dynamic?: boolean }>;
	/** Full docs + JSON schema for every `xd://`-mounted tool, inlined into the protocol section so no discovery `read` is needed. */
	xdevDocs?: string;
	/** Whether Auto-QA grievance reporting is enabled; renders the `xd://report_issue` note. */
	autoQaEnabled?: boolean;
}

/** Result of building provider-facing system prompt messages. */
export interface BuildSystemPromptResult {
	/** Ordered system prompt blocks. Providers should preserve entries as distinct messages/blocks. */
	systemPrompt: string[];
	/**
	 * Names of `xd://` devices whose catalog/protocol section this prompt renders.
	 * Empty/undefined when no catalog was emitted (no mounted devices, or a custom
	 * prompt template that omits the section). Lets the session fold these devices
	 * into its announced-mount baseline so a same-turn mount notice does not re-list
	 * a catalog the prompt already carries (issue #7139).
	 */
	xdevCatalogNames?: readonly string[];
	/**
	 * Settles when the background hardware probe scheduled by this build (if
	 * any) finishes; true when it added fields, i.e. a prompt rebuild would
	 * render a more complete workstation block. Already-settled when the
	 * hardware cache was complete. Kept per-result so a caller registering
	 * after the probe finished still observes the outcome.
	 */
	hardwareRefreshed?: Promise<boolean>;
}

/** Build the system prompt with tools, guidelines, and context */
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<BuildSystemPromptResult> {
	if ($env.NULL_PROMPT === "true") {
		return { systemPrompt: [] };
	}

	const {
		customPrompt,
		resolvedCustomPrompt: providedResolvedCustomPrompt,
		tools,
		appendSystemPrompt,
		inlineToolDescriptors: providedInlineToolDescriptors,
		resolvedAppendSystemPrompt: providedResolvedAppendPrompt,
		nativeTools = true,
		skillsSettings,
		toolNames: providedToolNames,
		directToolNames,
		cwd,
		additionalWorkspaceRoots = [],
		contextFiles: providedContextFiles,
		skills: providedSkills,
		rules,
		alwaysApplyRules,
		intentField,
		eagerTasks = false,
		eagerTasksAlways = false,
		taskBatch = true,
		taskMaxConcurrency = 0,
		taskIrcEnabled = false,
		secretsEnabled = false,
		workspaceTree: providedWorkspaceTree,
		scoutAvailable = true,
		memoryRootEnabled = false,
		securityEnabled = false,
		model,
		includeModelInPrompt = true,
		personality = "default",
		includeWorkspaceTree = false,
		renderMermaid = true,
		xdevTools = [],
		xdevDocs = "",
		autoQaEnabled = false,
		activeRepoContext: providedActiveRepoContext,
	} = options;
	const inlineToolDescriptors = providedInlineToolDescriptors ?? false;
	const resolvedCwd = cwd ?? getProjectDir();

	const prepDefaults = {
		resolvedCustomPrompt: undefined as string | undefined,
		resolvedAppendPrompt: undefined as string | undefined,
		systemPromptCustomization: null as string | null,
		contextFiles: dedupeContainedContextFiles(providedContextFiles ?? []),
		skills: providedSkills ?? ([] as Skill[]),
		workspaceTree: {
			rootPath: resolvedCwd,
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		} satisfies WorkspaceTree,
		activeRepoContext: null as ActiveRepoContext | null,
		cpuModel: undefined as string | undefined,
		distro: undefined as string | undefined,
		hardware: { cache: {}, refreshed: Promise.resolve(false) } as HardwareLoad,
	};

	const { promise: deadline, resolve: fireDeadline } = Promise.withResolvers<"__timeout__">();
	const deadlineTimer = setTimeout(() => fireDeadline("__timeout__"), SYSTEM_PROMPT_PREP_TIMEOUT_MS);
	// Unref so a fast prep does not hold a one-shot CLI alive waiting for this timer.
	deadlineTimer.unref();
	const timedOut: string[] = [];
	const failed: Array<{ name: string; error: unknown }> = [];

	async function withDeadline<T>(name: string, work: Promise<T>, fallback: T): Promise<T> {
		const tagged = work
			.then(value => ({ kind: "ok" as const, value }))
			.catch(error => ({ kind: "err" as const, error }));
		const result = await Promise.race([tagged, deadline]);
		if (result === "__timeout__") {
			timedOut.push(name);
			// Let the work continue in the background so its caches still warm; just log on completion.
			void tagged.then(r => {
				if (r.kind === "err") {
					logger.warn("Background system prompt preparation step failed", { name, error: String(r.error) });
				} else {
					logger.debug("Background system prompt preparation step completed after timeout", { name });
				}
			});
			return fallback;
		}
		if (result.kind === "err") {
			failed.push({ name, error: result.error });
			return fallback;
		}
		return result.value;
	}

	// Caller-supplied `customPrompt` / `resolvedCustomPrompt` owns block 0; the
	// secondary capability-path `SYSTEM.md` walk-up MUST NOT silently augment it,
	// because that would defeat CLI precedence over project/user `SYSTEM.md`.
	const callerControlsCustomPrompt =
		(typeof providedResolvedCustomPrompt === "string" && providedResolvedCustomPrompt.length > 0) ||
		(typeof customPrompt === "string" && customPrompt.length > 0);
	const systemPromptCustomizationPromise: Promise<string | null> = callerControlsCustomPrompt
		? Promise.resolve(null)
		: logger.time("loadSystemPromptFiles", loadSystemPromptFiles, { cwd: resolvedCwd });
	const contextFilesPromise = (async () => {
		const primary = providedContextFiles
			? providedContextFiles
			: await logger.time("loadProjectContextFiles", loadProjectContextFiles, { cwd: resolvedCwd });
		// Also discover context files (AGENTS.md, rules, etc.) for each additional workspace root.
		const additionalRoots = additionalWorkspaceRoots.filter(d => path.resolve(d) !== path.resolve(resolvedCwd));
		if (additionalRoots.length === 0) return primary;
		const extra = await Promise.all(
			additionalRoots.map(root => loadProjectContextFiles({ cwd: root }).catch(() => [])),
		);
		return dedupeContainedContextFiles([...primary, ...extra.flat()]);
	})();
	const additionalRootsForTree = additionalWorkspaceRoots.filter(d => path.resolve(d) !== path.resolve(resolvedCwd));
	const workspaceTreePromise = (async () => {
		const primary =
			providedWorkspaceTree !== undefined
				? await Promise.resolve(providedWorkspaceTree)
				: includeWorkspaceTree
					? await logger.time("buildWorkspaceTree", () =>
							buildWorkspaceTree(resolvedCwd, { timeoutMs: SYSTEM_PROMPT_PREP_TIMEOUT_MS }),
						)
					: { rootPath: resolvedCwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] };
		if (additionalRootsForTree.length === 0 || !includeWorkspaceTree) return primary;
		const extraTrees = await Promise.all(
			additionalRootsForTree.map(root =>
				buildWorkspaceTree(root, { timeoutMs: SYSTEM_PROMPT_PREP_TIMEOUT_MS }).catch(() => ({
					rootPath: root,
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				})),
			),
		);
		return { ...primary, agentsMdFiles: [...primary.agentsMdFiles, ...extraTrees.flatMap(t => t.agentsMdFiles)] };
	})();
	const skillsPromise: Promise<readonly Skill[]> =
		providedSkills !== undefined
			? Promise.resolve(providedSkills)
			: skillsSettings?.enabled !== false
				? loadSkills({ ...skillsSettings, cwd: resolvedCwd }).then(result => result.skills)
				: Promise.resolve([]);
	const activeRepoContextPromise =
		providedActiveRepoContext !== undefined
			? Promise.resolve(providedActiveRepoContext)
			: logger.time("resolveActiveRepoContext", () => resolveActiveRepoContext(resolvedCwd));
	const cpuModelPromise = logger.time("getCpuModel", getCpuModel);
	const hardwarePromise = logger.time("loadHardwareInfo", loadHardwareInfo);
	// "none" (explicit off — and every subagent) omits the block and skips the file lookup.
	const bundledPersonality = personality === "none" ? "" : PERSONALITY_SPECS[personality].trim();
	const personalityPromise: Promise<string> =
		personality === "none"
			? Promise.resolve("")
			: logger
					.time("loadPersonalityOverride", loadPersonalityOverride)
					.then(override => override ?? bundledPersonality);
	const distroPromise = logger.time("getDistro", getDistro);

	const [
		resolvedCustomPrompt,
		resolvedAppendPrompt,
		systemPromptCustomization,
		contextFiles,
		skills,
		workspaceTree,
		activeRepoContext,
		cpuModel,
		personalityBlock,
		distro,
		hardware,
	] = await Promise.all([
		withDeadline(
			"customPrompt",
			providedResolvedCustomPrompt !== undefined
				? Promise.resolve(providedResolvedCustomPrompt)
				: resolvePromptInput(customPrompt, "system prompt"),
			prepDefaults.resolvedCustomPrompt,
		),
		withDeadline(
			"appendSystemPrompt",
			providedResolvedAppendPrompt !== undefined
				? Promise.resolve(providedResolvedAppendPrompt)
				: resolvePromptInput(appendSystemPrompt, "append system prompt"),
			prepDefaults.resolvedAppendPrompt,
		),
		withDeadline("loadSystemPromptFiles", systemPromptCustomizationPromise, prepDefaults.systemPromptCustomization),
		withDeadline("loadProjectContextFiles", contextFilesPromise, prepDefaults.contextFiles).then(
			dedupeContainedContextFiles,
		),
		withDeadline("loadSkills", skillsPromise, prepDefaults.skills),
		withDeadline("buildWorkspaceTree", workspaceTreePromise, prepDefaults.workspaceTree),
		withDeadline("resolveActiveRepoContext", activeRepoContextPromise, prepDefaults.activeRepoContext),
		withDeadline("getCpuModel", cpuModelPromise, prepDefaults.cpuModel),
		withDeadline("loadPersonalityOverride", personalityPromise, bundledPersonality),
		withDeadline("getDistro", distroPromise, prepDefaults.distro),
		withDeadline("loadHardwareInfo", hardwarePromise, prepDefaults.hardware),
	]);
	clearTimeout(deadlineTimer);
	const agentsMdFiles = Array.from(new Set(workspaceTree.agentsMdFiles)).sort().slice(0, AGENTS_MD_LIMIT);

	if (timedOut.length > 0) {
		logger.warn("System prompt preparation steps timed out; using minimal fallback for those steps", {
			cwd: resolvedCwd,
			timeoutMs: SYSTEM_PROMPT_PREP_TIMEOUT_MS,
			steps: timedOut,
		});
		process.stderr.write(
			`Warning: system prompt preparation steps timed out after ${SYSTEM_PROMPT_PREP_TIMEOUT_MS}ms (${timedOut.join(", ")}); using minimal fallback for those steps.\n`,
		);
	}
	if (failed.length > 0) {
		for (const { name, error } of failed) {
			logger.warn("System prompt preparation step failed; using minimal fallback", {
				cwd: resolvedCwd,
				step: name,
				error: String(error),
			});
		}
	}

	const promptCwd = normalizePromptPath(resolvedCwd);
	const activeRepoContextPrompt = renderActiveRepoContextPrompt(activeRepoContext);

	// Build tool metadata for system prompt rendering.
	// Priority: explicit list > tools map > conservative SDK fallback.
	let toolNames = providedToolNames;
	if (!toolNames) {
		toolNames = tools ? Array.from(tools.keys()) : [...DEFAULT_SYSTEM_PROMPT_TOOL_NAMES];
	}

	// List mode shows a compact tool-name list; it only applies when descriptors
	// stay in provider-native tool schemas AND native tool calling is active.
	// Otherwise render the full functions-namespace catalog in the system prompt.
	const toolListMode = !inlineToolDescriptors && nativeTools;
	// Build tool descriptions for system prompt rendering.
	const toolPromptNames = new Map<string, string>(toolNames.map(name => [name, tools?.get(name)?.wireName ?? name]));
	// xd://-mounted tools count as present for prompt gates ({{#has tools "lsp"}})
	// and resolve their own name as the reference — the xd:// section explains
	// the access path. The Tool Inventory list stays limited to real defs.
	for (const mounted of xdevTools) {
		if (!toolPromptNames.has(mounted.name)) toolPromptNames.set(mounted.name, mounted.name);
	}
	const toolRefs = Object.fromEntries(toolPromptNames.entries());
	const xdevToolNames = new Set(xdevTools.map(mounted => mounted.name));
	// A direct custom tool can share a name with a retained built-in device.
	// Presence in both toolNames and tools proves it still has a top-level definition.
	// Bridge-only Code Mode tools stay out of the callable inventory: the eval
	// description documents their `tool.*` access path instead.
	const directSet = directToolNames === undefined ? undefined : new Set(directToolNames);
	const directInventoryNames = directSet === undefined ? toolNames : toolNames.filter(name => directSet.has(name));
	const inventoryToolNames =
		xdevToolNames.size === 0
			? directInventoryNames
			: directInventoryNames.filter(name => tools?.has(name) || !xdevToolNames.has(name));
	const toolInfo = inventoryToolNames.map(name => ({
		name: toolPromptNames.get(name) ?? name,
		internalName: name,
		label: tools?.get(name)?.label ?? "",
	}));
	const toolInventory = toolListMode
		? ""
		: renderToolInventory(
				inventoryToolNames.map(name => {
					const meta = tools?.get(name);
					return {
						name: toolPromptNames.get(name) ?? name,
						description: meta?.description ?? "",
						parameters: meta?.parameters ?? ({ type: "object" } as TSchema),
						examples: meta?.examples,
					};
				}),
			);

	// Filter skills for the rendered system prompt:
	// - require the `read` tool so the model can actually fetch skill content;
	// - drop skills with frontmatter `hide: true` (still loadable via skill:// and /skill:<name>).
	const hasRead = toolNames.includes("read");
	const filteredSkills = hasRead ? skills.filter(skill => skill.hide !== true) : [];

	const effectiveSystemPromptCustomization = dedupePromptSource(systemPromptCustomization, [
		resolvedCustomPrompt,
		resolvedAppendPrompt,
	]);
	const contextPromptSources = contextFiles.map(file => file.content);
	const promptSources = [
		effectiveSystemPromptCustomization,
		resolvedCustomPrompt,
		resolvedAppendPrompt,
		...contextPromptSources,
	];
	const injectedAlwaysApplyRules = dedupeAlwaysApplyRules(alwaysApplyRules, promptSources);

	const environment = getEnvironmentInfo(cpuModel, distro, hardware.cache);
	// Point the agent at the probe cache so it can self-heal a stale hardware
	// line (e.g. after a GPU swap) by deleting the entry instead of trusting it.
	const homeDir = os.homedir();
	const rawCachePath = getHardwareCachePath();
	const hardwareCachePath = normalizePromptPath(
		rawCachePath.startsWith(homeDir) ? `~${rawCachePath.slice(homeDir.length)}` : rawCachePath,
	);
	const data = {
		systemPromptCustomization: effectiveSystemPromptCustomization,
		customPrompt: resolvedCustomPrompt,
		appendPrompt: resolvedAppendPrompt ?? "",
		tools: [...new Set([...toolNames, ...xdevTools.map(mounted => mounted.name)])],
		toolInfo,
		toolInventory,
		inlineToolDescriptors,
		toolListMode,
		toolRefs,
		environment,
		hardwareCachePath,
		contextFiles,
		agentsMdSearch: { files: agentsMdFiles },
		workspaceTree,
		skills: filteredSkills,
		rules: rules ?? [],
		alwaysApplyRules: injectedAlwaysApplyRules,
		cwd: promptCwd,
		additionalWorkspaceRoots: additionalWorkspaceRoots.filter(d => path.resolve(d) !== path.resolve(resolvedCwd)),
		model: includeModelInPrompt ? (model ?? "") : "",
		useCodexTaskPrompt: usesCodexTaskPrompt(model),
		personality: personalityBlock,
		intentTracing: !!intentField,
		intentField: intentField ?? "",
		eagerTasks,
		eagerTasksAlways,
		taskBatch,
		MAX_CONCURRENCY: normalizeConcurrencyLimit(taskMaxConcurrency),
		scoutAvailable,
		taskIrcEnabled,
		secretsEnabled,
		hasMemoryRoot: memoryRootEnabled,
		securityEnabled,
		hasObsidian: hasObsidian(),
		includeWorkspaceTree,
		renderMermaid,
		xdevTools,
		hasDynamicXdevTools: xdevTools.some(mounted => mounted.dynamic === true),
		xdevDocs,
		autoQaEnabled,
	};
	const rendered = prompt.render(resolvedCustomPrompt ? customSystemPromptTemplate : systemPromptTemplate, data);
	const systemPrompt = [rendered];
	if (toolNames.includes("computer")) {
		systemPrompt.push(computerSafetyPrompt.trim());
	}
	// Custom prompt templates already render context files and append text; the
	// project footer still carries environment, cwd, workspace, and dir-context.
	const projectPrompt = prompt
		.render(projectPromptTemplate, resolvedCustomPrompt ? { ...data, contextFiles: [], appendPrompt: "" } : data)
		.trim();
	if (projectPrompt) {
		systemPrompt.push(projectPrompt);
	}
	if (activeRepoContextPrompt) {
		systemPrompt.push(activeRepoContextPrompt);
	}

	// The xd:// protocol section (with its device catalog) is only rendered by the
	// default template; a resolved custom prompt uses a template that omits it.
	const xdevCatalogNames =
		!resolvedCustomPrompt && xdevTools.length > 0 ? xdevTools.map(mounted => mounted.name) : undefined;
	return { systemPrompt, xdevCatalogNames, hardwareRefreshed: hardware.refreshed };
}
