import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendRoutingDecision,
	readRoutingAuditLog,
	type RoutingDecisionInput,
} from "@oh-my-pi/pi-coding-agent/config/routing-audit";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "routing-audit-"));
	tempDirs.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe("routing audit", () => {
	it("serializes concurrent writers into complete JSONL records", async () => {
		const directory = await makeTempDir();
		const logPath = path.join(directory, "routing-audit.jsonl");
		const snapshot = { modelRoles: { default: "anthropic/claude-sonnet" } };

		const [firstId, secondId] = await Promise.all([
			appendRoutingDecision(
				{ evidence: { score: 0.92 }, thresholds: { minimumScore: 0.8 }, before: snapshot, after: snapshot },
				{ logPath },
			),
			appendRoutingDecision(
				{ evidence: { score: 0.95 }, thresholds: { minimumScore: 0.8 }, before: snapshot, after: snapshot },
				{ logPath },
			),
		]);

		const bytes = await Bun.file(logPath).text();
		expect(bytes.endsWith("\n")).toBe(true);
		const records = await readRoutingAuditLog({ logPath });
		expect(records.map(record => record.decisionId).sort()).toEqual([firstId, secondId].sort());
		expect(records.every(record => record.kind === "decision")).toBe(true);
	});

	it("records only normalized route snapshot diffs during settings reload", async () => {
		const directory = await makeTempDir();
		const logPath = path.join(directory, "routing-audit.jsonl");
		const projectA = path.join(directory, "a");
		const projectB = path.join(directory, "b");
		const projectC = path.join(directory, "c");
		await Promise.all([projectA, projectB, projectC].map(project => fs.mkdir(project, { recursive: true })));

		const settings = await Settings.loadIsolated({
			cwd: projectA,
			inMemory: true,
			routingAuditLogPath: logPath,
			overrides: {
				enabledModels: [
					{ paths: [projectA, projectB], models: ["anthropic/claude-sonnet"] },
					{ paths: [projectC], models: ["openai/gpt-5"] },
				],
			},
		});

		await settings.reloadForCwd(projectB);
		expect(await readRoutingAuditLog({ logPath })).toEqual([]);

		await settings.reloadForCwd(projectC);
		const records = await readRoutingAuditLog({ logPath });
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			kind: "external_change",
			source: "settings.reloadForCwd",
			before: { enabledModels: ["anthropic/claude-sonnet"] },
			after: { enabledModels: ["openai/gpt-5"] },
		});
	});

	it("detects a normalized route diff during a later initial settings load", async () => {
		const directory = await makeTempDir();
		const logPath = path.join(directory, "routing-audit.jsonl");
		const cwd = path.join(directory, "project");
		await fs.mkdir(cwd, { recursive: true });

		await Settings.loadIsolated({
			cwd,
			inMemory: true,
			routingAuditLogPath: logPath,
			overrides: { modelRoles: { default: "anthropic/claude-sonnet" } },
		});
		await Settings.loadIsolated({
			cwd,
			inMemory: true,
			routingAuditLogPath: logPath,
			overrides: { modelRoles: { default: "openai/gpt-5" } },
		});

		const records = await readRoutingAuditLog({ logPath });
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			kind: "external_change",
			source: "settings.initialLoad",
			before: { modelRoles: { default: "anthropic/claude-sonnet" } },
			after: { modelRoles: { default: "openai/gpt-5" } },
		});
	});

	it("mints the audit decisionId instead of copying one from the body", async () => {
		const directory = await makeTempDir();
		const logPath = path.join(directory, "routing-audit.jsonl");
		const copiedId = "copied-body-id";
		const input = {
			decisionId: copiedId,
			evidence: { reason: "observe", authorization: "Bearer credential-that-must-not-persist" },
			thresholds: {},
			before: { modelRoles: {} },
			after: { modelRoles: {} },
		} as unknown as RoutingDecisionInput;

		const decisionId = await appendRoutingDecision(input, { logPath });
		const [record] = await readRoutingAuditLog({ logPath });
		expect(decisionId).toBe(record.decisionId);
		expect(decisionId).not.toBe(copiedId);
		expect(record).not.toHaveProperty("data.decisionId");
		expect(await Bun.file(logPath).text()).not.toContain("credential-that-must-not-persist");
	});

	it("skips a missing file and a truncated trailing line", async () => {
		const directory = await makeTempDir();
		const logPath = path.join(directory, "routing-audit.jsonl");
		expect(await readRoutingAuditLog({ logPath })).toEqual([]);

		await appendRoutingDecision(
			{
				evidence: {},
				thresholds: {},
				before: { modelRoles: {} },
				after: { modelRoles: { default: "anthropic/claude-sonnet" } },
			},
			{ logPath },
		);
		await fs.appendFile(logPath, '{"version":1,"kind":"decision"');

		const records = await readRoutingAuditLog({ logPath });
		expect(records).toHaveLength(1);
	});
});
