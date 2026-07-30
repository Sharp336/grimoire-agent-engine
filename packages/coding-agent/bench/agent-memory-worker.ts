#!/usr/bin/env bun
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { heapStats, memoryUsage } from "bun:jsc";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AgentLifecycleManager } from "../src/registry/agent-lifecycle";
import { AgentRegistry } from "../src/registry/agent-registry";
import { discoverAuthStorage } from "../src/sdk";
import { getBundledAgent } from "../src/task/agents";
import { runSubprocess } from "../src/task/executor";
import taskPrompt from "./agent-memory-task.md" with { type: "text" };

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const DEFAULT_AGENT_COUNT = 15;
const DEFAULT_IDLE_TTL_MS = 420_000;
const DEFAULT_SAMPLE_INTERVAL_MS = 100;
const SUBAGENT_MAX_RUNTIME_MS = 120_000;
const TTL_GRACE_MS = 2_000;
const SIXTY_FOUR_MIB_KB = 65_536;
const FULLY_RESIDENT_FRACTION = 0.99;
const TOP_MAPPING_COUNT = 10;

interface WorkerOptions {
	agentCount: number;
	idleTtlMs: number;
	sampleIntervalMs: number;
	heapSnapshot: boolean;
}

interface ProcRollup {
	rssKb: number;
	peakRssKb: number;
	pssKb: number;
	privateCleanKb: number;
	privateDirtyKb: number;
	anonymousKb: number;
	pssAnonymousKb: number;
	anonHugePagesKb: number;
	swapKb: number;
}

interface MappingSummary {
	anonymousPrivateCount: number;
	anonymousPrivateVirtualKb: number;
	anonymousPrivateRssKb: number;
	fullyResident64MiBCount: number;
	topAnonymousPrivate: Array<{
		range: string;
		perms: string;
		pathname: string;
		virtualKb: number;
		rssKb: number;
		privateKb: number;
	}>;
}

interface Sample {
	stage: string;
	elapsedMs: number;
	proc: ProcRollup;
	jsc: {
		heapSize: number;
		heapCapacity: number;
		extraMemorySize: number;
		objectCount: number;
		protectedObjectCount: number;
		globalObjectCount: number;
		protectedGlobalObjectCount: number;
	};
	allocator: {
		current: number;
		peak: number;
		currentCommit: number;
		peakCommit: number;
		pageFaults: number;
	};
	registry: {
		total: number;
		liveSessions: number;
		statuses: Record<string, number>;
	};
	mappings?: MappingSummary;
}

interface ParsedMapping {
	start: number;
	end: number;
	perms: string;
	pathname: string;
	fields: Record<string, number>;
}

function printLine(message: string): void {
	process.stdout.write(`${message}\n`);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parseInteger(name: string, value: string, minimum: number): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum) {
		throw new Error(`${name} must be an integer >= ${minimum}, got ${value}`);
	}
	return parsed;
}

function nextValue(argv: string[], index: number, flag: string): string {
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
	return value;
}

function parseArgs(argv: string[]): WorkerOptions {
	let agentCount = DEFAULT_AGENT_COUNT;
	let idleTtlMs = DEFAULT_IDLE_TTL_MS;
	let sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS;
	let heapSnapshot = true;

	for (let index = 2; index < argv.length; index++) {
		const arg = argv[index]!;
		switch (arg) {
			case "--agents":
				agentCount = parseInteger(arg, nextValue(argv, index, arg), 1);
				index++;
				break;
			case "--idle-ttl-ms":
				idleTtlMs = parseInteger(arg, nextValue(argv, index, arg), 0);
				index++;
				break;
			case "--sample-ms":
				sampleIntervalMs = parseInteger(arg, nextValue(argv, index, arg), 1);
				index++;
				break;
			case "--no-heap-snapshot":
				heapSnapshot = false;
				break;
			default:
				throw new Error(`Unknown worker option: ${arg}`);
		}
	}

	return { agentCount, idleTtlMs, sampleIntervalMs, heapSnapshot };
}

function parseKbFields(text: string): Record<string, number> {
	const fields: Record<string, number> = {};
	for (const line of text.split("\n")) {
		const match = /^([A-Za-z_]+):\s+(\d+)\s+kB$/.exec(line.trim());
		if (match) fields[match[1]!] = Number(match[2]);
	}
	return fields;
}

function requireKb(fields: Record<string, number>, key: string): number {
	const value = fields[key];
	if (value === undefined) throw new Error(`/proc metric missing: ${key}`);
	return value;
}

