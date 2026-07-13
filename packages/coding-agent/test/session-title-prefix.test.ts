import { describe, expect, it } from "bun:test";
import { getSessionTitlePrefix, prefixSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";

function withTenant<T>(tenant: string | undefined, fn: () => T): T {
	const previous = Bun.env.OMP_TENANT;
	if (tenant === undefined) delete Bun.env.OMP_TENANT;
	else Bun.env.OMP_TENANT = tenant;
	try {
		return fn();
	} finally {
		if (previous === undefined) delete Bun.env.OMP_TENANT;
		else Bun.env.OMP_TENANT = previous;
	}
}

describe("automatic IXA session title prefixes", () => {
	it("detects QuietCare from the project directory", () => {
		expect(withTenant(undefined, () => getSessionTitlePrefix("Refactor the dashboard", "/tmp/QuietCare"))).toBe(
			"IXA",
		);
	});

	it("detects Ixara from the first user message", () => {
		expect(
			withTenant(undefined, () => getSessionTitlePrefix("Investigate the IxArA billing flow", "/tmp/other-project")),
		).toBe("IXA");
	});

	it("does not prefix an unrelated context", () => {
		expect(
			withTenant(undefined, () => getSessionTitlePrefix("Fix the login flow", "/tmp/other-project")),
		).toBeUndefined();
	});

	it("detects an explicit Ixara tenant regardless of message or cwd", () => {
		expect(withTenant(" ixara ", () => getSessionTitlePrefix("Fix the login flow", "/tmp/other-project"))).toBe(
			"IXA",
		);
	});

	it("does not prefix an explicit non-Ixara tenant", () => {
		expect(
			withTenant("acme", () => getSessionTitlePrefix("Fix the login flow", "/tmp/other-project")),
		).toBeUndefined();
	});

	it("formats an automatic title and preserves its generated remainder", () => {
		const generatedTitle = "Fix login redirect for SSO";
		expect(prefixSessionTitle(generatedTitle, "IXA")).toBe(`IXA — ${generatedTitle}`);
	});

	it("leaves the generated title unchanged when no prefix is detected", () => {
		const generatedTitle = "Fix login redirect for SSO";
		expect(prefixSessionTitle(generatedTitle, undefined)).toBe(generatedTitle);
	});

	it("does not add a duplicate prefix", () => {
		const prefixedTitle = "IXA — Fix login redirect for SSO";
		expect(prefixSessionTitle(prefixedTitle, "IXA")).toBe(prefixedTitle);
	});
});
