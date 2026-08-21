import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	createMemoryRuntimeContext,
	memoryBackendSupports,
	resolveMemoryBackend,
} from "@oh-my-pi/pi-coding-agent/memory-backend";

describe("resolveMemoryBackend", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("returns the hindsight backend when memory.backend is hindsight, regardless of legacy memories.enabled", async () => {
		const a = Settings.isolated({ "memory.backend": "hindsight", "memories.enabled": false });
		const b = Settings.isolated({ "memory.backend": "hindsight", "memories.enabled": true });
		expect((await resolveMemoryBackend(a)).id).toBe("hindsight");
		expect((await resolveMemoryBackend(b)).id).toBe("hindsight");
	});

	it("exposes inactive status when no session is available", async () => {
		const memory = createMemoryRuntimeContext({ agentDir: "/tmp/agent", cwd: "/tmp/project" });

		await expect(memory.status()).resolves.toMatchObject({
			backend: "off",
			active: false,
			writable: false,
			searchable: false,
		});
	});

	it("reports local backend runtime status as writable (lessons) without structured search", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const memory = createMemoryRuntimeContext({
			agentDir: "/tmp/agent",
			cwd: "/tmp/project",
			session: { settings } as never,
		});

		await expect(memory.status()).resolves.toMatchObject({
			backend: "local",
			active: true,
			writable: true,
			searchable: false,
		});
		await expect(memory.search("project preference")).resolves.toMatchObject({
			backend: "local",
			count: 0,
		});
	});

	it("declares the exact operation surface for active remote and local backends", () => {
		expect(memoryBackendSupports("hindsight", "recall")).toBe(true);
		expect(memoryBackendSupports("hindsight", "exact-read")).toBe(false);
		expect(memoryBackendSupports("mnemopi", "edit")).toBe(true);
		expect(memoryBackendSupports("local", "retain")).toBe(false);
		expect(memoryBackendSupports("off", "reflect")).toBe(false);
	});

	it("returns truthful unsupported explicit-operation results", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const memory = createMemoryRuntimeContext({
			agentDir: "/tmp/agent",
			cwd: "/tmp/project",
			session: { settings } as never,
		});

		await expect(memory.get("memory-id")).resolves.toMatchObject({
			backend: "local",
			id: "memory-id",
			status: "not_addressable",
		});
		await expect(memory.edit("forget", "memory-id")).resolves.toMatchObject({
			backend: "local",
			id: "memory-id",
			status: "not_editable",
		});
		await expect(memory.reflect("project preference")).resolves.toMatchObject({
			backend: "local",
			query: "project preference",
			count: 0,
		});
	});
});
