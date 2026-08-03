/**
 * Focused contract tests for validateSettingsValues — path-scoped
 * enabledModels/disabledProviders entries, typed record members, quoted
 * dotted-key rejection, and shared PI_CONFIG_FILES overlay helpers.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	loadConfigOverlayFile,
	type RawSettings,
	resolveConfigOverlayPaths,
	validateSettingsValues,
} from "@oh-my-pi/pi-coding-agent/config/settings";

describe("validateSettingsValues", () => {
	it("accepts a supported path-scoped enabledModels entry", () => {
		const result = validateSettingsValues({
			enabledModels: [{ path: "/repo", models: ["openai/model"] }],
		});
		expect(result.errors).toEqual([]);
	});

	it("accepts a supported path-scoped disabledProviders entry", () => {
		const result = validateSettingsValues({
			disabledProviders: [{ path: "/repo", providers: ["ollama"] }],
		});
		expect(result.errors).toEqual([]);
	});

	it("still rejects invalid path-scoped array member shapes", () => {
		const result = validateSettingsValues({
			enabledModels: ["ok", 42],
		});
		expect(result.errors.some(error => error.includes("enabledModels[1]") && error.includes("number"))).toBe(true);
	});

	it("reports invalid providers.maxInFlightRequests members", () => {
		const result = validateSettingsValues({
			providers: { maxInFlightRequests: { openai: "nope" } },
		});
		expect(
			result.errors.some(error => error.includes("Provider request limits must be positive numbers: openai")),
		).toBe(true);
	});

	it("rejects non-string task override record values", () => {
		const result = validateSettingsValues({
			task: {
				agentModelOverrides: { task_fast: 7 },
				agentPrewalk: { task_budget: false },
			},
		});
		expect(result.errors).toContain('Settings key "task.agentModelOverrides.task_fast" must be a string, got number');
		expect(result.errors).toContain('Settings key "task.agentPrewalk.task_budget" must be a string, got boolean');
	});

	it("accepts string-valued task override records", () => {
		const result = validateSettingsValues({
			task: {
				agentModelOverrides: { task_fast: "openai/gpt-5" },
				agentPrewalk: { task_budget: "openai/gpt-5-mini" },
			},
		});
		expect(result.errors).toEqual([]);
	});

	describe("quoted dotted keys are rejected before known-path/prefix checks", () => {
		it("errors on a top-level quoted dotted key that stringifies to a known path", () => {
			// `"theme.dark"` is one object key; runtime getByPath splits to theme → dark.
			const raw: RawSettings = { "theme.dark": "anthracite" };
			const { errors, warnings } = validateSettingsValues(raw);
			expect(warnings).toEqual([]);
			expect(errors).toEqual([
				'Settings key "theme.dark" is a quoted dotted key and is ignored at runtime; use nested mappings instead',
			]);
		});

		it("errors on a nested quoted dotted key under a known prefix", () => {
			const raw: RawSettings = { theme: { "dark.extra": "x" } };
			const { errors, warnings } = validateSettingsValues(raw);
			expect(warnings).toEqual([]);
			expect(errors).toEqual([
				'Settings key "theme.dark.extra" is a quoted dotted key and is ignored at runtime; use nested mappings instead',
			]);
		});

		it("does not launder children under a dotted namespace key via knownPrefixes", () => {
			// Without the guard, `"task.isolation"` matches knownPrefixes and
			// `mode` would be accepted as known path `task.isolation.mode`.
			const raw: RawSettings = { "task.isolation": { mode: "none", bogus: true } };
			const { errors, warnings } = validateSettingsValues(raw);
			expect(warnings).toEqual([]);
			expect(errors).toEqual([
				'Settings key "task.isolation" is a quoted dotted key and is ignored at runtime; use nested mappings instead',
			]);
		});

		it("still accepts properly nested known paths", () => {
			const raw: RawSettings = { theme: { dark: "anthracite" } };
			const { errors, warnings } = validateSettingsValues(raw);
			expect(errors).toEqual([]);
			expect(warnings).toEqual([]);
		});
	});
});

describe("resolveConfigOverlayPaths", () => {
	const original = process.env.PI_CONFIG_FILES;
	afterEach(() => {
		if (original === undefined) delete process.env.PI_CONFIG_FILES;
		else process.env.PI_CONFIG_FILES = original;
	});

	it("resolves PI_CONFIG_FILES against cwd with tilde expansion, then appends explicit files", () => {
		const cwd = path.join(os.tmpdir(), "omp-overlay-resolve-cwd");
		process.env.PI_CONFIG_FILES = ["~/overlay-a.yml", "rel-b.yml"].join(path.delimiter);
		const explicit = path.join(cwd, "explicit.yml");
		const resolved = resolveConfigOverlayPaths(cwd, [explicit]);
		expect(resolved).toEqual([path.join(os.homedir(), "overlay-a.yml"), path.join(cwd, "rel-b.yml"), explicit]);
	});

	it("returns only explicit files when PI_CONFIG_FILES is unset", () => {
		delete process.env.PI_CONFIG_FILES;
		const cwd = "/tmp/omp-overlay-empty";
		expect(resolveConfigOverlayPaths(cwd, ["one.yml"])).toEqual([path.resolve(cwd, "one.yml")]);
		expect(resolveConfigOverlayPaths(cwd)).toEqual([]);
	});
});

describe("loadConfigOverlayFile", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("parses a mapping and applies migrateRawSettingsShape", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-overlay-load-"));
		roots.push(root);
		const file = path.join(root, "overlay.yml");
		// queueMode migrates to steeringMode
		fs.writeFileSync(file, "queueMode: all\n");
		const loaded = await loadConfigOverlayFile(file);
		expect(loaded.steeringMode).toBe("all");
		expect(loaded.queueMode).toBeUndefined();
	});

	it("rejects a missing overlay file", async () => {
		const missing = path.join(os.tmpdir(), "omp-overlay-missing-nope.yml");
		await expect(loadConfigOverlayFile(missing)).rejects.toThrow(`Config overlay not found: ${missing}`);
	});

	it("rejects a non-mapping overlay root", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-overlay-scalar-"));
		roots.push(root);
		const file = path.join(root, "overlay.yml");
		fs.writeFileSync(file, "- just\n- a\n- list\n");
		await expect(loadConfigOverlayFile(file)).rejects.toThrow(`Config overlay must be a YAML mapping: ${file}`);
	});
});
