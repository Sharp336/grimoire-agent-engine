import { describe, expect, it } from "bun:test";
import {
	buildServiceTierByFamily,
	resolveSubagentServiceTier,
	serviceTierForAllFamilies,
} from "@oh-my-pi/pi-coding-agent/config/service-tier";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";

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

describe("buildServiceTierByFamily", () => {
	it("carries qoder from the tier.qoder setting path", () => {
		expect(buildServiceTierByFamily("none", "none", "none", "priority")).toEqual({
			qoder: "priority",
		});
		expect(buildServiceTierByFamily("priority", "priority", "flex", "priority")).toEqual({
			openai: "priority",
			anthropic: "priority",
			google: "flex",
			qoder: "priority",
		});
	});

	it("omits qoder when the setting is none", () => {
		expect(buildServiceTierByFamily("flex", "none", "none", "none")).toEqual({ openai: "flex" });
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

describe("createSubagentSettings", () => {
	it("stamps qoder priority into the child settings snapshot", () => {
		const parent = Settings.isolated({
			"tier.openai": "none",
			"tier.anthropic": "none",
			"tier.google": "none",
			"tier.qoder": "none",
			"tier.subagent": "priority",
		});
		const child = createSubagentSettings(parent);
		expect(child.get("tier.qoder")).toBe("priority");
		expect(child.get("tier.openai")).toBe("priority");
		expect(
			buildServiceTierByFamily(
				child.get("tier.openai"),
				child.get("tier.anthropic"),
				child.get("tier.google"),
				child.get("tier.qoder"),
			),
		).toEqual({
			openai: "priority",
			anthropic: "priority",
			google: "priority",
			qoder: "priority",
		});
	});

	it("preserves inherited qoder priority when tier.subagent is inherit", () => {
		const parent = Settings.isolated({
			"tier.subagent": "inherit",
		});
		const child = createSubagentSettings(parent, undefined, { qoder: "priority" });
		expect(child.get("tier.qoder")).toBe("priority");
		expect(child.get("tier.openai")).toBe("none");
	});
});
