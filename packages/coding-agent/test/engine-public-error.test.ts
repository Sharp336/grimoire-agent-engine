import { expect, test } from "bun:test";
import { safeEngineErrorDetail, safeHostedMcpFailure } from "../src/engine/public-error";

test("hosted MCP startup reports the connection category without disclosing server text", () => {
	for (const message of [
		"HTTP 503: Authorization: Bearer sensitive-value",
		"connect ECONNREFUSED 127.0.0.1:59111",
		"unexpected secret response",
	]) {
		const detail = safeHostedMcpFailure(message);
		expect(detail).toMatch(
			/^Hosted Core MCP binding failed(?:: HTTP 503|: ECONNREFUSED)? \(diagnostic [0-9a-f]{12}\)$/,
		);
		expect(detail).not.toContain("sensitive-value");
		expect(detail).not.toContain("secret response");
		expect(safeEngineErrorDetail(new Error(detail))).toBe(detail);
	}
});
