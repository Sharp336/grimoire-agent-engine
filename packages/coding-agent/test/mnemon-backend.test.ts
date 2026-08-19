import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	getMnemonSessionState,
	mnemonBackend,
	normalizeMnemonImportance,
	resetMnemonConversationTracking,
} from "../src/mnemon/backend";
import { applyMnemonRecallQuality, focusMnemonQuery, formatMnemonSilentRecall } from "../src/mnemon/quality";

describe("mnemon quality", () => {
	it("silent mode keeps only high-score rows", () => {
		const filtered = applyMnemonRecallQuality(
			[
				{ id: "high", content: "keep", score: 0.81 },
				{ id: "medium", content: "drop", score: 0.4 },
				{ id: "old", content: "drop", score: 0.9, superseded: true },
			],
			{ limit: 3, mode: "silent" },
		);
		expect(filtered.results.map(row => row.id)).toEqual(["high"]);
	});

	it("formats every already-limited silent row", () => {
		const text = formatMnemonSilentRecall([
			{ category: "fact", importance: 4, confidence: "high", content: "first" },
			{ category: "decision", importance: 5, confidence: "high", content: "second" },
			{ category: "context", importance: 3, confidence: "high", content: "third" },
			{ category: "insight", importance: 4, confidence: "high", content: "fourth" },
		]);
		expect(text).toContain("first");
		expect(text).toContain("fourth");
	});

	it("focuses conversational queries down to keywords", () => {
		const query = focusMnemonQuery(
			"ok reloaded. how do you feel in this and anything else we should do before publishing this as a proper omp extension repo?",
		);
		expect(query.toLowerCase()).toContain("omp");
		expect(query.toLowerCase()).not.toContain("feel");
	});

	it("maps mnemopi 0-1 importance onto 1-5", () => {
		expect(normalizeMnemonImportance(0.8)).toBe(4);
		expect(normalizeMnemonImportance(3)).toBe(3);
		expect(normalizeMnemonImportance(undefined)).toBe(3);
	});
});

