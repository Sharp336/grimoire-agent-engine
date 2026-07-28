import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "bun:test";
import { loadSiteCatalog, validateSiteRecipe } from "../secrets/broker/site-catalog";

const VALID_RECIPE = {
	domain: "example.com",
	tier: 1,
	loginUrl: "https://example.com/login",
	changePasswordUrl: "https://example.com/account/password",
	usernameField: "#username",
	passwordField: "#password",
	newPasswordField: "#new-password",
	submitButton: "button[type=submit]",
};

describe("Phase C Task C2: site catalog", () => {
	let dir: string;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	it("validateSiteRecipe accepts a complete Tier-1 recipe", () => {
		const errors = validateSiteRecipe(VALID_RECIPE);
		expect(errors).toEqual([]);
	});

	it("validateSiteRecipe rejects a missing required field", () => {
		const recipe = { ...VALID_RECIPE, passwordField: undefined } as unknown as typeof VALID_RECIPE;
		const errors = validateSiteRecipe(recipe);
		expect(errors.some(e => e.includes("passwordField"))).toBe(true);
	});

	it("validateSiteRecipe rejects an out-of-range tier", () => {
		const errors = validateSiteRecipe({ ...VALID_RECIPE, tier: 9 });
		expect(errors.some(e => e.includes("tier"))).toBe(true);
	});

	it("validateSiteRecipe rejects a non-https loginUrl", () => {
		const errors = validateSiteRecipe({ ...VALID_RECIPE, loginUrl: "ftp://example.com" });
		expect(errors.some(e => e.includes("loginUrl"))).toBe(true);
	});

	it("validateSiteRecipe rejects a non-object entry", () => {
		expect(validateSiteRecipe("nope")).not.toEqual([]);
		expect(validateSiteRecipe(null)).not.toEqual([]);
	});

	it("loadSiteCatalog loads a valid catalog file", () => {
		dir = mkdtempSync(join(tmpdir(), "catalog-test-"));
		const path = join(dir, "catalog.json");
		writeFileSync(path, JSON.stringify([VALID_RECIPE]));
		const catalog = loadSiteCatalog(path);
		expect(catalog).toHaveLength(1);
		expect(catalog[0].domain).toBe("example.com");
	});

	it("loadSiteCatalog returns an empty array for an empty catalog", () => {
		dir = mkdtempSync(join(tmpdir(), "catalog-test-"));
		const path = join(dir, "catalog.json");
		writeFileSync(path, "[]");
		expect(loadSiteCatalog(path)).toEqual([]);
	});

	it("loadSiteCatalog fails closed on an invalid entry with per-entry errors", () => {
		dir = mkdtempSync(join(tmpdir(), "catalog-test-"));
		const path = join(dir, "catalog.json");
		writeFileSync(path, JSON.stringify([VALID_RECIPE, { domain: "bad" }]));
		expect(() => loadSiteCatalog(path)).toThrow(/bad|index 1/i);
	});

	it("loadSiteCatalog fails closed on missing file", () => {
		expect(() => loadSiteCatalog(join(tmpdir(), "definitely-missing-catalog.json"))).toThrow();
	});

	it("loadSiteCatalog fails closed on non-array JSON", () => {
		dir = mkdtempSync(join(tmpdir(), "catalog-test-"));
		const path = join(dir, "catalog.json");
		writeFileSync(path, "{}");
		expect(() => loadSiteCatalog(path)).toThrow();
	});
});
