import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import {
	applyPrimeDestination,
	type PrimeDestinationApplyResult,
	type PrimeDestinationInput,
	planPrimeDestination,
	validatePrimeDestinationRollbackEntry,
} from "../src/import/prime/destination";
import type {
	PrimeConfigParserResult,
	PrimeNormalizedCredentialOperation,
	PrimeNormalizedModelOperation,
	PrimeSourceSnapshot,
} from "../src/import/prime/types";
import { ApplyOnlySecretTable } from "../src/import/prime/types";

const roots: string[] = [];
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
async function temp(): Promise<string> {
	const value = await fs.mkdtemp(path.join(os.tmpdir(), "prime-destination-"));
	roots.push(value);
	return value;
}
async function sourceSnapshot(root: string): Promise<PrimeSourceSnapshot> {
	const prime = path.join(root, "prime"),
		cwd = path.join(root, "project"),
		sessions = path.join(prime, "sessions");
	await Promise.all([
		fs.mkdir(prime, { recursive: true }),
		fs.mkdir(cwd, { recursive: true }),
		fs.mkdir(sessions, { recursive: true }),
	]);
	return {
		schemaVersion: 1,
		snapshotId: "snapshot-1",
		sourceRoot: prime,
		cwd,
		sessionRoot: sessions,
		maxFileBytes: 1_000_000,
		maxTotalBytes: 1_000_000,
		maxEntries: 100,
		files: [],
		treeEntries: [],
	};
}
function config(overrides: Partial<PrimeConfigParserResult> = {}): PrimeConfigParserResult {
	const secretTable = new ApplyOnlySecretTable();
	return {
		settings: [],
		effectiveSettings: {},
		models: [],
		credentials: [],
		operations: [],
		losses: [],
		secretTable,
		...overrides,
	};
}
function input(
	snapshot: PrimeSourceSnapshot,
	overrides: Partial<PrimeConfigParserResult> = {},
	candidates: PrimeDestinationInput["skills"]["candidates"] = [],
): PrimeDestinationInput {
	return { snapshot, config: config(overrides), skills: { candidates, losses: [] } };
}
function credential(provider: string, id: string): PrimeNormalizedCredentialOperation {
	return {
		kind: "credentials",
		provider,
		classification: "literal_api_key",
		secretOperationId: id,
		metadata: { provider, classification: "literal_api_key", sourceRef: "global/auth.json", secretOperationId: id },
		sourceRefs: ["global/auth.json"],
	};
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("prime destination planning and apply", () => {
	it("keeps dry-run byte-pure, including an absent agent directory", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp");
		const plan = await planPrimeDestination(
			input(snapshot, {
				effectiveSettings: { hideThinkingBlock: true },
				settings: [
					{
						kind: "settings",
						scope: "global",
						values: { hideThinkingBlock: true },
						sourceRefs: ["global/settings.json"],
					},
				],
			}),
			{ agentDir, cwd: snapshot.cwd },
		);
		expect(await fs.stat(agentDir).catch(() => undefined)).toBeUndefined();
		expect(plan.items.map(item => item.itemId)).toEqual(["setting:hideThinkingBlock"]);
		expect(plan.items[0]?.outcome).toBe("planned");
	});
	it("dry-run terminal-loses an oversized destination settings file without writing", async () => {
		const root = await temp(),
			snapshot = { ...(await sourceSnapshot(root)), maxFileBytes: 32, maxTotalBytes: 64 },
			agentDir = path.join(root, "omp"),
			configPath = path.join(agentDir, "config.yml"),
			bytes = `hideThinkingBlock: false\n${"#".repeat(64)}`;
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(configPath, bytes);
		const plan = await planPrimeDestination(
			input(snapshot, {
				effectiveSettings: { hideThinkingBlock: true },
				settings: [
					{
						kind: "settings",
						scope: "global",
						values: { hideThinkingBlock: true },
						sourceRefs: ["global/settings.json"],
					},
				],
			}),
			{ agentDir, cwd: snapshot.cwd },
		);
		expect(plan.items[0]?.outcome).toBe("lost");
		expect(plan.items[0]?.lossCodes).toContain("destination-invalid");
		expect(await fs.readFile(configPath, "utf8")).toBe(bytes);
		expect(await fs.stat(getAgentDbPath(agentDir)).catch(() => undefined)).toBeUndefined();
	});

	it("dry-run terminal-loses an excessively deep destination settings file without writing", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			configPath = path.join(agentDir, "config.yml");
		let bytes = "hideThinkingBlock:\n";
		for (let depth = 0; depth < 70; depth++) bytes += `${"  ".repeat(depth + 1)}nested:\n`;
		bytes += `${"  ".repeat(71)}value\n`;
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(configPath, bytes);
		const plan = await planPrimeDestination(
			input(snapshot, {
				effectiveSettings: { hideThinkingBlock: true },
				settings: [
					{
						kind: "settings",
						scope: "global",
						values: { hideThinkingBlock: true },
						sourceRefs: ["global/settings.json"],
					},
				],
			}),
			{ agentDir, cwd: snapshot.cwd },
		);
		expect(plan.items[0]?.outcome).toBe("lost");
		expect(plan.items[0]?.lossCodes).toContain("destination-invalid");
		expect(await fs.readFile(configPath, "utf8")).toBe(bytes);
		expect(await fs.stat(getAgentDbPath(agentDir)).catch(() => undefined)).toBeUndefined();
	});

	it("uses existing settings and model/skill directories as winning values", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			skillsRoot = path.join(agentDir, "skills");
		await fs.mkdir(skillsRoot, { recursive: true });
		await fs.writeFile(path.join(agentDir, "config.yml"), "hideThinkingBlock: false\n");
		await fs.mkdir(path.join(skillsRoot, "same"), { recursive: true });
		await fs.writeFile(path.join(skillsRoot, "same", "marker"), "keep");
		await fs.writeFile(path.join(agentDir, "models.yml"), "providers:\n  local:\n    baseUrl: http://existing\n");
		const model: PrimeNormalizedModelOperation = {
			kind: "models",
			modelKind: "definition",
			provider: "local",
			providerConfig: { baseUrl: "http://prime" },
			model: { id: "one", api: "openai-completions", contextWindow: 1000 },
			sourceRefs: ["global/models.json"],
		};
		const plan = await planPrimeDestination(
			input(
				snapshot,
				{
					effectiveSettings: { hideThinkingBlock: true },
					settings: [
						{
							kind: "settings",
							scope: "global",
							values: { hideThinkingBlock: true },
							sourceRefs: ["global/settings.json"],
						},
					],
					models: [model],
					operations: [model],
				},
				[
					{
						kind: "skill",
						scope: "global",
						name: "same",
						directorySourceRef: "global/skills/same",
						frontmatter: { description: "same" },
						files: [],
					},
				],
			),
			{ agentDir, cwd: snapshot.cwd },
		);
		expect(plan.items.find(item => item.itemId === "setting:hideThinkingBlock")?.outcome).toBe("skipped");
		expect(plan.items.find(item => item.itemId === "skill:same")?.outcome).toBe("skipped");
		expect(plan.items.find(item => item.itemId === "model:local:definition:one")?.outcome).toBe("planned");
	});
	it("coalesces duplicate logical models into one item and rollback guard", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp");
		const first: PrimeNormalizedModelOperation = {
				kind: "models",
				modelKind: "definition",
				provider: "local",
				providerConfig: { api: "openai-completions", auth: "none", baseUrl: "http://local" },
				model: {
					id: "same",
					name: "First",
					api: "openai-completions",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					maxTokens: 4_096,
				},
				sourceRefs: ["global/models-a.json"],
			},
			second: PrimeNormalizedModelOperation = {
				kind: "models",
				modelKind: "definition",
				provider: "local",
				providerConfig: { api: "openai-completions", auth: "none", baseUrl: "http://local" },
				model: { id: "same", name: "Second", contextWindow: 32_768 },
				sourceRefs: ["global/models-b.json"],
			},
			value = input(snapshot, {
				models: [first, second],
				operations: [first, second],
			}),
			plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd });
		const modelItems = plan.items.filter(item => item.kind === "models");
		expect(modelItems).toHaveLength(1);
		expect(modelItems[0]?.sourceRefs).toEqual(["global/models-a.json", "global/models-b.json"]);
		const applied = await applyPrimeDestination(plan, value);
		expect(applied.report.items.find(item => item.kind === "models")?.outcome).toBe("imported");
		const entries = applied.rollbackEntries.filter(entry => entry.kind === "models"),
			text = await fs.readFile(plan.destination.modelsPath, "utf8");
		expect(applied.report.items.filter(item => item.kind === "models")).toHaveLength(1);
		expect(entries).toHaveLength(1);
		expect(text.match(/id: same/g)).toHaveLength(1);
		expect(text).toContain("name: First");
		expect(text).toContain("contextWindow: 32768");
		expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
	});
	it("merges only missing model fields and records an existing-container rollback guard", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			modelsPath = path.join(agentDir, "models.yml"),
			existing =
				"providers:\n  local:\n    baseUrl: http://existing\n    api: openai-completions\n    auth: none\n    compat:\n      openRouterRouting:\n        only: [existing]\n    models:\n      - id: shared\n        name: Existing\n        contextWindow: 1024\n";
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(modelsPath, existing);
		const operation: PrimeNormalizedModelOperation = {
			kind: "models",
			modelKind: "definition",
			provider: "local",
			providerConfig: {
				baseUrl: "http://imported",
				compat: { openRouterRouting: { only: ["imported"], order: ["fallback"] } },
			},
			model: {
				id: "shared",
				name: "Imported",
				contextWindow: 4096,
				api: "openai-completions",
				compat: { supportsStore: true },
			},
			sourceRefs: ["global/models.json"],
		};
		const value = input(snapshot, { models: [operation], operations: [operation] }),
			plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd }),
			applied = await applyPrimeDestination(plan, value),
			text = await fs.readFile(modelsPath, "utf8"),
			parsed = YAML.parse(text) as {
				providers: { local: { compat?: unknown; models: Array<{ compat?: unknown }> } };
			},
			entry = applied.rollbackEntries.find(item => item.itemId === "model:local:definition:shared"),
			priorDigest = createHash("sha256").update(existing).digest("hex");
		expect(text).toContain("baseUrl: http://existing");
		expect(text).toContain("name: Existing");
		expect(text).toContain("contextWindow: 1024");
		expect(text).not.toContain("name: Imported");
		expect(parsed.providers.local.compat).toEqual({
			openRouterRouting: { only: ["existing"], order: ["fallback"] },
		});
		expect(parsed.providers.local.models[0]?.compat).toEqual({ supportsStore: true });
		expect(entry).toEqual(
			expect.objectContaining({
				created: false,
				priorExists: true,
				priorSha256: priorDigest,
				preconditionSha256: priorDigest,
			}),
		);
		expect(entry && (await validatePrimeDestinationRollbackEntry(entry, plan.destination))).toBe(true);
	});

	it("keeps the prior models file intact when atomic publication fails", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			modelsPath = path.join(agentDir, "models.yml"),
			existing =
				"providers:\n  local:\n    baseUrl: http://existing\n    api: openai-completions\n    auth: none\n    models: []\n";
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(modelsPath, existing);
		const operation: PrimeNormalizedModelOperation = {
				kind: "models",
				modelKind: "definition",
				provider: "local",
				model: { id: "new-model", api: "openai-completions" },
				sourceRefs: ["global/models.json"],
			},
			value = input(snapshot, { models: [operation], operations: [operation] }),
			plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd }),
			originalRename = fs.rename,
			renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
				if (path.resolve(String(args[1])) === path.resolve(modelsPath))
					throw Object.assign(new Error("atomic model publication failed"), { code: "ENOSPC" });
				await originalRename(...args);
			});
		let applied: PrimeDestinationApplyResult;
		try {
			applied = await applyPrimeDestination(plan, value);
		} finally {
			renameSpy.mockRestore();
		}
		expect(applied.report.items.find(item => item.kind === "models")?.outcome).toBe("lost");
		expect(applied.report.losses).toContainEqual(
			expect.objectContaining({ code: "destination-apply-failed", domain: "config" }),
		);
		expect(await fs.readFile(modelsPath, "utf8")).toBe(existing);
	});

	it("records new model containers as create-only rollback guards", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp");
		const operation: PrimeNormalizedModelOperation = {
			kind: "models",
			modelKind: "definition",
			provider: "new-provider",
			providerConfig: { baseUrl: "http://new-provider", auth: "none" },
			model: { id: "new-model", api: "openai-completions" },
			sourceRefs: ["global/models.json"],
		};
		const value = input(snapshot, { models: [operation], operations: [operation] }),
			plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd }),
			applied = await applyPrimeDestination(plan, value),
			entry = applied.rollbackEntries.find(item => item.itemId === "model:new-provider:definition:new-model");
		expect(entry).toEqual(
			expect.objectContaining({
				created: true,
				priorExists: false,
				priorSha256: undefined,
				preconditionSha256: undefined,
			}),
		);
		expect(entry && (await validatePrimeDestinationRollbackEntry(entry, plan.destination))).toBe(true);
	});

	it("loses forged model provider, override, and nested provider-config meta keys before apply", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			forgedProviderConfig = { api: "openai-completions" };
		Object.defineProperty(forgedProviderConfig, "__proto__", {
			value: { polluted: true },
			enumerable: true,
		});
		const operations: PrimeNormalizedModelOperation[] = [
			{
				kind: "models",
				modelKind: "definition",
				provider: "__proto__",
				model: { id: "definition", api: "openai-completions" },
				sourceRefs: ["global/models.json"],
			},
			{
				kind: "models",
				modelKind: "override",
				provider: "safe",
				model: { id: "constructor" },
				sourceRefs: ["global/models.json"],
			},
			{
				kind: "models",
				modelKind: "definition",
				provider: "safe",
				providerConfig: forgedProviderConfig,
				model: { id: "nested", api: "openai-completions" },
				sourceRefs: ["global/models.json"],
			},
		];
		const value = input(snapshot, { models: operations, operations }),
			plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd });
		expect(plan.items.filter(item => item.kind === "models")).toHaveLength(3);
		expect(plan.items.filter(item => item.kind === "models").every(item => item.outcome === "lost")).toBe(true);
		expect(
			plan.items
				.filter(item => item.kind === "models")
				.every(item => item.lossCodes?.includes("models-invalid-value")),
		).toBe(true);
		const applied = await applyPrimeDestination(plan, value);
		expect(applied.rollbackEntries).toEqual([]);
		expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
		expect(await fs.stat(agentDir).catch(() => undefined)).toBeUndefined();
	});
	it("applies absent settings and new skills without replacing seeded conflicts", async () => {
		const root = await temp();
		const snapshot = await sourceSnapshot(root);
		const agentDir = path.join(root, "omp");
		const skillsRoot = path.join(agentDir, "skills");
		await fs.mkdir(path.join(skillsRoot, "same"), { recursive: true });
		await fs.writeFile(path.join(skillsRoot, "same", "marker"), "keep");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(path.join(agentDir, "config.yml"), "hideThinkingBlock: false\n");
		const skillBytes = Buffer.from("---\nname: new\ndescription: Imported\n---\n\nbody\n");
		const skill = {
			kind: "skill" as const,
			scope: "global" as const,
			name: "new",
			directorySourceRef: "global/skills/new",
			frontmatter: { description: "Imported" },
			files: [
				{
					kind: "file" as const,
					relativePath: "SKILL.md",
					sourceRef: "global/skills/new/SKILL.md",
					mode: 0o600,
					size: skillBytes.byteLength,
					sha256: createHash("sha256").update(skillBytes).digest("hex"),
					contentBase64: skillBytes.toString("base64"),
				},
			],
		};
		const value = input(
			snapshot,
			{
				effectiveSettings: { hideThinkingBlock: true, "retry.enabled": true },
				settings: [
					{
						kind: "settings",
						scope: "global",
						values: { hideThinkingBlock: true, "retry.enabled": true },
						sourceRefs: ["global/settings.json"],
					},
				],
			},
			[skill],
		);
		const plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd });
		const applied = await applyPrimeDestination(plan, value),
			report = applied.report;
		expect(report.items.find(item => item.itemId === "skill:new")?.outcome).toBe("imported");
		expect(await fs.readFile(path.join(skillsRoot, "new", "SKILL.md"), "utf8")).toBe(skillBytes.toString());
		expect(await fs.readFile(path.join(skillsRoot, "same", "marker"), "utf8")).toBe("keep");
		expect(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")).toContain("hideThinkingBlock: false");
	});
	it.skipIf(process.platform === "win32")(
		"terminal-loses every executable item for an arbitrary symlinked destination ancestor",
		async () => {
			const root = await temp(),
				snapshot = await sourceSnapshot(root),
				victim = path.join(root, "victim"),
				link = path.join(root, "link"),
				agentDir = path.join(link, "omp");
			await fs.mkdir(victim);
			await fs.symlink(victim, link);
			const value = input(snapshot, {
				effectiveSettings: { hideThinkingBlock: true },
				settings: [
					{
						kind: "settings",
						scope: "global",
						values: { hideThinkingBlock: true },
						sourceRefs: ["global/settings.json"],
					},
				],
			});
			const plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd });
			expect(plan.destination.agentDir).toBe(agentDir);
			expect(plan.items.every(item => item.outcome === "lost")).toBe(true);
			expect(plan.losses.some(loss => loss.code === "destination-invalid")).toBe(true);
			expect(plan.preconditions).toHaveLength(0);
			const applied = await applyPrimeDestination(plan, value);
			expect(applied.report.items.every(item => item.outcome === "lost")).toBe(true);
			expect(applied.report.losses.some(loss => loss.code === "destination-invalid")).toBe(true);
			expect(await fs.readdir(victim)).toEqual([]);
		},
	);
	it.skipIf(process.platform === "win32")(
		"rejects a destination whose nearest existing parent is group- or world-writable",
		async () => {
			const root = await temp(),
				snapshot = await sourceSnapshot(root),
				untrustedParent = path.join(root, "untrusted"),
				agentDir = path.join(untrustedParent, "omp");
			await fs.mkdir(untrustedParent, { mode: 0o777 });
			await fs.chmod(untrustedParent, 0o777);
			const value = input(snapshot, {
				effectiveSettings: { hideThinkingBlock: true },
				settings: [
					{
						kind: "settings",
						scope: "global",
						values: { hideThinkingBlock: true },
						sourceRefs: ["global/settings.json"],
					},
				],
			});

			const plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd });
			expect(plan.items).toEqual([
				expect.objectContaining({ itemId: "setting:hideThinkingBlock", outcome: "lost" }),
			]);
			expect(plan.losses).toContainEqual(expect.objectContaining({ code: "destination-invalid" }));
			expect(await fs.stat(agentDir).catch(() => undefined)).toBeUndefined();
		},
	);
	it.skipIf(process.platform === "win32")(
		"rejects an owner-private destination parent beneath an unprotected writable ancestor",
		async () => {
			const root = await temp(),
				snapshot = await sourceSnapshot(root),
				untrustedAncestor = path.join(root, "untrusted"),
				privateParent = path.join(untrustedAncestor, "private"),
				agentDir = path.join(privateParent, "omp");
			await fs.mkdir(privateParent, { recursive: true, mode: 0o700 });
			await fs.chmod(untrustedAncestor, 0o777);
			await fs.chmod(privateParent, 0o700);
			const value = input(snapshot, {
				effectiveSettings: { hideThinkingBlock: true },
				settings: [
					{
						kind: "settings",
						scope: "global",
						values: { hideThinkingBlock: true },
						sourceRefs: ["global/settings.json"],
					},
				],
			});

			const plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd });
			expect(plan.items).toEqual([
				expect.objectContaining({ itemId: "setting:hideThinkingBlock", outcome: "lost" }),
			]);
			expect(plan.losses).toContainEqual(expect.objectContaining({ code: "destination-invalid" }));
			expect(await fs.stat(agentDir).catch(() => undefined)).toBeUndefined();
		},
	);
	it.skipIf(process.platform === "win32")(
		"rejects a foreign-owned higher ancestor beneath a sticky directory",
		async () => {
			const root = await temp(),
				snapshot = await sourceSnapshot(root),
				foreignAncestor = path.join(root, "foreign"),
				privateParent = path.join(foreignAncestor, "private"),
				agentDir = path.join(privateParent, "omp");
			await fs.mkdir(privateParent, { recursive: true, mode: 0o700 });
			await fs.chmod(foreignAncestor, 0o755);
			await fs.chmod(privateParent, 0o700);
			const canonicalForeignAncestor = await fs.realpath(foreignAncestor),
				canonicalRoot = await fs.realpath(root),
				originalLstat = fs.lstat.bind(fs),
				lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
					const stat = await originalLstat(...args);
					if (typeof stat.mode !== "number" || typeof stat.uid !== "number") return stat;
					const resolved = path.resolve(String(args[0])),
						override =
							resolved === canonicalForeignAncestor
								? { uid: process.getuid!() + 1 }
								: resolved === canonicalRoot
									? { mode: (stat.mode & ~0o7777) | 0o1777, uid: 0 }
									: undefined;
					return override ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, override) : stat;
				});
			try {
				const value = input(snapshot, {
						effectiveSettings: { hideThinkingBlock: true },
						settings: [
							{
								kind: "settings",
								scope: "global",
								values: { hideThinkingBlock: true },
								sourceRefs: ["global/settings.json"],
							},
						],
					}),
					plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd });
				expect(plan.items).toEqual([
					expect.objectContaining({ itemId: "setting:hideThinkingBlock", outcome: "lost" }),
				]);
				expect(plan.losses).toContainEqual(expect.objectContaining({ code: "destination-invalid" }));
				expect(await fs.stat(agentDir).catch(() => undefined)).toBeUndefined();
			} finally {
				lstatSpy.mockRestore();
			}
		},
	);
	it("imports safe internal skill symlinks and validates their rollback ownership", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			skillBytes = Buffer.from("---\nname: linked\ndescription: Linked\n---\n\nbody\n");
		const skill = {
			kind: "skill" as const,
			scope: "global" as const,
			name: "linked",
			directorySourceRef: "global/skills/linked",
			frontmatter: { description: "Linked" },
			files: [
				{
					kind: "file" as const,
					relativePath: "SKILL.md",
					sourceRef: "global/skills/linked/SKILL.md",
					mode: 0o600,
					size: skillBytes.byteLength,
					sha256: createHash("sha256").update(skillBytes).digest("hex"),
					contentBase64: skillBytes.toString("base64"),
				},
				{
					kind: "symlink" as const,
					relativePath: "alias.md",
					sourceRef: "global/skills/linked/alias.md",
					mode: 0o600,
					target: "SKILL.md",
				},
			],
		};
		const value = input(snapshot, {}, [skill]),
			plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd }),
			applied = await applyPrimeDestination(plan, value),
			entry = applied.rollbackEntries.find(value => value.itemId === "skill:linked");
		expect(applied.report.items.find(value => value.itemId === "skill:linked")?.outcome).toBe("imported");
		expect(await fs.readlink(path.join(agentDir, "skills", "linked", "alias.md"))).toBe("SKILL.md");
		expect(entry).toBeDefined();
		if (!entry) return;
		expect(await validatePrimeDestinationRollbackEntry(entry, plan.destination)).toBe(true);
		await fs.unlink(path.join(agentDir, "skills", "linked", "alias.md"));
		await fs.symlink("missing.md", path.join(agentDir, "skills", "linked", "alias.md"));
		expect(await validatePrimeDestinationRollbackEntry(entry, plan.destination)).toBe(false);
	});

	it("rejects staged model and skill validation before any destination commit", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			secretTable = new ApplyOnlySecretTable();
		const model: PrimeNormalizedModelOperation = {
			kind: "models",
			modelKind: "definition",
			provider: "broken",
			providerConfig: { api: "openai-completions" },
			model: { id: "one", api: "openai-completions" },
			sourceRefs: ["global/models.json"],
		};
		const badSkill = {
			kind: "skill" as const,
			scope: "global" as const,
			name: "bad",
			directorySourceRef: "global/skills/bad",
			frontmatter: {},
			files: [
				{
					kind: "file" as const,
					relativePath: "SKILL.md",
					sourceRef: "global/skills/bad/SKILL.md",
					mode: 0o600,
					size: 2,
					sha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
					contentBase64: "e30=",
				},
			],
		};
		const value = input(snapshot, { models: [model], operations: [model], secretTable }, [badSkill]);
		const plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd });
		const applied = await applyPrimeDestination(plan, value),
			report = applied.report;
		expect(report.partialApply).toBe(false);
		expect(report.losses.some(loss => loss.code === "destination-apply-failed")).toBe(true);
		expect(await fs.stat(agentDir).catch(() => undefined)).toBeUndefined();
	});

	it("continues configuration-only apply when staged models are invalid", async () => {
		const root = await temp();
		const snapshot = await sourceSnapshot(root);
		const agentDir = path.join(root, "omp");
		const invalidModel: PrimeNormalizedModelOperation = {
			kind: "models",
			modelKind: "definition",
			provider: "broken",
			providerConfig: { api: "openai-completions" },
			model: { id: "one", api: "openai-completions" },
			sourceRefs: ["global/models.json"],
		};
		const validModel: PrimeNormalizedModelOperation = {
			kind: "models",
			modelKind: "definition",
			provider: "local",
			providerConfig: { api: "openai-completions", auth: "none", baseUrl: "http://local" },
			model: { id: "two", api: "openai-completions" },
			sourceRefs: ["global/models.json"],
		};
		const setting = {
			kind: "settings" as const,
			scope: "global" as const,
			values: { hideThinkingBlock: true },
			sourceRefs: ["global/settings.json"],
		};
		const strictValue = input(snapshot, {
			effectiveSettings: setting.values,
			settings: [setting],
			models: [invalidModel, validModel],
			operations: [invalidModel, validModel, setting],
		});
		const strictPlan = await planPrimeDestination(strictValue, { agentDir, cwd: snapshot.cwd });
		const refused = await applyPrimeDestination(strictPlan, strictValue);
		expect(refused.report.losses).toContainEqual(
			expect.objectContaining({ code: "destination-apply-failed", domain: "config" }),
		);
		await expect(fs.stat(path.join(agentDir, "config.yml"))).rejects.toThrow();

		const value: PrimeDestinationInput = { ...strictValue, allowModelLosses: true };
		const plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd });
		const applied = await applyPrimeDestination(plan, value);

		expect(applied.report.losses).toContainEqual(
			expect.objectContaining({ code: "models-invalid-value", domain: "models" }),
		);
		expect(applied.report.losses.some(loss => loss.code === "destination-apply-failed")).toBe(false);
		expect(applied.report.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ itemId: "model:broken:definition:one", outcome: "lost" }),
				expect.objectContaining({ itemId: "model:local:definition:two", outcome: "imported" }),
				expect.objectContaining({ itemId: "setting:hideThinkingBlock", outcome: "imported" }),
			]),
		);
		await expect(fs.stat(path.join(agentDir, "config.yml"))).resolves.toBeDefined();
		expect(await fs.readFile(path.join(agentDir, "models.yml"), "utf8")).toContain("local:");
	});

	it("does not downgrade staging I/O failures to model losses", async () => {
		const root = await temp();
		const snapshot = await sourceSnapshot(root);
		const agentDir = path.join(root, "omp");
		const model: PrimeNormalizedModelOperation = {
			kind: "models",
			modelKind: "definition",
			provider: "local",
			providerConfig: { api: "openai-completions", auth: "none", baseUrl: "http://local" },
			model: { id: "one", api: "openai-completions" },
			sourceRefs: ["global/models.json"],
		};
		const value: PrimeDestinationInput = {
			...input(snapshot, { models: [model], operations: [model] }),
			allowModelLosses: true,
		};
		const plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd });
		const originalWriteFile = fs.writeFile;
		const writeFileSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
			if (
				path.basename(String(args[0])) === "models.yml" &&
				path.basename(path.dirname(String(args[0]))).startsWith(".prime-import-")
			)
				throw Object.assign(new Error("staging write failed"), { code: "ENOSPC" });
			return originalWriteFile(...args);
		});
		try {
			const applied = await applyPrimeDestination(plan, value);
			expect(applied.report.losses).toContainEqual(
				expect.objectContaining({ code: "destination-apply-failed", domain: "config" }),
			);
			expect(applied.report.losses.some(loss => loss.code === "models-invalid-value")).toBe(false);
		} finally {
			writeFileSpy.mockRestore();
		}
	});

	it("redacts literal credentials, lets the atomic insert decide races, and reruns idempotently", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			secret = "never-in-report";
		const table = new ApplyOnlySecretTable(),
			operationId = `credential-${"a".repeat(64)}`;
		table.add(operationId, secret);
		const operation = credential("literal-provider", operationId),
			value = input(snapshot, { credentials: [operation], operations: [operation], secretTable: table });
		const plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd });
		expect(JSON.stringify(plan)).not.toContain(secret);
		const applied = await applyPrimeDestination(plan, value);
		expect(JSON.stringify(applied.report)).not.toContain(secret);
		const rerun = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd });
		expect(rerun.items.find(item => item.itemId === "credential:literal-provider")?.outcome).toBe("planned");
		const second = await applyPrimeDestination(rerun, value);
		expect(second.report.items.find(item => item.itemId === "credential:literal-provider")?.outcome).toBe("skipped");
	});
	it("adds only absent providers while preserving existing credential values", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			dbPath = getAgentDbPath(agentDir),
			secretTable = new ApplyOnlySecretTable(),
			existingId = `credential-${"1".repeat(64)}`,
			absentId = `credential-${"2".repeat(64)}`;
		await fs.mkdir(agentDir, { recursive: true });
		const auth = await AuthStorage.create(dbPath);
		auth.insertCredentialsIfProviderAbsent("existing-provider", [{ type: "api_key", key: "existing-secret" }]);
		auth.close();
		secretTable.add(existingId, "replacement-secret");
		secretTable.add(absentId, "absent-secret");
		const existing = credential("existing-provider", existingId),
			absent = credential("absent-provider", absentId),
			value = input(snapshot, { credentials: [existing, absent], operations: [existing, absent], secretTable }),
			plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd }),
			applied = await applyPrimeDestination(plan, value);
		expect(applied.report.items.find(item => item.itemId === "credential:existing-provider")?.outcome).toBe(
			"skipped",
		);
		expect(applied.report.items.find(item => item.itemId === "credential:absent-provider")?.outcome).toBe("imported");
		const inspected = new Database(dbPath, { readonly: true });
		try {
			const rows = inspected
				.query("SELECT provider, data FROM auth_credentials WHERE provider IN (?, ?) ORDER BY provider")
				.all("absent-provider", "existing-provider") as Array<{ provider: string; data: string }>;
			expect(rows.map(row => row.provider)).toEqual(["absent-provider", "existing-provider"]);
			expect(rows.find(row => row.provider === "existing-provider")?.data).toContain("existing-secret");
			expect(rows.find(row => row.provider === "existing-provider")?.data).not.toContain("replacement-secret");
		} finally {
			inspected.close();
		}
		const entry = applied.rollbackEntries.find(item => item.itemId === "credential:absent-provider");
		expect(entry?.canonicalDestinationRef).toBe(dbPath);
		expect(entry?.currentSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(await validatePrimeDestinationRollbackEntry(entry!, plan.destination)).toBe(true);
	});
	it("keeps credential rollback guards stable across WAL checkpoints", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			dbPath = getAgentDbPath(agentDir),
			secretTable = new ApplyOnlySecretTable(),
			operationId = `credential-${"3".repeat(64)}`;
		await fs.mkdir(agentDir, { recursive: true });
		const liveAuth = await AuthStorage.create(dbPath);
		try {
			liveAuth.insertCredentialsIfProviderAbsent("existing-provider", [{ type: "api_key", key: "existing" }]);
			secretTable.add(operationId, "imported");
			const operation = credential("imported-provider", operationId),
				value = input(snapshot, { credentials: [operation], operations: [operation], secretTable }),
				plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd }),
				applied = await applyPrimeDestination(plan, value),
				entry = applied.rollbackEntries.find(item => item.itemId === "credential:imported-provider");
			expect(entry).toBeDefined();
			expect(await validatePrimeDestinationRollbackEntry(entry!, plan.destination)).toBe(true);
			const checkpoint = new Database(dbPath);
			try {
				checkpoint.run("PRAGMA wal_checkpoint(TRUNCATE)");
			} finally {
				checkpoint.close();
			}
			expect(await validatePrimeDestinationRollbackEntry(entry!, plan.destination)).toBe(true);
		} finally {
			liveAuth.close();
		}
	});

	it("reports source drift before commit and keeps output ordering stable", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			sourcePath = path.join(snapshot.sourceRoot, "settings.json"),
			sourceBytes = Buffer.from("{}\n");
		await fs.writeFile(sourcePath, sourceBytes);
		const sourceStat = await fs.lstat(sourcePath),
			trackedSnapshot: PrimeSourceSnapshot = {
				...snapshot,
				files: [
					{
						kind: "file",
						domain: "config",
						canonicalPath: sourcePath,
						sourceRef: "global/settings.json",
						mode: sourceStat.mode & 0o777,
						mtimeMs: sourceStat.mtimeMs,
						size: sourceBytes.byteLength,
						sha256: createHash("sha256").update(sourceBytes).digest("hex"),
					},
				],
			},
			agentDir = path.join(root, "omp");
		const first = input(trackedSnapshot, {
			effectiveSettings: { hideThinkingBlock: true },
			settings: [
				{
					kind: "settings",
					scope: "global",
					values: { hideThinkingBlock: true },
					sourceRefs: ["global/settings.json"],
				},
			],
		});
		const plan = await planPrimeDestination(first, { agentDir, cwd: trackedSnapshot.cwd });
		await fs.writeFile(sourcePath, '{"changed":true}\n');
		const applied = await applyPrimeDestination(plan, first),
			report = applied.report;
		expect(report.partialApply).toBe(false);
		expect(report.losses.some(loss => loss.code === "source-changed" || loss.code === "source-drift")).toBe(true);
		expect(report.items.map(item => item.itemId)).toEqual([...report.items.map(item => item.itemId)].sort(compare));
	});

	it("terminal-loses every executable item for a symlinked agent directory", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			realAgent = path.join(root, "real-agent"),
			agentDir = path.join(root, "omp");
		await fs.mkdir(realAgent, { recursive: true });
		await fs.symlink(realAgent, agentDir);
		const model: PrimeNormalizedModelOperation = {
			kind: "models",
			modelKind: "definition",
			provider: "local",
			providerConfig: { baseUrl: "http://prime" },
			model: { id: "one", api: "openai-completions" },
			sourceRefs: ["global/models.json"],
		};
		const value = input(
			snapshot,
			{
				effectiveSettings: { hideThinkingBlock: true },
				settings: [
					{
						kind: "settings",
						scope: "global",
						values: { hideThinkingBlock: true },
						sourceRefs: ["global/settings.json"],
					},
				],
				models: [model],
				operations: [model],
			},
			[
				{
					kind: "skill",
					scope: "global",
					name: "skill",
					directorySourceRef: "global/skills/skill",
					frontmatter: {},
					files: [],
				},
			],
		);
		const plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd });
		expect(plan.items.every(item => item.outcome === "lost")).toBe(true);
		expect(plan.preconditions).toHaveLength(0);
		const applied = await applyPrimeDestination(plan, value),
			report = applied.report;
		expect(report.items.every(item => item.outcome === "lost")).toBe(true);
		expect(await fs.readdir(realAgent)).toEqual([]);
	});

	it("loses only skills when the skills root is a symlink", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			foreign = path.join(root, "foreign-skills");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(foreign, { recursive: true });
		await fs.symlink(foreign, path.join(agentDir, "skills"));
		const value = input(
			snapshot,
			{
				effectiveSettings: { hideThinkingBlock: true },
				settings: [
					{
						kind: "settings",
						scope: "global",
						values: { hideThinkingBlock: true },
						sourceRefs: ["global/settings.json"],
					},
				],
			},
			[
				{
					kind: "skill",
					scope: "global",
					name: "skill",
					directorySourceRef: "global/skills/skill",
					frontmatter: {},
					files: [],
				},
			],
		);
		const plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd });
		const applied = await applyPrimeDestination(plan, value),
			report = applied.report;
		expect(report.items.find(item => item.itemId === "setting:hideThinkingBlock")?.outcome).toBe("imported");
		expect(report.items.find(item => item.itemId === "skill:skill")?.outcome).toBe("lost");
		expect(await fs.readdir(foreign)).toEqual([]);
	});

	it("rejects wrong-kind agent and skills destinations without following them", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentFile = path.join(root, "agent-file"),
			agentDir = path.join(root, "omp");
		await fs.writeFile(agentFile, "not a directory");
		const invalidAgent = await planPrimeDestination(
			input(snapshot, { effectiveSettings: { hideThinkingBlock: true } }),
			{ agentDir: agentFile, cwd: snapshot.cwd },
		);
		expect(invalidAgent.items.every(item => item.outcome === "lost")).toBe(true);
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(path.join(agentDir, "skills"), "not a directory");
		const value = input(
			snapshot,
			{
				effectiveSettings: { hideThinkingBlock: true },
				settings: [
					{
						kind: "settings",
						scope: "global",
						values: { hideThinkingBlock: true },
						sourceRefs: ["global/settings.json"],
					},
				],
			},
			[
				{
					kind: "skill",
					scope: "global",
					name: "skill",
					directorySourceRef: "global/skills/skill",
					frontmatter: {},
					files: [],
				},
			],
		);
		const plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd });
		expect(plan.items.find(item => item.itemId === "skill:skill")?.outcome).toBe("lost");
		expect(plan.items.find(item => item.itemId === "setting:hideThinkingBlock")?.outcome).toBe("planned");
		const report = (await applyPrimeDestination(plan, value)).report;
		expect(report.items.find(item => item.itemId === "setting:hideThinkingBlock")?.outcome).toBe("imported");
	});
	it("rejects a mismatched plan input instead of converting it to apply failure", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			value = input(snapshot, { effectiveSettings: { hideThinkingBlock: true } }),
			plan = await planPrimeDestination(value, { agentDir: path.join(root, "omp"), cwd: snapshot.cwd });
		await expect(
			applyPrimeDestination(plan, { ...value, snapshot: { ...snapshot, snapshotId: "different" } }),
		).rejects.toThrow("plan input mismatch");
		await expect(applyPrimeDestination(plan, { ...value, allowModelLosses: true })).rejects.toThrow(
			"plan input mismatch",
		);
		await expect(applyPrimeDestination(plan, { ...value, sourceDomains: ["config"] })).rejects.toThrow(
			"plan input mismatch",
		);
	});

	it("keeps valid-payload invalid skills separate from model validation", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			bytes = Buffer.from("{}\n"),
			skill = {
				kind: "skill" as const,
				scope: "global" as const,
				name: "invalid",
				directorySourceRef: "global/skills/invalid",
				frontmatter: {},
				files: [
					{
						kind: "file" as const,
						relativePath: "SKILL.md",
						sourceRef: "global/skills/invalid/SKILL.md",
						mode: 0o600,
						size: bytes.byteLength,
						sha256: createHash("sha256").update(bytes).digest("hex"),
						contentBase64: bytes.toString("base64"),
					},
				],
			};
		const value = input(snapshot, {}, [skill]),
			plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd }),
			applied = await applyPrimeDestination(plan, value),
			report = applied.report;
		expect(report.partialApply).toBe(false);
		expect(report.losses.some(loss => loss.code === "destination-apply-failed")).toBe(true);
		expect(await fs.stat(agentDir).catch(() => undefined)).toBeUndefined();
	});

	it.skipIf(process.platform === "win32")(
		"does not write a credential to a database replaced between preflight and writable open",
		async () => {
			const root = await temp(),
				snapshot = await sourceSnapshot(root),
				agentDir = path.join(root, "omp"),
				dbPath = getAgentDbPath(agentDir),
				backupPath = path.join(root, "original.db"),
				attackerPath = path.join(root, "attacker.db"),
				secretTable = new ApplyOnlySecretTable(),
				operationId = `credential-${"f".repeat(64)}`;
			await fs.mkdir(agentDir, { recursive: true });
			const original = await AuthStorage.create(dbPath);
			original.close();
			const attacker = await AuthStorage.create(attackerPath);
			attacker.close();
			secretTable.add(operationId, "replacement-secret");
			const operation = credential("replacement-provider", operationId),
				value = input(snapshot, { credentials: [operation], operations: [operation], secretTable }),
				plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd }),
				originalCreate = AuthStorage.createExisting;
			let raced = false;
			const createSpy = vi
				.spyOn(AuthStorage, "createExisting")
				.mockImplementation(async (target, options, expected) => {
					if (!raced && path.resolve(target) === path.resolve(dbPath)) {
						raced = true;
						await fs.rename(target, backupPath);
						await fs.rename(attackerPath, target);
					}
					return originalCreate(target, options, expected);
				});
			try {
				const applied = await applyPrimeDestination(plan, value),
					reported = applied.report.items.find(item => item.itemId === "credential:replacement-provider");
				expect(raced).toBe(true);
				expect(reported?.outcome).toBe("lost");
				expect(applied.report.losses.some(item => item.code === "destination-invalid")).toBe(true);
			} finally {
				createSpy.mockRestore();
			}
			for (const candidate of [dbPath, backupPath]) {
				const inspected = new Database(`file:${candidate}?immutable=1`, { readonly: true });
				try {
					expect(
						inspected.query("SELECT 1 FROM auth_credentials WHERE provider = ?").get("replacement-provider"),
					).toBeNull();
				} finally {
					inspected.close();
				}
			}
		},
	);

	it("preserves a model target created after the final precondition check", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			model: PrimeNormalizedModelOperation = {
				kind: "models",
				modelKind: "definition",
				provider: "raced-provider",
				model: { id: "raced-model", api: "openai-completions" },
				providerConfig: { api: "openai-completions", auth: "none", baseUrl: "http://local" },
				sourceRefs: ["global/models.json"],
			},
			value = input(snapshot, { models: [model], operations: [model] }),
			plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd }),
			originalLink = fs.link;
		let raced = false;
		const linkSpy = vi.spyOn(fs, "link").mockImplementation(async (...args: Parameters<typeof fs.link>) => {
			const [source, destination] = args;
			if (!raced && path.resolve(String(destination)) === path.resolve(plan.destination.modelsPath)) {
				raced = true;
				await fs.writeFile(destination, "attacker-model\n");
			}
			return originalLink(source, destination);
		});
		try {
			const applied = await applyPrimeDestination(plan, value),
				reported = applied.report.items.find(item => item.itemId === "model:raced-provider:definition:raced-model");
			expect(raced).toBe(true);
			expect(reported?.outcome).toBe("lost");
			expect(applied.report.losses.some(item => item.code === "destination-drift")).toBe(true);
			expect(await fs.readFile(plan.destination.modelsPath, "utf8")).toBe("attacker-model\n");
		} finally {
			linkSpy.mockRestore();
		}
	});

	it.skipIf(process.platform === "win32")(
		"preserves a nested skill symlink raced immediately before the leaf open",
		async () => {
			const root = await temp(),
				snapshot = await sourceSnapshot(root),
				agentDir = path.join(root, "omp"),
				foreign = path.join(root, "foreign"),
				skillBytes = Buffer.from("---\nname: raced\ndescription: Raced\n---\n\nbody\n"),
				nestedBytes = Buffer.from("nested\n"),
				skill = {
					kind: "skill" as const,
					scope: "global" as const,
					name: "raced",
					directorySourceRef: "global/skills/raced",
					frontmatter: { description: "Raced" },
					files: [
						{
							kind: "directory" as const,
							relativePath: "nested",
							sourceRef: "global/skills/raced/nested",
							mode: 0o700,
						},
						{
							kind: "file" as const,
							relativePath: "nested/data.txt",
							sourceRef: "global/skills/raced/nested/data.txt",
							mode: 0o600,
							size: nestedBytes.byteLength,
							sha256: createHash("sha256").update(nestedBytes).digest("hex"),
							contentBase64: nestedBytes.toString("base64"),
						},
						{
							kind: "file" as const,
							relativePath: "SKILL.md",
							sourceRef: "global/skills/raced/SKILL.md",
							mode: 0o600,
							size: skillBytes.byteLength,
							sha256: createHash("sha256").update(skillBytes).digest("hex"),
							contentBase64: skillBytes.toString("base64"),
						},
					],
				},
				value = input(snapshot, {}, [skill]),
				plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd }),
				destinationNested = path.join(plan.destination.skillsRoot, "raced", "nested"),
				destinationLeaf = path.join(destinationNested, "data.txt"),
				originalOpen = fs.open;
			let raced = false;
			await fs.mkdir(foreign, { recursive: true });
			const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
				if (!raced && path.resolve(String(args[0])) === path.resolve(destinationLeaf)) {
					raced = true;
					await fs.rm(destinationNested, { recursive: true, force: true });
					await fs.symlink(foreign, destinationNested);
				}
				return originalOpen(...args);
			});
			try {
				const applied = await applyPrimeDestination(plan, value),
					reported = applied.report.items.find(item => item.itemId === "skill:raced");
				expect(raced).toBe(true);
				expect(reported?.outcome).toBe("lost");
				expect(applied.report.losses.some(item => item.code === "destination-apply-failed")).toBe(true);
				expect((await fs.lstat(destinationNested)).isSymbolicLink()).toBe(true);
				expect(await fs.readdir(foreign)).toEqual([]);
			} finally {
				openSpy.mockRestore();
			}
		},
	);

	it("serializes concurrent credential contenders with one winner", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			table = new ApplyOnlySecretTable(),
			id = `credential-${"b".repeat(64)}`;
		table.add(id, "redacted-secret");
		const operation = credential("concurrent-provider", id),
			value = input(snapshot, { credentials: [operation], operations: [operation], secretTable: table }),
			plan = await planPrimeDestination(value, { agentDir: path.join(root, "omp"), cwd: snapshot.cwd });
		const results = await Promise.all([applyPrimeDestination(plan, value), applyPrimeDestination(plan, value)]),
			reports = results.map(result => result.report);
		expect(
			reports
				.map(report => report.items.find(item => item.itemId === "credential:concurrent-provider")?.outcome)
				.sort(),
		).toEqual(["imported", "skipped"]);
		expect(JSON.stringify(reports)).not.toContain("redacted-secret");
	});

	it("orders multi-item results identically for permuted source operations", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			modelA: PrimeNormalizedModelOperation = {
				kind: "models",
				modelKind: "definition",
				provider: "a",
				model: { id: "one", api: "openai-completions" },
				sourceRefs: ["global/models-a.json"],
			},
			modelB: PrimeNormalizedModelOperation = {
				kind: "models",
				modelKind: "definition",
				provider: "b",
				model: { id: "two", api: "openai-completions" },
				sourceRefs: ["global/models-b.json"],
			};
		const first = input(snapshot, { models: [modelA, modelB], operations: [modelA, modelB] }),
			second = input(snapshot, { models: [modelB, modelA], operations: [modelB, modelA] }),
			firstPlan = await planPrimeDestination(first, { agentDir: path.join(root, "one"), cwd: snapshot.cwd }),
			secondPlan = await planPrimeDestination(second, { agentDir: path.join(root, "two"), cwd: snapshot.cwd });
		expect(firstPlan.items).toEqual(secondPlan.items);
		expect(firstPlan.losses).toEqual(secondPlan.losses);
	});
	it("captures shared-model rollback digests before publication", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp");
		const model = (id: string): PrimeNormalizedModelOperation => ({
			kind: "models",
			modelKind: "definition",
			provider: "local",
			providerConfig: { baseUrl: "http://local", api: "openai-completions", auth: "none" },
			model: { id, api: "openai-completions" },
			sourceRefs: ["global/models.json"],
		});
		const models = [model("one"), model("two")],
			value = input(snapshot, { models, operations: models }),
			plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd }),
			fault = Object.assign(new Error("post-publication models digest fault"), { code: "EIO" });
		let injected = false,
			published = false;
		const originalOpen = fs.open,
			originalRename = fs.rename,
			renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (...args: Parameters<typeof fs.rename>) => {
				await originalRename(...args);
				if (path.resolve(String(args[1])) === path.resolve(plan.destination.modelsPath)) published = true;
			}),
			openSpy = vi.spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
				if (published && path.resolve(String(args[0])) === path.resolve(plan.destination.modelsPath)) {
					injected = true;
					throw fault;
				}
				return originalOpen(...args);
			}) as typeof fs.open);
		let applied: PrimeDestinationApplyResult | undefined;
		try {
			applied = await applyPrimeDestination(plan, value);
		} catch {
			// A post-publication fault may still reject; the invariant is durable state accounting.
		} finally {
			openSpy.mockRestore();
			renameSpy.mockRestore();
		}
		expect(injected).toBe(false);
		const rollbackEntries = applied?.rollbackEntries.filter(entry => entry.kind === "models") ?? [];
		expect(rollbackEntries).toHaveLength(models.length);
		expect(await fs.stat(plan.destination.modelsPath).then(stat => stat.isFile())).toBe(true);
	});

	it("captures skill-tree rollback digests before publication", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			bytes = Buffer.from("---\nname: faulty\ndescription: Faulty\n---\n\nbody\n"),
			skill = {
				kind: "skill" as const,
				scope: "global" as const,
				name: "faulty",
				directorySourceRef: "global/skills/faulty",
				frontmatter: { description: "Faulty" },
				files: [
					{
						kind: "file" as const,
						relativePath: "SKILL.md",
						sourceRef: "global/skills/faulty/SKILL.md",
						mode: 0o600,
						size: bytes.byteLength,
						sha256: createHash("sha256").update(bytes).digest("hex"),
						contentBase64: bytes.toString("base64"),
					},
				],
			},
			value = input(snapshot, {}, [skill]),
			plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd }),
			skillPath = path.join(plan.destination.skillsRoot, skill.name, "SKILL.md"),
			skillDirectory = path.dirname(skillPath),
			fault = Object.assign(new Error("post-publication skill tree digest fault"), { code: "EIO" });
		let injected = false;
		const originalOpen = fs.open;
		const openSpy = vi.spyOn(fs, "open").mockImplementation((async (...args: Parameters<typeof fs.open>) => {
			const flags = Number(args[1]);
			const writeMask = fsSync.constants.O_WRONLY | fsSync.constants.O_RDWR;
			if (path.resolve(String(args[0])) === path.resolve(skillPath) && (flags & writeMask) === 0) {
				injected = true;
				throw fault;
			}
			return originalOpen(...args);
		}) as typeof fs.open);
		let applied: PrimeDestinationApplyResult | undefined;
		try {
			applied = await applyPrimeDestination(plan, value);
		} catch {
			// A post-publication fault may still reject; the invariant is durable state accounting.
		} finally {
			openSpy.mockRestore();
		}
		expect(injected).toBe(false);
		expect(applied?.rollbackEntries.find(entry => entry.itemId === "skill:faulty")).toBeDefined();
		expect(await fs.stat(skillDirectory).then(stat => stat.isDirectory())).toBe(true);
	});
	it("returns committed rollback evidence after an unexpected post-publication fault", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			bytes = Buffer.from("---\nname: later\ndescription: Later\n---\n\nbody\n"),
			model: PrimeNormalizedModelOperation = {
				kind: "models",
				modelKind: "definition",
				provider: "local",
				providerConfig: { api: "openai-completions", auth: "none", baseUrl: "http://local" },
				model: { id: "first", api: "openai-completions" },
				sourceRefs: ["global/models.json"],
			},
			skill = {
				kind: "skill" as const,
				scope: "global" as const,
				name: "later",
				directorySourceRef: "global/skills/later",
				frontmatter: { description: "Later" },
				files: [
					{
						kind: "file" as const,
						relativePath: "SKILL.md",
						sourceRef: "global/skills/later/SKILL.md",
						mode: 0o600,
						size: bytes.byteLength,
						sha256: createHash("sha256").update(bytes).digest("hex"),
						contentBase64: bytes.toString("base64"),
					},
				],
			},
			value = input(snapshot, { models: [model], operations: [model] }, [skill]),
			plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd });
		let published = false;
		const originalLink = fs.link,
			originalMkdir = fs.mkdir,
			linkSpy = vi.spyOn(fs, "link").mockImplementation(async (...args: Parameters<typeof fs.link>) => {
				await originalLink(...args);
				if (path.resolve(String(args[1])) === path.resolve(plan.destination.modelsPath)) published = true;
			}),
			mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation((async (...args: Parameters<typeof fs.mkdir>) => {
				if (published && path.resolve(String(args[0])) === path.resolve(plan.destination.skillsRoot))
					throw new Error("unexpected post-publication fault");
				return originalMkdir(...args);
			}) as typeof fs.mkdir);
		try {
			const applied = await applyPrimeDestination(plan, value);
			expect(applied.report.partialApply).toBe(true);
			expect(applied.report.losses).toContainEqual(
				expect.objectContaining({ code: "destination-apply-failed", sourceRef: "destination" }),
			);
			expect(applied.report.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ itemId: "model:local:definition:first", outcome: "imported" }),
					expect.objectContaining({
						itemId: "skill:later",
						outcome: "lost",
						lossCodes: expect.arrayContaining(["destination-apply-failed"]),
					}),
				]),
			);
			expect(applied.rollbackEntries).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ itemId: "model:local:definition:first", kind: "models" }),
				]),
			);
		} finally {
			linkSpy.mockRestore();
			mkdirSpy.mockRestore();
		}
	});

	it("creates item-scoped rollback guards and validates live ownership", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			secretTable = new ApplyOnlySecretTable(),
			secretA = `credential-${"a".repeat(64)}`,
			secretB = `credential-${"b".repeat(64)}`,
			modelA: PrimeNormalizedModelOperation = {
				kind: "models",
				modelKind: "definition",
				provider: "local",
				providerConfig: { baseUrl: "http://local", api: "openai-completions", auth: "none" },
				model: {
					id: "one",
					name: "One",
					api: "openai-completions",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32_768,
					maxTokens: 4_096,
				},
				sourceRefs: ["global/models.json"],
			},
			modelB: PrimeNormalizedModelOperation = {
				kind: "models",
				modelKind: "definition",
				provider: "local",
				providerConfig: { baseUrl: "http://local", api: "openai-completions", auth: "none" },
				model: {
					id: "two",
					name: "Two",
					api: "openai-completions",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 32_768,
					maxTokens: 4_096,
				},
				sourceRefs: ["global/models.json"],
			},
			credentialA = credential("provider-a", secretA),
			credentialB = credential("provider-b", secretB),
			skillBytes = Buffer.from("---\nname: exact\ndescription: Exact\n---\n\nbody\n"),
			skill = {
				kind: "skill" as const,
				scope: "global" as const,
				name: "exact",
				directorySourceRef: "global/skills/exact",
				frontmatter: { description: "Exact" },
				files: [
					{
						kind: "file" as const,
						relativePath: "SKILL.md",
						sourceRef: "global/skills/exact/SKILL.md",
						mode: 0o600,
						size: skillBytes.byteLength,
						sha256: createHash("sha256").update(skillBytes).digest("hex"),
						contentBase64: skillBytes.toString("base64"),
					},
				],
			};
		secretTable.add(secretA, "key-a");
		secretTable.add(secretB, "key-b");
		const value = input(
			snapshot,
			{
				effectiveSettings: { hideThinkingBlock: true, "retry.enabled": true },
				settings: [
					{
						kind: "settings",
						scope: "global",
						values: { hideThinkingBlock: true, "retry.enabled": true },
						sourceRefs: ["global/settings.json"],
					},
				],
				models: [modelA, modelB],
				credentials: [credentialA, credentialB],
				operations: [modelA, modelB, credentialA, credentialB],
				secretTable,
			},
			[skill],
		);
		const plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd }),
			applied = await applyPrimeDestination(plan, value),
			entries = applied.rollbackEntries;
		expect(applied.report.losses).toEqual([]);
		expect(entries.map(entry => entry.itemId)).toEqual([
			"credential:provider-a",
			"credential:provider-b",
			"model:local:definition:one",
			"model:local:definition:two",
			"setting:hideThinkingBlock",
			"setting:retry.enabled",
			"skill:exact",
		]);
		expect(entries.every(entry => entry.destinationRef === entry.itemId && entry.created && !entry.priorExists)).toBe(
			true,
		);
		expect(
			await Promise.all(entries.map(entry => validatePrimeDestinationRollbackEntry(entry, plan.destination))),
		).toEqual([true, true, true, true, true, true, true]);
		const first = entries[0];
		expect(first).toBeDefined();
		if (!first) return;
		expect(
			await validatePrimeDestinationRollbackEntry(
				{ ...first, itemId: "credential:forged-provider" },
				plan.destination,
			),
		).toBe(false);
		expect(
			await validatePrimeDestinationRollbackEntry(
				{ ...first, canonicalDestinationRef: path.join(root, "outside.db") },
				plan.destination,
			),
		).toBe(false);
		await fs.appendFile(plan.destination.modelsPath, "# live mutation\n");
		const modelEntry = entries.find(entry => entry.kind === "models");
		expect(modelEntry).toBeDefined();
		if (modelEntry) expect(await validatePrimeDestinationRollbackEntry(modelEntry, plan.destination)).toBe(false);
	});
	it("loses forged invalid provider identifiers before creating destination state", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			secretTable = new ApplyOnlySecretTable(),
			credentialOperations = ["", " \t", "provider\0"].map((provider, index) => {
				const id = `credential-${index.toString(16).padStart(64, "0")}`;
				secretTable.add(id, "secret");
				return credential(provider, id);
			}),
			modelOperations: PrimeNormalizedModelOperation[] = ["", "bad\nprovider", "x:definition:y", "x:override:y"].map(
				provider => ({
					kind: "models",
					modelKind: "definition",
					provider,
					model: { id: "model", api: "openai-completions" },
					sourceRefs: ["global/models.json"],
				}),
			),
			value = input(snapshot, {
				models: modelOperations,
				credentials: credentialOperations,
				operations: [...modelOperations, ...credentialOperations],
				secretTable,
			}),
			plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd });
		expect(plan.items.filter(item => item.kind === "models").every(item => item.outcome === "lost")).toBe(true);
		expect(
			plan.items
				.filter(item => item.kind === "models")
				.every(item => item.lossCodes?.includes("models-invalid-value")),
		).toBe(true);
		expect(
			plan.items
				.filter(item => item.kind === "credentials")
				.every(item => item.lossCodes?.includes("credentials-unknown")),
		).toBe(true);
		const applied = await applyPrimeDestination(plan, value);
		expect(applied.report.partialApply).toBe(false);
		expect(applied.rollbackEntries).toEqual([]);
		expect(await fs.stat(agentDir).catch(() => undefined)).toBeUndefined();
	});
	it("preserves legacy models.json through a side-effect-free YAML migration", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			legacy = {
				providers: {
					local: {
						baseUrl: "http://legacy",
						auth: "none",
						models: [{ id: "legacy-model", api: "openai-completions" }],
					},
				},
			};
		await fs.mkdir(agentDir, { recursive: true });
		const legacyPath = path.join(agentDir, "models.json");
		await fs.writeFile(legacyPath, JSON.stringify(legacy));
		const operation: PrimeNormalizedModelOperation = {
			kind: "models",
			modelKind: "definition",
			provider: "local",
			providerConfig: { baseUrl: "http://legacy", auth: "none" },
			model: { id: "new-model", api: "openai-completions" },
			sourceRefs: ["global/models.json"],
		};
		const value = input(snapshot, { models: [operation], operations: [operation] }),
			plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd });
		expect(await fs.stat(path.join(agentDir, "models.yml")).catch(() => undefined)).toBeUndefined();
		expect(plan.items.find(item => item.itemId === "model:local:definition:new-model")?.outcome).toBe("planned");
		const modelPreconditions = plan.preconditions.filter(precondition => precondition.kind === "models");
		expect(modelPreconditions.map(precondition => precondition.destinationRef)).toEqual([
			path.join(plan.destination.agentDir, "models.yml"),
			path.join(plan.destination.agentDir, "models.yaml"),
			path.join(plan.destination.agentDir, "models.jsonc"),
			path.join(plan.destination.agentDir, "models.json"),
		]);
		expect(modelPreconditions[3]?.sha256).toBe(createHash("sha256").update(JSON.stringify(legacy)).digest("hex"));
		const applied = await applyPrimeDestination(plan, value),
			text = await fs.readFile(path.join(agentDir, "models.yml"), "utf8");
		expect(applied.report.items.find(item => item.itemId === "model:local:definition:new-model")?.outcome).toBe(
			"imported",
		);
		expect(text).toContain("legacy-model");
		expect(text).toContain("new-model");
		expect(await fs.readFile(legacyPath, "utf8")).toBe(JSON.stringify(legacy));
	});

	it("reports corrupt agent.db credentials without throwing or mutating the database", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			secretTable = new ApplyOnlySecretTable(),
			operationId = `credential-${"c".repeat(64)}`;
		secretTable.add(operationId, "secret");
		const dbPath = getAgentDbPath(agentDir);
		await fs.mkdir(path.dirname(dbPath), { recursive: true });
		await fs.writeFile(dbPath, "not sqlite");
		const operation = credential("corrupt-db-provider", operationId),
			value = input(snapshot, { credentials: [operation], operations: [operation], secretTable }),
			plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd });
		expect(plan.items.find(item => item.itemId === "credential:corrupt-db-provider")?.lossCodes).toContain(
			"destination-invalid",
		);
		const applied = await applyPrimeDestination(plan, value);
		expect(applied.report.items.find(item => item.itemId === "credential:corrupt-db-provider")?.outcome).toBe("lost");
		expect(applied.report.losses.some(item => item.code === "destination-invalid")).toBe(true);
		expect(await fs.readFile(dbPath, "utf8")).toBe("not sqlite");
	});
	it.skipIf(process.platform === "win32")(
		"terminal-loses credentials when an SQLite companion is a symlink and agent.db is absent",
		async () => {
			for (const companion of ["agent.db-wal", "agent.db-shm", "agent.db-journal"]) {
				const root = await temp(),
					snapshot = await sourceSnapshot(root),
					agentDir = path.join(root, "omp"),
					dbPath = getAgentDbPath(agentDir),
					companionPath = path.join(path.dirname(dbPath), companion),
					externalPath = path.join(root, `${companion}.external`),
					externalBytes = Buffer.from(`${companion} must remain untouched\n`),
					secretTable = new ApplyOnlySecretTable(),
					operationId = `credential-${"d".repeat(64)}`;
				await fs.mkdir(agentDir, { recursive: true });
				await fs.writeFile(externalPath, externalBytes);
				await fs.symlink(externalPath, companionPath);
				secretTable.add(operationId, "companion-secret");
				const operation = credential(`companion-${companion}`, operationId),
					value = input(snapshot, { credentials: [operation], operations: [operation], secretTable }),
					plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd }),
					planned = plan.items.find(item => item.itemId === `credential:companion-${companion}`);
				expect(planned?.outcome).toBe("lost");
				expect(planned?.lossCodes).toContain("destination-invalid");
				expect(plan.preconditions).toHaveLength(0);
				const applied = await applyPrimeDestination(plan, value),
					reported = applied.report.items.find(item => item.itemId === `credential:companion-${companion}`),
					linkStat = await fs.lstat(companionPath);
				expect(reported?.outcome).toBe("lost");
				expect(applied.report.partialApply).toBe(false);
				expect(applied.report.losses.some(loss => loss.code === "destination-invalid")).toBe(true);
				expect(await fs.lstat(dbPath).catch(() => undefined)).toBeUndefined();
				expect(linkStat.isSymbolicLink()).toBe(true);
				expect(await fs.readlink(companionPath)).toBe(externalPath);
				expect(await fs.readFile(externalPath)).toEqual(externalBytes);
			}
		},
	);

	it("terminal-loses credentials when a valid agent.db has an external hardlink", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			dbPath = getAgentDbPath(agentDir),
			externalPath = path.join(root, "agent.db.external"),
			secretTable = new ApplyOnlySecretTable(),
			operationId = `credential-${"e".repeat(64)}`;
		await fs.mkdir(agentDir, { recursive: true });
		const authStorage = await AuthStorage.create(dbPath);
		authStorage.close();
		const originalBytes = await fs.readFile(dbPath);
		await fs.link(dbPath, externalPath);
		secretTable.add(operationId, "hardlink-secret");
		const operation = credential("hardlink-provider", operationId),
			value = input(snapshot, { credentials: [operation], operations: [operation], secretTable }),
			plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd }),
			planned = plan.items.find(item => item.itemId === "credential:hardlink-provider");
		expect((await fs.lstat(dbPath)).nlink).toBeGreaterThan(1);
		expect(planned?.outcome).toBe("lost");
		expect(planned?.lossCodes).toContain("destination-invalid");
		expect(plan.preconditions).toHaveLength(0);
		const applied = await applyPrimeDestination(plan, value),
			reported = applied.report.items.find(item => item.itemId === "credential:hardlink-provider");
		expect(reported?.outcome).toBe("lost");
		expect(applied.report.partialApply).toBe(false);
		expect(applied.report.losses.some(loss => loss.code === "destination-invalid")).toBe(true);
		expect(await fs.readFile(dbPath)).toEqual(originalBytes);
		expect(await fs.readFile(externalPath)).toEqual(originalBytes);
		expect((await fs.lstat(dbPath)).nlink).toBeGreaterThan(1);
	});

	it("reports malformed config.yml without throwing or writing settings", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			configPath = path.join(agentDir, "config.yml");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(configPath, "hideThinkingBlock: [\n");
		const value = input(snapshot, {
				effectiveSettings: { hideThinkingBlock: true },
				settings: [
					{
						kind: "settings",
						scope: "global",
						values: { hideThinkingBlock: true },
						sourceRefs: ["global/settings.json"],
					},
				],
			}),
			plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd });
		expect(plan.items.find(item => item.itemId === "setting:hideThinkingBlock")?.outcome).toBe("lost");
		expect(plan.items.find(item => item.itemId === "setting:hideThinkingBlock")?.lossCodes).toContain(
			"destination-invalid",
		);
		const applied = await applyPrimeDestination(plan, value);
		expect(applied.report.items.find(item => item.itemId === "setting:hideThinkingBlock")?.outcome).toBe("lost");
		expect(await fs.readFile(configPath, "utf8")).toBe("hideThinkingBlock: [\n");
	});
	it.skipIf(process.platform === "win32")(
		"terminal-loses settings when config.yml is a symlink outside the destination",
		async () => {
			const root = await temp(),
				snapshot = await sourceSnapshot(root),
				agentDir = path.join(root, "omp"),
				configPath = path.join(agentDir, "config.yml"),
				externalConfig = path.join(root, "external-config.yml"),
				externalBytes = "{}\n";
			await fs.mkdir(agentDir, { recursive: true });
			await fs.writeFile(externalConfig, externalBytes);
			await fs.symlink(externalConfig, configPath);
			const value = input(snapshot, {
					effectiveSettings: { hideThinkingBlock: true },
					settings: [
						{
							kind: "settings",
							scope: "global",
							values: { hideThinkingBlock: true },
							sourceRefs: ["global/settings.json"],
						},
					],
				}),
				plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd });
			expect(plan.items.find(item => item.itemId === "setting:hideThinkingBlock")?.outcome).toBe("lost");
			expect(plan.items.find(item => item.itemId === "setting:hideThinkingBlock")?.lossCodes).toContain(
				"destination-invalid",
			);
			expect(plan.preconditions).toHaveLength(0);
			const applied = await applyPrimeDestination(plan, value);
			expect(applied.report.items.find(item => item.itemId === "setting:hideThinkingBlock")?.outcome).toBe("lost");
			expect(await fs.readFile(externalConfig, "utf8")).toBe(externalBytes);
			expect(await fs.readlink(configPath)).toBe(externalConfig);
			expect(await fs.readdir(agentDir)).toEqual(["config.yml"]);
		},
	);
	it("terminal-loses settings when config.yml becomes unreadable before precondition revalidation", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			configPath = path.join(agentDir, "config.yml"),
			value = input(snapshot, {
				effectiveSettings: { hideThinkingBlock: true },
				settings: [
					{
						kind: "settings",
						scope: "global",
						values: { hideThinkingBlock: true },
						sourceRefs: ["global/settings.json"],
					},
				],
			}),
			plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd });
		expect(plan.items.find(item => item.itemId === "setting:hideThinkingBlock")?.outcome).toBe("planned");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(configPath, "hideThinkingBlock: [\n");
		const applied = await applyPrimeDestination(plan, value);
		expect(applied.report.items.find(item => item.itemId === "setting:hideThinkingBlock")?.outcome).toBe("lost");
		expect(applied.report.items.find(item => item.itemId === "setting:hideThinkingBlock")?.lossCodes).toContain(
			"destination-invalid",
		);
		expect(await fs.readFile(configPath, "utf8")).toBe("hideThinkingBlock: [\n");
	});
	it("rejects a split-read model path swap instead of publishing parser-only bytes", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			modelsPath = path.join(agentDir, "models.yml"),
			model: PrimeNormalizedModelOperation = {
				kind: "models",
				modelKind: "definition",
				provider: "split-read-provider",
				model: { id: "split-read-model", api: "openai-completions" },
				sourceRefs: ["global/models.json"],
			};
		await fs.mkdir(agentDir, { recursive: true });
		const bytesA = Buffer.from(
				"providers:\n  split-read-provider:\n    baseUrl: http://parser-a\n    auth: none\n    models: []\n",
			),
			bytesB = Buffer.from(
				"providers:\n  split-read-provider:\n    baseUrl: http://parser-b\n    auth: none\n    models: []\n",
			),
			realReadFileSync = fsSync.readFileSync.bind(fsSync),
			readFileSyncSpy = vi.spyOn(fsSync, "readFileSync").mockImplementation(((file, options) => {
				if (String(file) === modelsPath) return bytesB.toString("utf8") as never;
				return realReadFileSync(file as never, options as never) as never;
			}) as typeof fsSync.readFileSync);
		try {
			await fs.writeFile(modelsPath, bytesA);
			const value = input(snapshot, { models: [model], operations: [model] }),
				plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd }),
				applied = await applyPrimeDestination(plan, value),
				item = applied.report.items.find(
					entry => entry.itemId === "model:split-read-provider:definition:split-read-model",
				);
			if (item?.outcome === "imported") {
				expect(await fs.readFile(modelsPath, "utf8")).not.toContain("http://parser-b");
			} else {
				expect(
					applied.report.losses.some(
						loss => loss.code === "destination-drift" || loss.code === "destination-invalid",
					),
				).toBe(true);
			}
		} finally {
			readFileSyncSpy.mockRestore();
		}
	});
	it("rejects literal credentials when agentDir is group/world writable", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			secretTable = new ApplyOnlySecretTable(),
			operationId = `credential-${"a".repeat(64)}`;
		await fs.mkdir(agentDir, { recursive: true, mode: 0o777 });
		await fs.chmod(agentDir, 0o777);
		secretTable.add(operationId, "mode-dir-secret");
		const operation = credential("mode-dir-provider", operationId),
			value = input(snapshot, { credentials: [operation], operations: [operation], secretTable }),
			plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd }),
			applied = await applyPrimeDestination(plan, value),
			item = applied.report.items.find(entry => entry.itemId === "credential:mode-dir-provider");
		expect(item?.outcome).toBe("lost");
		expect(item?.lossCodes).toContain("destination-invalid");
		expect(applied.report.losses.some(loss => loss.code === "destination-invalid")).toBe(true);
		expect(await fs.lstat(getAgentDbPath(agentDir)).catch(() => undefined)).toBeUndefined();
	});
	it("rejects literal credentials when agent.db is group/world writable", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			dbPath = getAgentDbPath(agentDir),
			secretTable = new ApplyOnlySecretTable(),
			operationId = `credential-${"b".repeat(64)}`;
		await fs.mkdir(agentDir, { recursive: true });
		const authStorage = await AuthStorage.create(dbPath);
		authStorage.close();
		await fs.chmod(dbPath, 0o666);
		const before = await fs.readFile(dbPath);
		secretTable.add(operationId, "mode-db-secret");
		const operation = credential("mode-db-provider", operationId),
			value = input(snapshot, { credentials: [operation], operations: [operation], secretTable }),
			plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd }),
			applied = await applyPrimeDestination(plan, value),
			item = applied.report.items.find(entry => entry.itemId === "credential:mode-db-provider");
		expect(item?.outcome).toBe("lost");
		expect(item?.lossCodes).toContain("destination-invalid");
		expect(applied.report.losses.some(loss => loss.code === "destination-invalid")).toBe(true);
		expect(await fs.readFile(dbPath)).toEqual(before);
	});
	it("accounts for every provider when a later credential insert fails", async () => {
		const root = await temp(),
			snapshot = await sourceSnapshot(root),
			agentDir = path.join(root, "omp"),
			dbPath = getAgentDbPath(agentDir),
			secretTable = new ApplyOnlySecretTable(),
			firstId = `credential-${"c".repeat(64)}`,
			secondId = `credential-${"d".repeat(64)}`;
		await fs.mkdir(agentDir, { recursive: true });
		const authStorage = await AuthStorage.create(dbPath);
		authStorage.close();
		const before = await fs.readFile(dbPath);
		secretTable.add(firstId, "first-provider-secret");
		secretTable.add(secondId, "second-provider-secret");
		const first = credential("first-provider", firstId),
			second = credential("second-provider", secondId),
			value = input(snapshot, {
				credentials: [first, second],
				operations: [first, second],
				secretTable,
			}),
			plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd }),
			insertSpy = vi.spyOn(AuthStorage.prototype, "insertCredentialsIfProvidersAbsent").mockImplementation(() => {
				throw Object.assign(new Error("credential batch insert failed"), { code: "EACCES" });
			});
		try {
			const applied = await applyPrimeDestination(plan, value);
			const inspected = new Database(dbPath, { readonly: true });
			try {
				const insertedProviders = inspected
					.query("SELECT provider FROM auth_credentials WHERE provider IN (?, ?) ORDER BY provider")
					.all("first-provider", "second-provider")
					.map(row => {
						if (row && typeof row === "object" && "provider" in row && typeof row.provider === "string")
							return row.provider;
						throw new Error("credential row is invalid");
					});
				if (insertedProviders.length === 0) {
					expect(await fs.readFile(dbPath)).toEqual(before);
					expect(applied.report.partialApply).toBe(false);
				} else {
					expect(
						insertedProviders.every(provider =>
							applied.rollbackEntries.some(entry => entry.itemId === `credential:${provider}`),
						),
					).toBe(true);
				}
			} finally {
				inspected.close();
			}
		} finally {
			insertSpy.mockRestore();
		}
	});
	it("rejects oversized model files and over-budget skill trees before publication", async () => {
		const root = await temp(),
			snapshot = {
				...(await sourceSnapshot(root)),
				maxFileBytes: 64,
				maxTotalBytes: 128,
				maxEntries: 2,
			},
			agentDir = path.join(root, "omp"),
			modelsPath = path.join(agentDir, "models.yml"),
			model: PrimeNormalizedModelOperation = {
				kind: "models",
				modelKind: "definition",
				provider: "budget-provider",
				providerConfig: { api: "openai-completions", auth: "none", baseUrl: "http://budget" },
				model: { id: "budget-model", api: "openai-completions" },
				sourceRefs: ["global/models.json"],
			},
			skillBody = Buffer.from("---\nname: budgeted\ndescription: Budgeted\n---\nbody\n"),
			skillFiles = [
				{
					kind: "file" as const,
					relativePath: "SKILL.md",
					sourceRef: "global/skills/budgeted/SKILL.md",
					mode: 0o600,
					size: skillBody.byteLength,
					sha256: createHash("sha256").update(skillBody).digest("hex"),
					contentBase64: skillBody.toString("base64"),
				},
				...["a.txt", "b.txt"].map((relativePath, index) => {
					const bytes = Buffer.from(`entry-${index}`);
					return {
						kind: "file" as const,
						relativePath,
						sourceRef: `global/skills/budgeted/${relativePath}`,
						mode: 0o600,
						size: bytes.byteLength,
						sha256: createHash("sha256").update(bytes).digest("hex"),
						contentBase64: bytes.toString("base64"),
					};
				}),
			],
			skill = {
				kind: "skill" as const,
				scope: "global" as const,
				name: "budgeted",
				directorySourceRef: "global/skills/budgeted",
				frontmatter: { name: "budgeted", description: "Budgeted" },
				files: skillFiles,
			};
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(modelsPath, `providers: {}\n#${"x".repeat(96)}\n`);
		const value = input(snapshot, { models: [model], operations: [model] }, [skill]),
			plan = await planPrimeDestination(value, { agentDir, cwd: snapshot.cwd }),
			applied = await applyPrimeDestination(plan, value);
		expect(plan.items.find(item => item.itemId === "model:budget-provider:definition:budget-model")?.outcome).toBe(
			"lost",
		);
		expect(plan.items.find(item => item.itemId === "skill:budgeted")?.outcome).toBe("lost");
		expect(
			applied.report.items.find(item => item.itemId === "model:budget-provider:definition:budget-model")?.outcome,
		).toBe("lost");
		expect(
			applied.report.losses.some(
				loss => loss.code === "destination-invalid" || loss.code === "destination-apply-failed",
			),
		).toBe(true);
		expect(await fs.lstat(path.join(agentDir, "skills", "budgeted")).catch(() => undefined)).toBeUndefined();
	});
});