describe("mnemonBackend", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("refuses /memory clear so ~/.mnemon is never wiped", async () => {
		await expect(mnemonBackend.clear("/tmp/agent", "/tmp/project")).rejects.toThrow(/will not wipe/);
	});

	it("refuses secret-like saves", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemon" });
		const result = await mnemonBackend.save?.(
			{ agentDir: "/tmp/agent", cwd: "/tmp/project", session: { settings } as never },
			{ content: "token sk-abcdefghijklmnopqrstuvwxyz123456" },
		);
		expect(result?.stored).toBe(0);
		expect(result?.message).toContain("secret");
	});

	it("refuses a secret placed in entities or source", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemon" });
		const ctx = { agentDir: "/tmp/agent", cwd: "/tmp/project", session: { settings } as never };
		const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
		const viaEntities = await mnemonBackend.save?.(ctx, { content: "ok fact", entities: token });
		expect(viaEntities?.stored).toBe(0);
		expect(viaEntities?.message).toContain("secret");
		const viaSource = await mnemonBackend.save?.(ctx, { content: "ok fact", source: token });
		expect(viaSource?.stored).toBe(0);
		expect(viaSource?.message).toContain("secret");
	});

	it("clears first-turn recall so a new transcript can auto-recall", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemon" });
		const session = { sessionId: "s-new", settings } as never;
		await mnemonBackend.start({
			session,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp/agent",
			taskDepth: 0,
		});
		const state = getMnemonSessionState(session);
		expect(state).toBeDefined();
		state!.hasRecalledForFirstTurn = true;
		state!.lastRecallSnippet = "stale clip";
		expect(resetMnemonConversationTracking(session)).toBe(true);
		expect(state!.hasRecalledForFirstTurn).toBe(false);
		expect(state!.lastRecallSnippet).toBeUndefined();
	});

	it("returns static developer instructions mentioning leads-not-authority", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemon" });
		const text = await mnemonBackend.buildDeveloperInstructions("/tmp/agent", settings);
		expect(text).toContain("retrieval leads");
		expect(text).toContain("no automatic retain drain");
	});

	it("renders /memory stats when the hook is extracted unbound", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemon" });
		const hook = mnemonBackend.stats;
		const text = await hook?.("/tmp/agent", "/tmp/project", { settings } as never);
		expect(text).toContain("# mnemon");
		expect(text).not.toContain("undefined is not an object");
	});

	it("rejects malformed link payloads without calling this", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemon" });
		const hook = mnemonBackend.link;
		const ctx = { agentDir: "/tmp/agent", cwd: "/tmp/project", session: { settings } as never };
		const badId = await hook?.(ctx, {
			id1: "not-a-uuid",
			id2: "c47248fa-2aa5-4268-b49a-6a0d5f45d593",
			type: "semantic",
			weight: 0.7,
		});
		expect(badId?.status).toBe("rejected");
		expect(badId?.message).toContain("UUID");

		const self = await hook?.(ctx, {
			id1: "c47248fa-2aa5-4268-b49a-6a0d5f45d593",
			id2: "c47248fa-2aa5-4268-b49a-6a0d5f45d593",
			type: "semantic",
			weight: 0.7,
		});
		expect(self?.status).toBe("rejected");
		expect(self?.message).toContain("itself");

		const weight = await hook?.(ctx, {
			id1: "c47248fa-2aa5-4268-b49a-6a0d5f45d593",
			id2: "178abf3f-9202-4850-b795-e9c8cc0315b9",
			type: "semantic",
			weight: 1.5,
		});
		expect(weight?.status).toBe("rejected");
		expect(weight?.message).toContain("0");
	});

	it("rejects invalid category without writing", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemon" });
		const result = await mnemonBackend.save?.(
			{ agentDir: "/tmp/agent", cwd: "/tmp/project", session: { settings } as never },
			{ content: "should not write", category: "episode" },
		);
		expect(result?.stored).toBe(0);
		expect(result?.message).toContain("category");
	});

	it("rejects malformed related and forget payloads unbound", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemon" });
		const ctx = { agentDir: "/tmp/agent", cwd: "/tmp/project", session: { settings } as never };
		const related = await mnemonBackend.related?.(ctx, { id: "nope" });
		expect(related?.count).toBe(0);
		expect(related?.message).toContain("UUID");
		const forget = await mnemonBackend.forget?.(ctx, "nope");
		expect(forget?.status).toBe("rejected");
		expect(forget?.message).toContain("UUID");
	});

	it("falls back supersedes to causal when the CLI rejects the fifth type", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mnemon-cli-"));
		const cli = join(dir, "mnemon");
		writeFileSync(
			cli,
			`#!/usr/bin/env bash
set -e
args=("$@")
if [[ "\${args[0]}" == "link" ]]; then
  type=""
  for ((i=0; i<\${#args[@]}; i++)); do
    if [[ "\${args[i]}" == "--type" ]]; then type="\${args[i+1]}"; fi
  done
  if [[ "$type" == "supersedes" ]]; then
    echo 'invalid edge type "supersedes"; valid: temporal, semantic, causal, entity' >&2
    exit 1
  fi
  printf '%s\\n' "{\\"status\\":\\"linked\\",\\"source_id\\":\\"\${args[1]}\\",\\"target_id\\":\\"\${args[2]}\\",\\"edge_type\\":\\"$type\\"}"
  exit 0
fi
echo "unexpected \${args[*]}" >&2
exit 1
`,
		);
		chmodSync(cli, 0o755);
		const settings = Settings.isolated({ "memory.backend": "mnemon", "mnemon.cliPath": cli });
		const result = await mnemonBackend.link?.(
			{ agentDir: "/tmp/agent", cwd: "/tmp/project", session: { settings } as never },
			{
				id1: "c47248fa-2aa5-4268-b49a-6a0d5f45d593",
				id2: "178abf3f-9202-4850-b795-e9c8cc0315b9",
				type: "supersedes",
				weight: 1,
			},
		);
		expect(result?.status).toBe("linked");
		expect(result?.type).toBe("causal");
		expect(result?.message).toContain("causal");
	});
});
