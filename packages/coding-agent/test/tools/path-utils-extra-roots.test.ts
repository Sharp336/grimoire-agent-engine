import { describe, expect, it } from "bun:test";
import { resolveToCwd } from "../../src/tools/path-utils";

describe("resolveToCwd extra roots", () => {
	it("resolves @alias paths against matching extra root basename", () => {
		const resolved = resolveToCwd("@service-b/src/index.ts", "/repos/service-a", ["/repos/service-b"]);
		expect(resolved).toBe("/repos/service-b/src/index.ts");
	});

	it("keeps existing relative path behavior for non-alias input", () => {
		const resolved = resolveToCwd("src/index.ts", "/repos/service-a", ["/repos/service-b"]);
		expect(resolved).toBe("/repos/service-a/src/index.ts");
	});
});
