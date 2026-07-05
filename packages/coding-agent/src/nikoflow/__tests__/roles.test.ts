import { describe, expect, test } from "bun:test";
import {
	assertNikoflowRoleRails,
	type RoleModelResolver,
	reassertNikoflowRoleRails,
	roleForPhase,
	shouldReassertNikoflowRoleRails,
} from "../roles";

describe("nikoflow roles", () => {
	test("maps phases to required model roles", () => {
		expect(roleForPhase("grilling")).toBe("plan");
		expect(roleForPhase("adr")).toBe("plan");
		expect(roleForPhase("prd")).toBe("plan");
		expect(roleForPhase("tickets")).toBe("plan");
		expect(roleForPhase("execute")).toBe("default");
		expect(roleForPhase("verify")).toBe("advisor");
	});

	test("fails fast when plan is unset or equals default", () => {
		expect(() => assertNikoflowRoleRails(() => null)).toThrow("modelRoles.plan");
		expect(() => assertNikoflowRoleRails(role => ({ model: role === "advisor" ? "qa" : "same" }))).toThrow(
			"modelRoles.plan",
		);
	});

	test("accepts separated plan/default roles", () => {
		const resolve: RoleModelResolver = role => ({ provider: "openai", model: role === "plan" ? "strong" : "cheap" });
		expect(assertNikoflowRoleRails(resolve)).toEqual({
			plan: "openai/strong",
			default: "openai/cheap",
			advisor: "openai/cheap",
		});
	});

	test("reasserts only on retry fallback events", () => {
		const resolve: RoleModelResolver = role => (role === "plan" ? "strong" : "cheap");
		expect(shouldReassertNikoflowRoleRails("retry_fallback_applied")).toBe(true);
		expect(shouldReassertNikoflowRoleRails({ event: "retry_fallback_applied" })).toBe(true);
		expect(reassertNikoflowRoleRails("other", resolve)).toBeNull();
		expect(reassertNikoflowRoleRails("retry_fallback_applied", resolve)?.plan).toBe("strong");
	});
});
