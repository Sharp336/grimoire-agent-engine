import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_BASE_FLOW, FlowStore } from "@oh-my-pi/pi-coding-agent/flow/flow-store";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "omp-flow-store-"));
});
afterEach(() => {
	try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("FlowStore (project-local v2)", () => {
	test("first use seeds from bundled base flow", () => {
		const store = new FlowStore({ cwd: dir });
		const flow = store.load();
		expect(flow.version).toBe(1);
		expect(flow.id).toBe(BUNDLED_BASE_FLOW.id);
		expect(Object.keys(flow.nodes)).toContain("chat");
		const p = join(dir, ".omp", "flow.json");
		expect(existsSync(p)).toBe(true);
	});

	test("subsequent load returns on-disk version even if it differs", () => {
		const store = new FlowStore({ cwd: dir });
		store.load(); // seed
		// hand-edit the file
		const p = join(dir, ".omp", "flow.json");
		const edited = { version: 1, id: "edited", nodes: { root: {} }, edges: [] };
		const { writeFileSync } = require("node:fs");
		writeFileSync(p, JSON.stringify(edited));
		const store2 = new FlowStore({ cwd: dir });
		const reloaded = store2.load();
		expect(reloaded.id).toBe("edited");
		expect(Object.keys(reloaded.nodes)).toEqual(["root"]);
	});

	test("save writes to the project dir", () => {
		const store = new FlowStore({ cwd: dir });
		store.load();
		const custom = { version: 1 as const, id: "custom", nodes: { a: {} }, edges: [] };
		store.save(custom);
		const raw = readFileSync(join(dir, ".omp", "flow.json"), "utf8");
		expect(JSON.parse(raw).id).toBe("custom");
	});
});
