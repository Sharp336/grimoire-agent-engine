import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
	buildGraph,
	conceptIdToPath,
	deleteConcept,
	ensureWithinRoot,
	fingerprint,
	getBundleRoot,
	loadConcept,
	loadSummaries,
	normalizeConceptId,
	renderIndex,
	resolveLinkTarget,
	walkBundle,
	writeConcept,
} from "../../src/okf/bundle";

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(import.meta.dir, ".okf-test-"));
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

// Re-export for convenience
import * as fs from "node:fs/promises";

describe("okf/bundle.normalizeConceptId", () => {
	it("accepts nested paths with .md suffix", () => {
		expect(normalizeConceptId("tables/orders.md")).toBe("tables/orders");
		expect(normalizeConceptId("a/b/c/topic.md")).toBe("a/b/c/topic");
	});

	it("accepts paths without .md suffix", () => {
		expect(normalizeConceptId("cat/topic")).toBe("cat/topic");
	});

	it("rejects reserved filenames", () => {
		expect(normalizeConceptId("index.md")).toBeUndefined();
		expect(normalizeConceptId("log.md")).toBeUndefined();
		expect(normalizeConceptId("cat/index.md")).toBeUndefined();
	});

	it("rejects path traversal", () => {
		expect(normalizeConceptId("../escape.md")).toBeUndefined();
		expect(normalizeConceptId("a/../../b.md")).toBeUndefined();
	});

	it("rejects dotfiles", () => {
		expect(normalizeConceptId(".hidden.md")).toBeUndefined();
		expect(normalizeConceptId("cat/.hidden.md")).toBeUndefined();
	});

	it("rejects NUL bytes", () => {
		expect(normalizeConceptId("a\0b.md")).toBeUndefined();
	});

	it("rejects empty and whitespace paths", () => {
		expect(normalizeConceptId("")).toBeUndefined();
		expect(normalizeConceptId("   ")).toBeUndefined();
	});
});

describe("okf/bundle.conceptIdToPath", () => {
	it("appends .md", () => {
		expect(conceptIdToPath("tables/orders")).toBe("tables/orders.md");
	});
});

describe("okf/bundle.walkBundle", () => {
	it("lists concept ids sorted", async () => {
		await mkdir(path.join(tmpDir, "tables"), { recursive: true });
		await mkdir(path.join(tmpDir, "playbooks"), { recursive: true });
		await writeFile(path.join(tmpDir, "tables", "orders.md"), "---\ntype: Table\n---\n");
		await writeFile(path.join(tmpDir, "tables", "customers.md"), "---\ntype: Table\n---\n");
		await writeFile(path.join(tmpDir, "playbooks", "incident.md"), "---\ntype: Playbook\n---\n");
		await writeFile(path.join(tmpDir, "index.md"), "# Index\n");
		await writeFile(path.join(tmpDir, "log.md"), "# Log\n");
		await writeFile(path.join(tmpDir, ".dotfile.md"), "---\ntype: X\n---\n");

		const ids = await walkBundle(tmpDir);
		expect(ids).toEqual(["playbooks/incident", "tables/customers", "tables/orders"]);
	});

	it("returns empty for non-existent directory", async () => {
		const ids = await walkBundle(path.join(tmpDir, "nonexistent"));
		expect(ids).toEqual([]);
	});
});

describe("okf/bundle.loadConcept", () => {
	it("loads frontmatter and body", async () => {
		await mkdir(path.join(tmpDir, "tables"), { recursive: true });
		await writeFile(
			path.join(tmpDir, "tables", "orders.md"),
			"---\ntype: Table\ntitle: Orders\n---\n\n# Schema\n\nCol A.",
		);
		const concept = await loadConcept(tmpDir, "tables/orders");
		expect(concept.id).toBe("tables/orders");
		expect(concept.frontmatter.type).toBe("Table");
		expect(concept.frontmatter.title).toBe("Orders");
		expect(concept.body).toContain("# Schema");
	});
});

