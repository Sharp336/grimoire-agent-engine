/**
 * Contract: `instructions` are injected into the system prompt and are only
 * readable from a live connection, so a lazy server that returns them must
 * connect at startup and must never be idle-reaped.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { MCPManager } from "../src/mcp/manager";
import { inMemoryToolCache, lazyConfig, makeWorkDir, spawnCount, waitFor } from "./mcp-lifecycle-harness";

const INSTRUCTIONS = "Fixture server instructions";

describe("MCP lazy lifecycle: instruction-carrying servers", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = makeWorkDir();
	});

	afterEach(() => {
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it("keeps instructions available across a fresh session and an idle window", async () => {
		const spawnLog = path.join(workDir, "instructions.log");
		const cache = inMemoryToolCache();
		const config = lazyConfig({ lifecycle: "lazy", idleTimeout: 50, instructions: INSTRUCTIONS, spawnLog });

		const first = new MCPManager(workDir, cache);
		try {
			await first.connectServers({ lazy: config }, {});
			expect(await waitFor(() => first.getServerInstructions().get("lazy") === INSTRUCTIONS)).toBe(true);
		} finally {
			await first.disconnectAll();
		}

		// Second session reads the warm cache: the entry must record that this
		// server needs a connection, so instructions reach the system prompt again.
		const second = new MCPManager(workDir, cache);
		try {
			await second.connectServers({ lazy: config }, {});
			expect(await waitFor(() => second.getServerInstructions().get("lazy") === INSTRUCTIONS)).toBe(true);
			// The idle reaper must not strip them either.
			await Bun.sleep(300);
			expect(second.getConnectionStatus("lazy")).toBe("connected");
			expect(second.getServerInstructions().get("lazy")).toBe(INSTRUCTIONS);
		} finally {
			await second.disconnectAll();
		}
		expect(spawnCount(spawnLog)).toBe(2);
	}, 20_000);
});

describe("MCP lazy lifecycle: tool-less servers", () => {
	let workDir: string;

	beforeEach(() => {
		workDir = makeWorkDir();
	});

	afterEach(() => {
		fs.rmSync(workDir, { recursive: true, force: true });
	});

	it("honors a warm cache entry that legitimately holds no tools", async () => {
		const spawnLog = path.join(workDir, "no-tools.log");
		const cache = inMemoryToolCache();
		const config = lazyConfig({ lifecycle: "lazy", noTools: true, spawnLog });

		const first = new MCPManager(workDir, cache);
		try {
			await first.connectServers({ lazy: config }, {});
			expect(await waitFor(() => first.getConnectionStatus("lazy") === "connected")).toBe(true);
		} finally {
			await first.disconnectAll();
		}
		expect(spawnCount(spawnLog)).toBe(1);

		// The empty list is a real answer, not a cold cache: no second spawn.
		const second = new MCPManager(workDir, cache);
		try {
			await second.connectServers({ lazy: config }, {});
			expect(second.getConnectionStatus("lazy")).toBe("disconnected");
			expect(spawnCount(spawnLog)).toBe(1);
		} finally {
			await second.disconnectAll();
		}
	}, 20_000);
});
