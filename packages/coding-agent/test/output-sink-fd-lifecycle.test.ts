import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OutputSink } from "@oh-my-pi/pi-coding-agent/session/streaming-output";

// This regression proves the descriptor-ownership barrier: every `await using`
// OutputSink scope that spills to an artifact file releases its `Bun.FileSink`
// descriptor on ordinary and abort-like error exits. Without the barrier those
// descriptors leaked until an unrelated cached `SKILL.md` read exhausted the
// process fd table (EMFILE). Linux-gated because it inspects `/proc/self/fd`.
//
// Intended to run under a low descriptor limit:
//   prlimit --nofile=64:64 bun test packages/coding-agent/test/output-sink-fd-lifecycle.test.ts

const isLinux = process.platform === "linux";

function openFdCount(): number {
	return fs.readdirSync("/proc/self/fd").length;
}

async function spillingScope(artifactPath: string, exit: "ordinary" | "abort"): Promise<void> {
	await using sink = new OutputSink({ artifactPath, artifactId: "fd", spillThreshold: 16 });
	// Force artifact-file creation and a spill so a real descriptor is acquired.
	sink.push("Z".repeat(4096));
	if (exit === "ordinary") {
		throw new Error("ordinary failure");
	}
	const abort = new Error("aborted");
	abort.name = "AbortError";
	throw abort;
}

describe.skipIf(!isLinux)("OutputSink descriptor lifecycle under a low fd limit", () => {
	let dir: string;

	beforeAll(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-fd-lifecycle-"));
	});

	afterAll(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test("spilling scopes release every descriptor on ordinary and abort exits", async () => {
		const artifactPath = path.join(dir, "spill.log");

		// Warm the runtime + file-I/O paths so lazy fd allocations settle before
		// we snapshot the baseline (exact baselines require warm-up).
		for (let i = 0; i < 8; i++) {
			await spillingScope(artifactPath, i % 2 === 0 ? "ordinary" : "abort").catch(() => {});
		}

		const baseline = openFdCount();

		for (let i = 0; i < 64; i++) {
			await spillingScope(artifactPath, i % 2 === 0 ? "ordinary" : "abort").catch(() => {});
		}

		// A leaked writer per error scope would push the count far above baseline
		// (and, under nofile=64, would exhaust the table). The barrier keeps it flat.
		const after = openFdCount();
		expect(after).toBeLessThanOrEqual(baseline);
	});

	test("valid cached SKILL.md survives 16 concurrent reads under a 64-descriptor limit", async () => {
		const skillPath = path.join(dir, "SKILL.md");
		await Bun.write(
			skillPath,
			"---\nname: fd-lifecycle-skill\ndescription: descriptor regression fixture\n---\n# Skill\n\ncached body\n",
		);

		// Drain the leak first so the reads run against a warm, non-exhausted table.
		const leakPath = path.join(dir, "pre-read-spill.log");
		for (let i = 0; i < 32; i++) {
			await spillingScope(leakPath, i % 2 === 0 ? "ordinary" : "abort").catch(() => {});
		}

		const reads = await Promise.all(Array.from({ length: 16 }, () => Bun.file(skillPath).text()));

		expect(reads).toHaveLength(16);
		for (const body of reads) {
			expect(body).toContain("fd-lifecycle-skill");
			expect(body).toContain("cached body");
		}
	});
});
