import { describe, expect, it } from "bun:test";
import type { HindsightApi } from "../../src/hindsight/client";
import { HindsightOkfStore } from "../../src/okf/store/store-hindsight";

class FakeHindsightApi {
	readonly documents = new Map<string, Record<string, unknown>>();
	readonly deletedIds: string[] = [];

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

	async recall(): Promise<{ results: unknown[] }> {
		return { results: [] };
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
});
