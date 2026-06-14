import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { rm } from "node:fs/promises";
import * as path from "node:path";
import type { OkfConceptSummary } from "../../src/okf/bundle";
import { SqliteOkfStore } from "../../src/okf/store/store-sqlite";

let tmpDir: string;
let store: SqliteOkfStore;

function makeSummary(
	id: string,
	type: string,
	description: string,
	tags: string[] = [],
	title?: string,
): OkfConceptSummary {
	return {
		id,
		type,
		title,
		description,
		tags,
		filePath: `${id}.md`,
		mtime: Date.now(),
	};
}

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(import.meta.dir, ".okf-store-test-"));
	store = new SqliteOkfStore(path.join(tmpDir, "okf.db"));
});

afterEach(async () => {
	await store.close();
	await rm(tmpDir, { recursive: true, force: true });
});

describe("okf/store-sqlite upsert + get", () => {
	it("stores and retrieves a concept", async () => {
		const summary = makeSummary("tables/orders", "Table", "orders, revenue", ["sales"]);
		await store.upsert(summary, "# Orders\n\nOrder table schema.");
		const got = await store.get("tables/orders");
		expect(got).toBeDefined();
		expect(got!.id).toBe("tables/orders");
		expect(got!.type).toBe("Table");
		expect(got!.description).toBe("orders, revenue");
		expect(got!.tags).toEqual(["sales"]);
	});

	it("returns undefined for missing concept", async () => {
		expect(await store.get("nonexistent")).toBeUndefined();
	});

	it("upserts replace existing data", async () => {
		await store.upsert(makeSummary("cat/topic", "Reference", "old desc"), "old body");
		await store.upsert(makeSummary("cat/topic", "Playbook", "new desc"), "new body");
		const got = await store.get("cat/topic");
		expect(got!.type).toBe("Playbook");
		expect(got!.description).toBe("new desc");
	});
});

describe("okf/store-sqlite delete", () => {
	it("deletes a concept", async () => {
		await store.upsert(makeSummary("cat/topic", "Reference", "desc"), "body");
		await store.delete("cat/topic");
		expect(await store.get("cat/topic")).toBeUndefined();
		expect(await store.count()).toBe(0);
	});
});

describe("okf/store-sqlite search", () => {
	it("finds concepts by body content", async () => {
		await store.upsert(makeSummary("tables/orders", "Table", "orders"), "# Orders\n\nContains customer order data.");
		await store.upsert(makeSummary("tables/customers", "Table", "customers"), "# Customers\n\nCustomer CRM records.");
		const results = await store.search("orders");
		expect(results.length).toBeGreaterThanOrEqual(1);
		expect(results[0].id).toBe("tables/orders");
	});

	it("returns results ranked by relevance", async () => {
		await store.upsert(makeSummary("a/relevant", "Ref", "x"), "lsp config lsp servers lsp");
		await store.upsert(makeSummary("b/less", "Ref", "y"), "lsp mentioned once");
		const results = await store.search("lsp");
		expect(results[0].id).toBe("a/relevant");
	});

	it("returns empty for no matches", async () => {
		await store.upsert(makeSummary("cat/topic", "Ref", "desc"), "body text");
		expect(await store.search("zzzznonexistent")).toEqual([]);
	});

	it("returns empty for empty query", async () => {
		await store.upsert(makeSummary("cat/topic", "Ref", "desc"), "body");
		expect(await store.search("")).toEqual([]);
	});

	it("handles malformed query gracefully", async () => {
		await store.upsert(makeSummary("cat/topic", "Ref", "desc"), "body");
		const results = await store.search('"""broken');
		expect(results).toEqual([]);
	});
});

describe("okf/store-sqlite list", () => {
	it("lists all concepts sorted by id", async () => {
		await store.upsert(makeSummary("b/topic", "Ref", "b"), "body b");
		await store.upsert(makeSummary("a/topic", "Ref", "a"), "body a");
		const list = await store.list();
		expect(list).toHaveLength(2);
		expect(list[0].id).toBe("a/topic");
		expect(list[1].id).toBe("b/topic");
	});

	it("filters by type", async () => {
		await store.upsert(makeSummary("a/table", "Table", "a"), "body a");
		await store.upsert(makeSummary("b/playbook", "Playbook", "b"), "body b");
		const list = await store.list({ type: "Table" });
		expect(list).toHaveLength(1);
		expect(list[0].id).toBe("a/table");
	});

	it("filters by tag", async () => {
		await store.upsert(makeSummary("a/topic", "Ref", "a", ["sales", "orders"]), "body a");
		await store.upsert(makeSummary("b/topic", "Ref", "b", ["oncall"]), "body b");
		const list = await store.list({ tag: "sales" });
		expect(list).toHaveLength(1);
		expect(list[0].id).toBe("a/topic");
	});
});

describe("okf/store-sqlite count", () => {
	it("counts concepts", async () => {
		expect(await store.count()).toBe(0);
		await store.upsert(makeSummary("a/topic", "Ref", "a"), "body a");
		await store.upsert(makeSummary("b/topic", "Ref", "b"), "body b");
		expect(await store.count()).toBe(2);
	});
});
