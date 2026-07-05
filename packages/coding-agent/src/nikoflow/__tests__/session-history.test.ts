import { describe, expect, test } from "bun:test";

describe("nikoflow session history", () => {
	test("keeps nikoflow artifacts expanded for reviewer context", async () => {
		const source = await Bun.file(new URL("../../session/session-history-format.ts", import.meta.url)).text();
		expect(source).toContain('"nikoflow-context"');
		expect(source).toContain('"nikoflow-adr"');
		expect(source).toContain('"nikoflow-prd"');
	});
});
