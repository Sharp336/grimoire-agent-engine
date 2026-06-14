import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { rm } from "node:fs/promises";
import * as path from "node:path";
import { buildCodebaseEnrichmentPrompt } from "../../src/okf/enrichment/codebase";
import { applyEnrichmentOps, parseEnrichmentResponse, renderExistingConcepts } from "../../src/okf/enrichment/session";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(import.meta.dir, ".okf-enrich-test-"));
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe("okf/enrichment.parseEnrichmentResponse", () => {
	it("parses valid JSON operations", () => {
		const text = `{"operations":[{"op":"upsert","id":"cat/topic","content":"---\\ntype: Ref\\n---\\nBody."}]}`;
		const ops = parseEnrichmentResponse(text);
		expect(ops).toHaveLength(1);
		expect(ops[0].op).toBe("upsert");
		expect(ops[0].id).toBe("cat/topic");
		expect(ops[0].content).toContain("Body.");
	});

	it("handles delete operations", () => {
		const text = `{"operations":[{"op":"delete","id":"cat/old"}]}`;
		const ops = parseEnrichmentResponse(text);
		expect(ops).toHaveLength(1);
		expect(ops[0].op).toBe("delete");
		expect(ops[0].id).toBe("cat/old");
	});

	it("returns empty for non-JSON", () => {
		expect(parseEnrichmentResponse("not json at all")).toEqual([]);
	});

	it("returns empty for missing operations array", () => {
		expect(parseEnrichmentResponse('{"foo":"bar"}')).toEqual([]);
	});

	it("skips invalid operations", () => {
		const text = `{"operations":[{"op":"invalid","id":"x"},{"op":"upsert","id":"y","content":"c"},{}]}`;
		const ops = parseEnrichmentResponse(text);
		expect(ops).toHaveLength(1);
		expect(ops[0].id).toBe("y");
	});
});

describe("okf/enrichment.applyEnrichmentOps", () => {
	it("upserts concepts", async () => {
		const ops = [
			{ op: "upsert" as const, id: "cat/topic", content: "---\ntype: Ref\ndescription: tags\n---\nBody." },
		];
		const result = await applyEnrichmentOps(tmpDir, ops);
		expect(result.upserted).toEqual(["cat/topic"]);
		expect(result.deleted).toEqual([]);
		expect(result.skipped).toBe(0);
	});

	it("handles delete for non-existent", async () => {
		const ops = [{ op: "delete" as const, id: "cat/nonexistent" }];
		const result = await applyEnrichmentOps(tmpDir, ops);
		expect(result.upserted).toEqual([]);
		expect(result.deleted).toEqual([]);
		expect(result.skipped).toBe(1);
	});

	it("skips upserts without content", async () => {
		const ops = [{ op: "upsert" as const, id: "cat/topic" }];
		const result = await applyEnrichmentOps(tmpDir, ops);
		expect(result.skipped).toBe(1);
	});
});

describe("okf/enrichment.renderExistingConcepts", () => {
	it("returns placeholder for empty bundle", async () => {
		const result = await renderExistingConcepts(tmpDir);
		expect(result).toContain("No existing");
	});

	it("includes existing concept content", async () => {
		await applyEnrichmentOps(tmpDir, [
			{ op: "upsert", id: "cat/topic", content: "---\ntype: Ref\ndescription: x, y\n---\nExisting content." },
		]);
		const result = await renderExistingConcepts(tmpDir);
		expect(result).toContain("Existing content.");
	});
});

describe("okf/enrichment.buildCodebaseEnrichmentPrompt", () => {
	it("includes the target and max concepts", () => {
		const prompt = buildCodebaseEnrichmentPrompt({ cwd: "/project", focus: "auth module", maxConcepts: 5 });
		expect(prompt).toContain("auth module");
		expect(prompt).toContain("5");
		expect(prompt).toContain("/project");
	});

	it("works without focus", () => {
		const prompt = buildCodebaseEnrichmentPrompt({ cwd: "/project" });
		expect(prompt).toContain("Explore the whole codebase");
		expect(prompt).toContain("10");
	});
});
