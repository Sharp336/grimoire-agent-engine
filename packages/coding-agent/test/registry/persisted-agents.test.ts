import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SIDE_SESSION_FILE_PREFIX } from "@oh-my-pi/pi-coding-agent/session/side-conversation";
import { TempDir } from "@oh-my-pi/pi-utils";

function writeJsonl(file: string): void {
	const header = JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "t", cwd: "/tmp" });
	const init = JSON.stringify({
		type: "session_init",
		id: "e1",
		parentId: null,
		timestamp: "t",
		systemPrompt: "sys",
		task: "work",
		tools: [],
	});
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${header}\n${init}\n`);
}

describe("registerPersistedSubagents", () => {
	let tempDir: TempDir | undefined;
	let parentManager: SessionManager | undefined;

	afterEach(async () => {
		AgentRegistry.resetGlobalForTests();
		await parentManager?.close();
		parentManager = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
	});

	it("skips side conversation files but registers other persisted subagents", async () => {
		tempDir = TempDir.createSync("@omp-persisted-scan-");
		// Isolate under the TempDir — the default session dir is the real user store.
		parentManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const parentFile = parentManager.getSessionFile();
		if (!parentFile) throw new Error("parent session file was not created");

		const artifactDir = parentFile.slice(0, -6);
		const sideStem = `${SIDE_SESSION_FILE_PREFIX}0123456789abcdef`;
		const sideFile = path.join(artifactDir, `${sideStem}.jsonl`);
		const sideArtifactDir = path.join(artifactDir, sideStem);
		writeJsonl(sideFile);
		fs.mkdirSync(sideArtifactDir, { recursive: true });
		fs.writeFileSync(path.join(sideArtifactDir, "marker.txt"), "abandoned");
		writeJsonl(path.join(artifactDir, "RegularAgent.jsonl"));

		await registerPersistedSubagents(AgentRegistry.global(), parentFile);

		// The side file would be revivable (it carries session_init), so its
		// absence proves the exclusion — not a malformed-fixture artifact.
		expect(AgentRegistry.global().get(sideStem)).toBeUndefined();
		expect(AgentRegistry.global().get("RegularAgent")).toBeDefined();
		// Abandoned side transcripts (and their artifact dirs) are deleted during
		// the scan so crashed leftovers do not linger on disk forever.
		expect(fs.existsSync(sideFile)).toBe(false);
		expect(fs.existsSync(sideArtifactDir)).toBe(false);
	});
});
