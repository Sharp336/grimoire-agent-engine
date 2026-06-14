import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import * as path from "node:path";
import { OkfProtocolHandler } from "../../src/internal-urls/okf-protocol";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import type { InternalUrl } from "../../src/internal-urls/types";
import { getBundleRoot, writeConcept } from "../../src/okf/bundle";

let tmpDir: string;
let bundleRoot: string;
let handler: OkfProtocolHandler;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(path.join(import.meta.dir, ".okf-proto-test-"));
	bundleRoot = getBundleRoot(tmpDir);
	handler = new OkfProtocolHandler();
	await writeConcept(
		bundleRoot,
		"tables/orders",
		"---\ntype: Table\ndescription: orders, revenue\n---\n\n# Schema\n\nCol A.",
	);
	await writeConcept(
		bundleRoot,
		"playbooks/incident",
		"---\ntype: Playbook\ndescription: incident, oncall\n---\n\n# Steps",
	);
});

afterEach(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

import * as fs from "node:fs/promises";

function parseUrl(input: string): InternalUrl {
	return parseInternalUrl(input);
}

describe("okf/protocol OkfProtocolHandler.resolve", () => {
	it("lists all concepts for bare okf://", async () => {
		const res = await handler.resolve(parseUrl("okf://"), { cwd: tmpDir });
		expect(res.contentType).toBe("text/markdown");
		expect(res.content).toContain("## Table");
		expect(res.content).toContain("## Playbook");
		expect(res.content).toContain("orders");
		expect(res.content).toContain("incident");
	});

	it("lists one category for okf://tables", async () => {
		const res = await handler.resolve(parseUrl("okf://tables"), { cwd: tmpDir });
		expect(res.content).toContain("orders");
		expect(res.content).not.toContain("incident");
	});

	it("reads a single concept", async () => {
		const res = await handler.resolve(parseUrl("okf://tables/orders.md"), { cwd: tmpDir });
		expect(res.contentType).toBe("text/markdown");
		expect(res.content).toContain("type: Table");
		expect(res.content).toContain("# Schema");
	});

	it("throws for missing concept", async () => {
		await expect(handler.resolve(parseUrl("okf://tables/nonexistent.md"), { cwd: tmpDir })).rejects.toThrow();
	});

	it("throws without cwd", async () => {
		await expect(handler.resolve(parseUrl("okf://"))).rejects.toThrow("cwd");
	});

	it("blocks path traversal via category", async () => {
		// okf://.. should not escape the bundle root to read .omp/index.md.
		await expect(handler.resolve(parseUrl("okf://.."), { cwd: tmpDir })).rejects.toThrow();
	});
});

describe("okf/protocol OkfProtocolHandler.write", () => {
	it("writes a new concept", async () => {
		await handler.write(
			parseUrl("okf://tables/customers.md"),
			"---\ntype: Table\ndescription: customers, crm\n---\n\n# Schema",
			{ cwd: tmpDir },
		);
		const res = await handler.resolve(parseUrl("okf://tables/customers.md"), { cwd: tmpDir });
		expect(res.content).toContain("customers");
		expect(res.content).toContain("# Schema");
	});

	it("throws for bare okf:// write", async () => {
		await expect(handler.write(parseUrl("okf://"), "content", { cwd: tmpDir })).rejects.toThrow();
	});
});