describe("okf/bundle.writeConcept + loadSummaries", () => {
	it("writes, conforms, and loads back", async () => {
		await writeConcept(tmpDir, "tables/orders", "Body without frontmatter.");
		const summaries = await loadSummaries(tmpDir, { autoUpdate: false });
		expect(summaries).toHaveLength(1);
		expect(summaries[0].id).toBe("tables/orders");
		expect(summaries[0].type).toBe("Reference");
		expect(summaries[0].description.length).toBeGreaterThan(0);
	});

	it("appends to log.md on write", async () => {
		await writeConcept(tmpDir, "tables/orders", "---\ntype: Table\n---\nBody.");
		const log = await Bun.file(path.join(tmpDir, "log.md")).text();
		expect(log).toContain("tables/orders");
		expect(log).toContain("Creation");
	});

	it("records Update on second write", async () => {
		await writeConcept(tmpDir, "tables/orders", "---\ntype: Table\n---\nBody v1.");
		await writeConcept(tmpDir, "tables/orders", "---\ntype: Table\n---\nBody v2.");
		const log = await Bun.file(path.join(tmpDir, "log.md")).text();
		expect(log).toContain("Creation");
		expect(log).toContain("Update");
	});

	it("rejects writes through symlinked category directories", async () => {
		const outside = await fs.mkdtemp(path.join(path.dirname(tmpDir), ".okf-outside-"));
		try {
			await fs.symlink(outside, path.join(tmpDir, "linked"), process.platform === "win32" ? "junction" : "dir");
		} catch {
			await rm(outside, { recursive: true, force: true });
			return;
		}
		try {
			await expect(writeConcept(tmpDir, "linked/x", "---\ntype: Reference\ndescription: x\n---\n")).rejects.toThrow(
				"Path escapes the OKF bundle root",
			);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});

describe("okf/bundle.deleteConcept", () => {
	it("deletes and returns true", async () => {
		await writeConcept(tmpDir, "tables/orders", "---\ntype: Table\n---\nBody.");
		expect(await deleteConcept(tmpDir, "tables/orders")).toBe(true);
		expect(await walkBundle(tmpDir)).toEqual([]);
	});

	it("returns false for non-existent", async () => {
		expect(await deleteConcept(tmpDir, "nonexistent/topic")).toBe(false);
	});
});

describe("okf/bundle.resolveLinkTarget", () => {
	it("resolves absolute links", () => {
		expect(resolveLinkTarget("/tables/orders.md", "playbooks/x")).toBe("tables/orders");
	});

	it("resolves relative links", () => {
		expect(resolveLinkTarget("./orders.md", "tables/customers")).toBe("tables/orders");
		expect(resolveLinkTarget("../orders.md", "tables/sub/deep")).toBe("tables/orders");
	});

	it("ignores URLs and anchors", () => {
		expect(resolveLinkTarget("https://example.com", "a/b")).toBeUndefined();
		expect(resolveLinkTarget("#anchor", "a/b")).toBeUndefined();
	});

	it("ignores non-.md links", () => {
		expect(resolveLinkTarget("image.png", "a/b")).toBeUndefined();
	});
});

describe("okf/bundle.buildGraph", () => {
	it("builds nodes and edges from cross-links", async () => {
		await writeConcept(tmpDir, "tables/orders", "---\ntype: Table\n---\nSee [customers](/tables/customers.md).");
		await writeConcept(tmpDir, "tables/customers", "---\ntype: Table\n---\nSee [orders](/tables/orders.md).");
		const result = await buildGraph(tmpDir);
		expect(result.graph.nodes).toHaveLength(2);
		expect(result.graph.edges).toHaveLength(2);
		expect(result.brokenLinks).toEqual([]);
	});

	it("reports broken links", async () => {
		await writeConcept(tmpDir, "tables/orders", "---\ntype: Table\n---\nSee [ghost](/tables/nonexistent.md).");
		const result = await buildGraph(tmpDir);
		expect(result.brokenLinks).toHaveLength(1);
		expect(result.brokenLinks[0].target).toBe("tables/nonexistent");
	});
});

describe("okf/bundle.renderIndex", () => {
	it("groups concepts by type", async () => {
		await writeConcept(tmpDir, "tables/orders", "---\ntype: Table\ndescription: orders table\n---\n");
		await writeConcept(tmpDir, "playbooks/incident", "---\ntype: Playbook\ndescription: incident response\n---\n");
		const index = await renderIndex(tmpDir);
		expect(index).toContain("## Table");
		expect(index).toContain("## Playbook");
		expect(index).toContain("orders");
		expect(index).toContain("incident");
	});

	it("respects real index.md when present", async () => {
		await writeConcept(tmpDir, "tables/orders", "---\ntype: Table\ndescription: orders\n---\n");
		await writeFile(path.join(tmpDir, "index.md"), "# Custom Index\n\nHand-curated.");
		const index = await renderIndex(tmpDir);
		expect(index).toContain("Hand-curated.");
	});

	it("rejects category index reads through symlinked directories", async () => {
		const outside = await fs.mkdtemp(path.join(path.dirname(tmpDir), ".okf-outside-"));
		try {
			await fs.symlink(outside, path.join(tmpDir, "linked"), process.platform === "win32" ? "junction" : "dir");
		} catch {
			await rm(outside, { recursive: true, force: true });
			return;
		}
		try {
			await expect(renderIndex(tmpDir, { category: "linked" })).rejects.toThrow("Path escapes the OKF bundle root");
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});
});

describe("okf/bundle.fingerprint", () => {
	it("is deterministic for same content", async () => {
		await writeConcept(tmpDir, "tables/orders", "---\ntype: Table\ndescription: x, y\n---\n");
		const fp1 = await fingerprint(tmpDir);
		const fp2 = await fingerprint(tmpDir);
		expect(fp1).toBe(fp2);
	});

	it("changes when content changes", async () => {
		await writeConcept(tmpDir, "tables/orders", "---\ntype: Table\ndescription: x, y\n---\n");
		const fp1 = await fingerprint(tmpDir);
		await writeConcept(tmpDir, "tables/orders", "---\ntype: Table\ndescription: x, y, z\n---\n");
		const fp2 = await fingerprint(tmpDir);
		expect(fp1).not.toBe(fp2);
	});
});

describe("okf/bundle.getBundleRoot", () => {
	it("joins .omp/knowledge under cwd", () => {
		const root = getBundleRoot("/project");
		expect(root).toBe(path.join("/project", ".omp", "knowledge"));
	});
});

describe("okf/bundle.ensureWithinRoot", () => {
	it("accepts paths inside root", () => {
		const root = path.resolve(tmpDir);
		const child = path.join(root, "a", "b.md");
		expect(() => ensureWithinRoot(child, root)).not.toThrow();
	});

	it("rejects paths outside root", () => {
		const root = path.resolve(tmpDir);
		const outside = path.resolve(tmpDir, "..", "escape.md");
		expect(() => ensureWithinRoot(outside, root)).toThrow();
	});
});
