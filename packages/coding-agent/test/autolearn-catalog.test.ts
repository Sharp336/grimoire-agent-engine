import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	buildManagedProcedureMetadata,
	type ManagedProcedureMetadata,
	type ProcedureDescriptor,
	type ProcedureDescriptorRow,
	parseManagedProcedureMetadata,
	procedureSuccessRatio,
	rankProcedureCandidates,
} from "@oh-my-pi/pi-coding-agent/autolearn/catalog";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { resolveProjectIdentity } from "@oh-my-pi/pi-coding-agent/utils/project-identity";
import { TempDir } from "@oh-my-pi/pi-utils";

type StoredRow = ProcedureDescriptorRow;

function descriptor(name: string, overrides: Partial<ProcedureDescriptor> = {}): ProcedureDescriptor {
	return {
		name,
		description: `Procedure for ${name}`,
		scope: "global",
		toolFamilies: ["bash"],
		platforms: ["win32"],
		triggers: ["cl not recognized"],
		...overrides,
	};
}

function row(name: string, overrides: Partial<ProcedureDescriptorRow> = {}): StoredRow {
	return {
		...descriptor(name),
		successCount: 0,
		missCount: 0,
		lastRecalledAt: null,
		updatedAt: 0,
		...overrides,
	};
}

describe("Auto-Learn procedure catalog", () => {
	let tempDir: TempDir;

	afterEach(async () => {
		AgentStorage.resetInstance();
		if (tempDir) {
			try {
				await tempDir.remove();
			} catch {}
			tempDir = undefined as unknown as TempDir;
		}
	});

	async function openStorage(): Promise<AgentStorage> {
		tempDir = TempDir.createSync("@omp-autolearn-catalog-");
		return AgentStorage.open(path.join(tempDir.path(), "agent.db"));
	}

	it("round-trips multi-word match terms and families through SQLite", async () => {
		const storage = await openStorage();
		storage.syncAutolearnProcedures([
			descriptor("cl-repair", {
				toolFamilies: ["mcp:build server"],
				platforms: ["win32"],
				triggers: ["cl not recognized", "compiler setup"],
			}),
		]);

		const result = storage.searchAutolearnProcedures({
			toolFamily: "mcp:Build Server",
			platform: "WIN32",
			tokens: ["recognized"],
		});
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]).toMatchObject({
			toolFamilies: ["mcp:build server"],
			platforms: ["win32"],
			triggers: ["cl not recognized", "compiler setup"],
		});
	});

	it("finds symptom prefixes through FTS and reports a normalized lexical rank", async () => {
		const storage = await openStorage();
		storage.syncAutolearnProcedures([descriptor("cl-repair", { triggers: ["cl not recognized"] })]);

		const result = storage.searchAutolearnProcedures({ tokens: ["recogn"] });
		expect(result.rows.map(item => item.name)).toContain("cl-repair");
		const rank = result.lexicalRank.get("cl-repair");
		expect(rank).toBeDefined();
		expect(rank).toBeGreaterThanOrEqual(0);
		expect(rank).toBeLessThanOrEqual(1);
	});

	it("uses substring fallback for infix matches that FTS prefix search cannot find", async () => {
		const storage = await openStorage();
		storage.syncAutolearnProcedures([descriptor("cl-repair", { triggers: ["cl not recognized"] })]);

		const result = storage.searchAutolearnProcedures({ tokens: ["cognized"] });
		expect(result.rows.map(item => item.name)).toContain("cl-repair");
		expect(result.lexicalRank.has("cl-repair")).toBe(false);
	});

	it("updates a descriptor while preserving its recalled outcome counters", async () => {
		const storage = await openStorage();
		storage.syncAutolearnProcedures([descriptor("cl-repair")]);
		storage.recordAutolearnProcedureOutcome("cl-repair", "success");
		storage.recordAutolearnProcedureOutcome("cl-repair", "success");
		storage.recordAutolearnProcedureOutcome("cl-repair", "miss");
		storage.syncAutolearnProcedures([
			descriptor("cl-repair", { description: "Updated procedure description", triggers: ["new symptom"] }),
		]);

		const result = storage.searchAutolearnProcedures({ tokens: ["updated"] });
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]).toMatchObject({
			description: "Updated procedure description",
			successCount: 2,
			missCount: 1,
		});
	});

	it("halves both outcome counters before the next increment once history reaches 256", async () => {
		const storage = await openStorage();
		storage.syncAutolearnProcedures([descriptor("cl-repair")]);
		for (let index = 0; index < 200; index++) storage.recordAutolearnProcedureOutcome("cl-repair", "success");
		for (let index = 0; index < 56; index++) storage.recordAutolearnProcedureOutcome("cl-repair", "miss");
		storage.recordAutolearnProcedureOutcome("cl-repair", "miss");

		const result = storage.searchAutolearnProcedures({ tokens: ["cl"] });
		expect(result.rows[0]).toMatchObject({ successCount: 100, missCount: 29 });
	});

	it("repairs stale descriptor rows while preserving the survivor's counters", async () => {
		const storage = await openStorage();
		storage.syncAutolearnProcedures([descriptor("first"), descriptor("second"), descriptor("third")]);
		storage.recordAutolearnProcedureOutcome("first", "success");
		storage.syncAutolearnProcedures([descriptor("first", { description: "first survivor" })]);

		const gone = storage.searchAutolearnProcedures({ tokens: ["first"] });
		expect(gone.rows.map(item => item.name)).toEqual(["first"]);
		expect(gone.rows[0]).toMatchObject({ description: "first survivor", successCount: 1, missCount: 0 });
		expect(storage.searchAutolearnProcedures({ tokens: ["second"] }).rows).toEqual([]);
		expect(storage.searchAutolearnProcedures({ tokens: ["third"] }).rows).toEqual([]);
	});

	it("enforces family-plus-specific and lexical eligibility gates", () => {
		const query = { toolFamily: "bash", tokens: ["compiler", "recognized", "setup"] };
		const exactSpecific = row("specific", { triggers: ["cl not recognized"] });
		const exactGeneric = row("generic", { triggers: ["error failed command"] });
		const noFamilyFew = row("few", { toolFamilies: ["python"], triggers: ["compiler"] });
		const noFamilyMany = row("many", {
			toolFamilies: ["python"],
			description: "compiler recognized setup",
			triggers: ["compiler recognized"],
		});

		const matches = rankProcedureCandidates([exactSpecific, exactGeneric, noFamilyFew, noFamilyMany], query);
		expect(matches.map(match => match.descriptor.name)).toEqual(["specific", "many"]);
		const genericOnly = rankProcedureCandidates([exactGeneric], {
			toolFamily: "bash",
			tokens: ["error", "failed", "command"],
		});
		expect(genericOnly).toEqual([]);
	});

	it("uses project affinity only to reorder eligible matches", () => {
		const query = { toolFamily: "bash", projectKey: "repo-a", tokens: ["recognized"] };
		const global = row("global", { triggers: ["recognized"] });
		const sameProject = row("same-project", {
			scope: "project-tagged",
			projectKey: "repo-a",
			triggers: ["recognized"],
		});
		const unrelated = row("unrelated", {
			scope: "project-tagged",
			projectKey: "repo-a",
			toolFamilies: ["python"],
			description: "unrelated procedure",
			triggers: ["command"],
		});

		const matches = rankProcedureCandidates([global, sameProject, unrelated], query);
		expect(matches.map(match => match.descriptor.name)).toEqual(["same-project", "global"]);
	});

	it("recalls a project-tagged procedure from a different project", () => {
		const matches = rankProcedureCandidates(
			[
				row("other-project", {
					scope: "project-tagged",
					projectKey: "repo-b",
					triggers: ["cl not recognized"],
				}),
			],
			{ toolFamily: "bash", projectKey: "repo-a", tokens: ["recognized"] },
		);
		expect(matches.map(match => match.descriptor.name)).toEqual(["other-project"]);
	});

	it("matches persisted family and platform terms case-insensitively", async () => {
		const storage = await openStorage();
		storage.syncAutolearnProcedures([
			row("mcp-build-win", {
				toolFamilies: ["mcp:myserver"],
				platforms: ["win32"],
				triggers: ["recognized"],
			}),
			row("mcp-build-linux", {
				toolFamilies: ["mcp:myserver"],
				platforms: ["linux"],
				triggers: ["recognized"],
			}),
		]);
		const result = storage.searchAutolearnProcedures({
			toolFamily: "mcp:MyServer",
			tokens: ["recognized"],
		});
		expect(result.rows).toHaveLength(2);
		expect(result.rows.every(item => item.toolFamilies[0] === "mcp:myserver")).toBe(true);
		const matches = rankProcedureCandidates(result.rows, {
			toolFamily: "mcp:MyServer",
			platform: "WIN32",
			tokens: ["recognized"],
		});
		expect(matches.map(match => match.descriptor.name)).toEqual(["mcp-build-win", "mcp-build-linux"]);
	});

	it("ranks a proven procedure above an unproven one with the same lexical evidence", () => {
		const fresh = row("fresh", { triggers: ["recognized"] });
		const proven = row("proven", { triggers: ["recognized"], successCount: 8, missCount: 1 });
		const matches = rankProcedureCandidates([fresh, proven], { toolFamily: "bash", tokens: ["recognized"] });

		expect(matches.map(match => match.descriptor.name)).toEqual(["proven", "fresh"]);
		const ratio = procedureSuccessRatio(fresh);
		expect(ratio).toBeGreaterThan(0);
		expect(ratio).toBeLessThan(1);
		expect(ratio).toBeGreaterThan(0.25);
	});

	it("normalizes bounded metadata and inherits omitted fields on update", () => {
		const longTerm = "A".repeat(100);
		const metadata = buildManagedProcedureMetadata({
			scope: "project-tagged",
			projectKey: "Project Key",
			projectLabel: "Project Label",
			toolFamilies: ["MCP:Server", "mcp:server", ...Array.from({ length: 16 }, (_, index) => `family-${index}`)],
			platforms: [longTerm, "WIN32", "win32", ...Array.from({ length: 15 }, (_, index) => `platform-${index}`)],
			triggers: [
				"cl not recognized",
				"CL NOT RECOGNIZED",
				...Array.from({ length: 16 }, (_, index) => `trigger-${index}`),
			],
		});

		expect(metadata).toMatchObject({
			scope: "project-tagged",
			projectKey: "project key",
			projectLabel: "project label",
		});
		expect(metadata.toolFamilies).toHaveLength(16);
		expect(metadata.toolFamilies[0]).toBe("mcp:server");
		expect(metadata.platforms).toHaveLength(16);
		expect(metadata.platforms[0]).toBe("a".repeat(80));
		expect(metadata.triggers).toHaveLength(16);
		expect(metadata.triggers[0]).toBe("cl not recognized");

		const updated = buildManagedProcedureMetadata({ triggers: ["updated trigger"] }, metadata);
		expect(updated).toMatchObject({
			scope: "project-tagged",
			projectKey: "project key",
			projectLabel: "project label",
			toolFamilies: metadata.toolFamilies,
			platforms: metadata.platforms,
			triggers: ["updated trigger"],
		});

		const global = buildManagedProcedureMetadata({ scope: "global", projectKey: "ignored", projectLabel: "ignored" });
		expect(global.projectKey).toBeUndefined();
		expect(global.projectLabel).toBeUndefined();
	});

	it("rejects absent, malformed, and unknown metadata blocks while accepting a valid block", () => {
		const metadata: ManagedProcedureMetadata = buildManagedProcedureMetadata({
			scope: "project-tagged",
			projectKey: "repo",
			projectLabel: "repo",
			toolFamilies: ["bash"],
			platforms: ["win32"],
			triggers: ["recognized"],
		});

		expect(parseManagedProcedureMetadata(undefined)).toBeNull();
		expect(parseManagedProcedureMetadata("not an object")).toBeNull();
		expect(parseManagedProcedureMetadata({ ...metadata, schemaVersion: 999 })).toBeNull();
		expect(parseManagedProcedureMetadata(metadata)).toEqual(metadata);
	});

	it("derives collision-resistant stable project identities without mutating platform state", async () => {
		tempDir = TempDir.createSync("@omp-autolearn-project-");
		const left = path.join(tempDir.path(), "left", "Agent");
		const right = path.join(tempDir.path(), "right", "Agent");
		await fs.mkdir(left, { recursive: true });
		await fs.mkdir(right, { recursive: true });

		const leftIdentity = resolveProjectIdentity(left);
		const rightIdentity = resolveProjectIdentity(right);
		expect(leftIdentity.label).toBe("agent");
		expect(rightIdentity.label).toBe("agent");
		expect(leftIdentity.key).not.toBe(rightIdentity.key);
		expect(resolveProjectIdentity(left)).toEqual(leftIdentity);
	});
});