function parseRollup(rollupText: string, statusText: string): ProcRollup {
	const fields = parseKbFields(rollupText);
	const statusFields = parseKbFields(statusText);
	return {
		rssKb: requireKb(fields, "Rss"),
		peakRssKb: requireKb(statusFields, "VmHWM"),
		pssKb: requireKb(fields, "Pss"),
		privateCleanKb: requireKb(fields, "Private_Clean"),
		privateDirtyKb: requireKb(fields, "Private_Dirty"),
		anonymousKb: requireKb(fields, "Anonymous"),
		pssAnonymousKb: fields.Pss_Anon ?? 0,
		anonHugePagesKb: requireKb(fields, "AnonHugePages"),
		swapKb: requireKb(fields, "Swap"),
	};
}

function parseMappings(text: string): ParsedMapping[] {
	const mappings: ParsedMapping[] = [];
	let current: ParsedMapping | undefined;
	for (const line of text.split("\n")) {
		const header = /^([0-9a-f]+)-([0-9a-f]+)\s+(\S+)\s+\S+\s+\S+\s+\d+\s*(.*)$/.exec(line);
		if (header) {
			if (current) mappings.push(current);
			current = {
				start: Number.parseInt(header[1]!, 16),
				end: Number.parseInt(header[2]!, 16),
				perms: header[3]!,
				pathname: header[4]!.trim(),
				fields: {},
			};
			continue;
		}
		if (!current) continue;
		const field = /^([A-Za-z_]+):\s+(\d+)\s+kB$/.exec(line.trim());
		if (field) current.fields[field[1]!] = Number(field[2]);
	}
	if (current) mappings.push(current);
	return mappings;
}

function isAnonymousPrivate(mapping: ParsedMapping): boolean {
	const anonymousPath =
		mapping.pathname === "" || mapping.pathname === "[heap]" || mapping.pathname.startsWith("[anon");
	return anonymousPath && mapping.perms.endsWith("p");
}

function anonymousMappingLabel(pathname: string): string {
	switch (pathname) {
		case "":
			return "(anonymous)";
		case "[heap]":
			return "[heap]";
		case "[anon:WKFastMalloc]":
			return "[anon:WKFastMalloc]";
		case "[anon:JSJITCode]":
			return "[anon:JSJITCode]";
		case "[anon:JSStructureHeap]":
			return "[anon:JSStructureHeap]";
		default:
			return "[anon:other]";
	}
}

function mappingPermsLabel(perms: string): string {
	switch (perms) {
		case "rw-p":
			return "rw-p";
		case "rwxp":
			return "rwxp";
		case "r--p":
			return "r--p";
		case "---p":
			return "---p";
		default:
			return "other-private";
	}
}

function summarizeMappings(text: string): MappingSummary {
	const anonymous = parseMappings(text)
		.filter(isAnonymousPrivate)
		.map(mapping => {
			const virtualKb = (mapping.end - mapping.start) / 1024;
			const rssKb = mapping.fields.Rss ?? 0;
			const privateKb = (mapping.fields.Private_Clean ?? 0) + (mapping.fields.Private_Dirty ?? 0);
			return {
				range: `${mapping.start.toString(16)}-${mapping.end.toString(16)}`,
				perms: mappingPermsLabel(mapping.perms),
				pathname: anonymousMappingLabel(mapping.pathname),
				virtualKb,
				rssKb,
				privateKb,
			};
		});
	const fullyResident64MiBCount = anonymous.filter(
		mapping =>
			mapping.virtualKb === SIXTY_FOUR_MIB_KB && mapping.rssKb / mapping.virtualKb >= FULLY_RESIDENT_FRACTION,
	).length;
	const summary: MappingSummary = {
		anonymousPrivateCount: anonymous.length,
		anonymousPrivateVirtualKb: anonymous.reduce((sum, mapping) => sum + mapping.virtualKb, 0),
		anonymousPrivateRssKb: anonymous.reduce((sum, mapping) => sum + mapping.rssKb, 0),
		fullyResident64MiBCount,
		topAnonymousPrivate: anonymous.sort((left, right) => right.rssKb - left.rssKb).slice(0, TOP_MAPPING_COUNT),
	};
	// JSC retains the most recent RegExp input; replace the multi-MiB smaps source before heap snapshots.
	void /^x$/.exec("x");
	return summary;
}

function registrySnapshot(): Sample["registry"] {
	const refs = AgentRegistry.global().list();
	const statuses: Record<string, number> = {};
	let liveSessions = 0;
	for (const ref of refs) {
		statuses[ref.status] = (statuses[ref.status] ?? 0) + 1;
		if (ref.session) liveSessions++;
	}
	return { total: refs.length, liveSessions, statuses };
}

