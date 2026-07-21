import { describe, expect, it } from "bun:test";
import { resolveSubagentServiceTier, serviceTierForAllFamilies } from "@oh-my-pi/pi-coding-agent/config/service-tier";

// Locks the per-family broadcast used by the subagent/advisor single-value
// settings and `omp bench --service-tier`: each family only receives the tiers
// it realizes on the wire (Qoder realizes only `priority`).
describe("serviceTierForAllFamilies", () => {
	it("broadcasts priority to every family including qoder", () => {
		expect(serviceTierForAllFamilies("priority")).toEqual({
			openai: "priority",
			anthropic: "priority",
			google: "priority",
			qoder: "priority",
		});
	});

	it("does not map non-priority tiers onto qoder or anthropic", () => {
		expect(serviceTierForAllFamilies("flex")).toEqual({ openai: "flex", google: "flex" });
		expect(serviceTierForAllFamilies("auto")).toEqual({ openai: "auto" });
		expect(serviceTierForAllFamilies("scale")).toEqual({ openai: "scale" });
		expect(serviceTierForAllFamilies("default")).toEqual({ openai: "default" });
	});

	it("omits every family when no tier is chosen", () => {
		expect(serviceTierForAllFamilies(undefined)).toEqual({});
	});
});

describe("resolveSubagentServiceTier", () => {
	it("broadcasts a concrete priority setting to qoder", () => {
		expect(resolveSubagentServiceTier("priority", {})).toEqual({
			openai: "priority",
			anthropic: "priority",
			google: "priority",
			qoder: "priority",
		});
	});

	it("keeps qoder unset for non-priority settings and inherit", () => {
		expect(resolveSubagentServiceTier("flex", {})).toEqual({ openai: "flex", google: "flex" });
		expect(resolveSubagentServiceTier("inherit", { qoder: "priority" })).toEqual({ qoder: "priority" });
	});
});
