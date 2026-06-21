import { describe, expect, test } from "bun:test";
import { looksLikeLiteralSecret, mergeCompat } from "@oh-my-pi/pi-coding-agent/config/custom-model-builder";

describe("custom model builder", () => {
	test("deep-merges compat objects while replacing scalar leaves", () => {
		const merged = mergeCompat(
			{
				disableStrictTools: false,
				extraBody: { temperature: 0, nested: { keep: true, replace: "old" } },
			},
			{
				extraBody: { nested: { replace: "new" }, topP: 1 },
				openRouterRouting: { requireParameters: true },
			},
		);

		expect(merged).toEqual({
			disableStrictTools: false,
			extraBody: { temperature: 0, nested: { keep: true, replace: "new" }, topP: 1 },
			openRouterRouting: { requireParameters: true },
		});
	});

	test("classifies only token-shaped shared catalog values as literal secrets", () => {
		expect(looksLikeLiteralSecret("platform")).toBe(false);
		expect(looksLikeLiteralSecret("MY_PROXY_API_KEY")).toBe(false);
		expect(looksLikeLiteralSecret("!op read op://vault/item/key")).toBe(false);
		expect(looksLikeLiteralSecret("sk-test-abcdefghijklmnopqrstuvwxyz")).toBe(true);
		expect(looksLikeLiteralSecret("Bearer abcdefghijklmnopqrstuvwxyz0123456789")).toBe(true);
		expect(looksLikeLiteralSecret("abcdefghijklmnopqrstuvwxyz0123456789ABCDEF")).toBe(true);
		expect(looksLikeLiteralSecret("/tmp/abcdefghijklmnopqrstuvwxyz0123456789ABCDEF")).toBe(false);
	});
});
