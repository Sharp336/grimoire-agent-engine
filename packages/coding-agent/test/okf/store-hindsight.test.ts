import { describe, expect, it } from "bun:test";
import type { HindsightApi, RecallOptions } from "../../src/hindsight/client";
import { HindsightOkfStore } from "../../src/okf/store/store-hindsight";

class FakeHindsightApi {
	readonly documents = new Map<string, Record<string, unknown>>();
	readonly deletedIds: string[] = [];
	readonly recallRequests: { query: string; options?: RecallOptions }[] = [];
	recallResults: unknown[] = [];

	async createBank(): Promise<void> {}

	async retain(_bankId: string, _body: string, options: { documentId?: string }): Promise<void> {
		if (!options.documentId) return;
		this.documents.set(options.documentId, { id: options.documentId, tags: ["okf"] });
	}

	async getDocument(_bankId: string, documentId: string): Promise<Record<string, unknown> | null> {
		return this.documents.get(documentId) ?? null;
	}

	async deleteDocument(_bankId: string, documentId: string): Promise<void> {
		this.deletedIds.push(documentId);
	}

	async listDocuments(): Promise<{ items: Record<string, unknown>[]; total: number }> {
		const items = [...this.documents.values()];
		return { items, total: items.length };
	}

	async recall(_bankId: string, query: string, options?: RecallOptions): Promise<{ results: unknown[] }> {
		this.recallRequests.push({ query, options });
		return { results: this.recallResults };
	}
}

describe("okf/store HindsightOkfStore", () => {
	it("lists and counts only OKF-tagged documents", async () => {
		const api = new FakeHindsightApi();
		api.documents.set("architecture/auth", {
			id: "architecture/auth",
			tags: ["okf", "auth"],
			metadata: {
				okf_id: "architecture/auth",
				type: "Architecture",
				title: "Auth",
				description: "Auth flow overview",
			},
		});
		api.documents.set("notes/random", {
			id: "notes/random",
			tags: ["personal"],
			metadata: {
				type: "Reference",
				description: "Unrelated Hindsight document",
			},
		});
		const store = new HindsightOkfStore(api as unknown as HindsightApi, "knowledge");

		const listed = await store.list();
		const missing = await store.get("notes/random");
		const count = await store.count();

		expect(listed.map(item => item.id)).toEqual(["architecture/auth"]);
		expect(listed[0]?.tags).toEqual(["auth"]);
		expect(missing).toBeUndefined();
		expect(count).toBe(1);
	});

	it("recalls only strict OKF-tagged Hindsight memories", async () => {
		const api = new FakeHindsightApi();
		const store = new HindsightOkfStore(api as unknown as HindsightApi, "knowledge");

		await store.search("orders", { limit: 3 });

		expect(api.recallRequests[0]?.options?.tags).toEqual(["okf"]);
		expect(api.recallRequests[0]?.options?.tagsMatch).toBe("all_strict");
	});

	it("links recall results with the stored OKF concept id", async () => {
		const api = new FakeHindsightApi();
		api.recallResults = [
			{
				id: "fact-123",
				metadata: {
					okf_id: "tables/orders",
					type: "Table",
					title: "Orders",
					description: "Orders schema",
				},
			},
		];
		const store = new HindsightOkfStore(api as unknown as HindsightApi, "knowledge");

		const results = await store.search("orders");

		expect(results[0]?.id).toBe("tables/orders");
		expect(results[0]?.title).toBe("Orders");
	});
});
