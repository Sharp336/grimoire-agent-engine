import { describe, expect, it } from "bun:test";
import { canonicalizeStatsHash, formatStatsHash, parseStatsHash } from "../src/client/data/hash-route";

describe("stats hash routing", () => {
	it("canonicalizes detail routes and drops unknown query keys", () => {
		expect(canonicalizeStatsHash("#/sessions/abc?range=7d&tab=failures&foo=1")).toBe(
			"#/sessions/abc?range=7d&tab=failures",
		);
	});

	it("defaults a missing or unknown detail tab to requests", () => {
		expect(parseStatsHash("#/runs/run-1").tab).toBe("requests");
		expect(parseStatsHash("#/runs/run-1?tab=not-a-tab").tab).toBe("requests");
		expect(canonicalizeStatsHash("#/runs/run-1?tab=not-a-tab")).toBe("#/runs/run-1?range=24h&tab=requests");
	});

	it("keeps list filters off detail hashes", () => {
		expect(
			canonicalizeStatsHash("#/sessions/abc?status=active&project=omp&failure=true&q=needle&range=7d"),
		).toBe("#/sessions/abc?range=7d&tab=requests");
	});

	it("writes allowlisted list keys in canonical order", () => {
		expect(canonicalizeStatsHash("#/sessions?q=needle&failure=true&project=omp&status=active&range=7d")).toBe(
			"#/sessions?range=7d&status=active&project=omp&failure=true&q=needle",
		);
	});

	it("copy-hash view keeps range and tab and drops list filters", () => {
		expect(
			formatStatsHash({
				section: "sessions",
				id: "abc",
				range: "7d",
				tab: "behavior",
				status: "active",
				project: "omp",
				failure: "true",
				q: "needle",
			}),
		).toBe("#/sessions/abc?range=7d&tab=behavior");
	});
});