function memoryDelta(after: Sample | undefined, before: Sample | undefined): object | null {
	if (!after || !before) return null;
	return {
		rssKb: after.proc.rssKb - before.proc.rssKb,
		peakRssKb: after.proc.peakRssKb - before.proc.peakRssKb,
		pssKb: after.proc.pssKb - before.proc.pssKb,
		anonymousKb: after.proc.anonymousKb - before.proc.anonymousKb,
		jscHeapSize: after.jsc.heapSize - before.jsc.heapSize,
		allocatorCurrent: after.allocator.current - before.allocator.current,
		liveSessions: after.registry.liveSessions - before.registry.liveSessions,
	};
}

async function writeJson(target: string, value: unknown): Promise<void> {
	await Bun.write(target, `${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
	if (process.platform !== "linux") throw new Error("The agent memory worker requires Linux /proc");
	const outputDir = process.env.OMP_MEMORY_PROBE_OUTPUT;
	if (!outputDir) throw new Error("OMP_MEMORY_PROBE_OUTPUT is required");
	const options = parseArgs(process.argv);
	const sessionsDir = path.join(outputDir, "sessions");
	await fs.mkdir(sessionsDir, { recursive: true, mode: 0o700 });

	const smapsRollupFile = Bun.file("/proc/self/smaps_rollup");
	const statusFile = Bun.file("/proc/self/status");
	const smapsFile = Bun.file("/proc/self/smaps");
	const samplesSink = Bun.file(path.join(outputDir, "samples.jsonl")).writer();
	const startedAt = performance.now();
	const namedSamples: Record<string, Sample> = {};
	let peakRunning: Sample | undefined;
	let heapSnapshotBytes = 0;
	let failure: unknown;
	let resultsSummary: Array<Record<string, unknown>> = [];

	async function recordSample(stage: string, includeMappings: boolean): Promise<Sample> {
		const [rollupText, statusText] = await Promise.all([smapsRollupFile.text(), statusFile.text()]);
		const heap = heapStats();
		const allocator = memoryUsage();
		const proc = parseRollup(rollupText, statusText);
		const registry = registrySnapshot();
		const elapsedMs = Math.round(performance.now() - startedAt);
		const mappings = includeMappings ? summarizeMappings(await smapsFile.text()) : undefined;
		const sample: Sample = {
			stage,
			elapsedMs,
			proc,
			jsc: {
				heapSize: heap.heapSize,
				heapCapacity: heap.heapCapacity,
				extraMemorySize: heap.extraMemorySize,
				objectCount: heap.objectCount,
				protectedObjectCount: heap.protectedObjectCount,
				globalObjectCount: heap.globalObjectCount,
				protectedGlobalObjectCount: heap.protectedGlobalObjectCount,
			},
			allocator,
			registry,
			mappings,
		};
		await samplesSink.write(`${JSON.stringify(sample)}\n`);
		if (stage === "running") {
			if (!peakRunning || sample.proc.pssKb > peakRunning.proc.pssKb) peakRunning = sample;
		} else {
			namedSamples[stage] = sample;
			await samplesSink.flush();
		}
		return sample;
	}

	await writeJson(path.join(outputDir, "metadata.json"), {
		pid: process.pid,
		startedAt: new Date().toISOString(),
		cwd: REPO_ROOT,
		bunVersion: Bun.version,
		targetRef: process.env.OMP_MEMORY_PROBE_REF ?? null,
		targetCommit: process.env.OMP_MEMORY_PROBE_COMMIT ?? null,
		scope: "in-process runSubprocess scout lifecycle; excludes TUI, native scrollback, and TaskTool rendering",
		...options,
	});

	const lifecycle = AgentLifecycleManager.global();
	try {
		const settings = await Settings.init({
			cwd: REPO_ROOT,
			readOnly: true,
			overrides: {
				"task.agentIdleTtlMs": options.idleTtlMs,
				"task.maxRuntimeMs": SUBAGENT_MAX_RUNTIME_MS,
			},
		});
		const authStorage = await discoverAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage);
		const scout = getBundledAgent("scout");
		if (!scout) throw new Error("Bundled scout agent is unavailable");
		await writeJson(path.join(outputDir, "runtime.json"), {
			agent: scout.name,
			agentSource: scout.source,
			agentModelPatterns: scout.model ?? null,
			resolvedSmolModel: settings.getModelRole("smol") ?? null,
			hasAgentOutputSchema: scout.output !== undefined,
		});

		Bun.gc(true);
		await recordSample("baseline", true);
		printLine(`worker_pid=${process.pid}`);
		printLine(`batch_agents=${options.agentCount}`);

		const runs = Array.from({ length: options.agentCount }, (_, index) => {
			const id = `MemoryProbe${String(index + 1).padStart(2, "0")}`;
			return runSubprocess({
				cwd: REPO_ROOT,
				agent: scout,
				task: taskPrompt,
				assignment: taskPrompt,
				index,
				id,
				outputSchema: scout.output,
				outputSchemaMode: "strict",
				outputSchemaSource: "agent",
				maxRuntimeMs: SUBAGENT_MAX_RUNTIME_MS,
				enableIrc: false,
				enableLsp: false,
				enableMCP: false,
				restrictToolNames: true,
				artifactsDir: sessionsDir,
				contextFiles: [],
				skills: [],
				promptTemplates: [],
				rules: [],
				preloadedExtensionPaths: [],
				preloadedCustomToolPaths: [],
				authStorage,
				modelRegistry,
				settings,
				keepAlive: true,
			});
		});
		const batch = Promise.all(runs);
		let batchSettled = false;
		void batch.then(
			() => {
				batchSettled = true;
			},
			() => {
				batchSettled = true;
			},
		);
		await recordSample("running", false);
		while (!batchSettled) {
			await Bun.sleep(options.sampleIntervalMs);
			if (!batchSettled) await recordSample("running", false);
		}

		const results = await batch;
		await recordSample("completed", true);
		resultsSummary = results.map(result => ({
			id: result.id,
			resolvedModel: result.resolvedModel ?? null,
			exitCode: result.exitCode,
			aborted: result.aborted ?? false,
			durationMs: result.durationMs,
			requests: result.requests,
			tokens: result.tokens,
			contextTokens: result.contextTokens ?? null,
			contextWindow: result.contextWindow ?? null,
			outputBytes: Buffer.byteLength(result.output),
			error: result.error ?? null,
			structuredStatus: result.structuredOutput?.status ?? null,
		}));
		await writeJson(path.join(outputDir, "results.json"), resultsSummary);
		const failed = results.filter(
			result =>
				result.exitCode !== 0 ||
				result.aborted === true ||
				result.structuredOutput?.status !== "valid",
		);
		if (failed.length > 0) throw new Error(`${failed.length}/${options.agentCount} scout runs failed`);

		printLine(`idle_wait_ms=${options.idleTtlMs + TTL_GRACE_MS}`);
		await Bun.sleep(options.idleTtlMs + TTL_GRACE_MS);
		await recordSample("post_idle_ttl", true);
		Bun.gc(true);
		await recordSample("forced_gc", true);
		if (options.heapSnapshot) {
			await Bun.sleep(0);
			Bun.gc(true);
			await Bun.sleep(0);
			Bun.gc(true);
		}

		if (options.heapSnapshot) {
			printLine("heap_snapshot=running");
			const snapshot = Bun.generateHeapSnapshot("v8", "arraybuffer");
			heapSnapshotBytes = snapshot.byteLength;
			await Bun.write(path.join(outputDir, "heap.heapsnapshot"), snapshot);
		}
	} catch (error) {
		failure = error;
	} finally {
		await samplesSink.end();
		try {
			await lifecycle.dispose();
		} catch (error) {
			failure ??= error;
		}
	}

	const baseline = namedSamples.baseline;
	const completed = namedSamples.completed;
	const postIdleTtl = namedSamples.post_idle_ttl;
	const forcedGc = namedSamples.forced_gc;
	await writeJson(path.join(outputDir, "summary.json"), {
		status: failure ? "failed" : "completed",
		error: failure ? errorMessage(failure) : null,
		results: resultsSummary,
		stages: {
			baseline: baseline ?? null,
			peakSampledRunning: peakRunning ?? null,
			completed: completed ?? null,
			postIdleTtl: postIdleTtl ?? null,
			forcedGc: forcedGc ?? null,
		},
		deltasFromBaseline: {
			peakSampledRunning: memoryDelta(peakRunning, baseline),
			completed: memoryDelta(completed, baseline),
			postIdleTtl: memoryDelta(postIdleTtl, baseline),
			forcedGc: memoryDelta(forcedGc, baseline),
		},
		heapSnapshotBytes,
	});

	if (failure) throw failure;
	printLine(`worker_completed=${outputDir}`);
}

main().catch(error => {
	process.stderr.write(`agent-memory worker failed: ${errorMessage(error)}\n`);
	process.exitCode = 1;
});
