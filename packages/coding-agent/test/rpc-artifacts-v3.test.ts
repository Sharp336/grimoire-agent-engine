import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { validateRpcCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-command-registry";
import { ArtifactManager, MAX_ARTIFACT_RANGE_BYTES } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("RPC v3 artifact authority", () => {
	let tempDir: TempDir;

	afterEach(() => tempDir?.removeSync());

	function createManager(): ArtifactManager {
		tempDir = TempDir.createSync("omp-rpc-artifacts-");
		return new ArtifactManager(path.join(tempDir.path(), "artifacts"));
	}

	test("keeps stable metadata from allocation through durable content", async () => {
		const manager = createManager();
		const allocation = await manager.allocatePath("bash", {
			sessionId: "session-1",
			turnId: "turn-7",
			toolCallId: "call-9",
		});

		await expect(manager.describe(allocation.id)).resolves.toEqual({
			id: allocation.id,
			mediaType: "text/plain; charset=utf-8",
			byteLength: null,
			sha256: null,
			provenance: { source: "tool_output", toolName: "bash" },
			related: { sessionId: "session-1", turnId: "turn-7", toolCallId: "call-9" },
			lifecycle: "pending",
			cancellation: { cancelled: false },
		});

		await Bun.write(allocation.path, "abcdef");
		const available = await manager.describe(allocation.id);
		expect(available).toMatchObject({
			id: allocation.id,
			byteLength: 6,
			sha256: "bef57ec7f53a6d40beb640a780a639c83bc29ac8a9816f1fc6c5c6dcd93c4721",
			lifecycle: "available",
		});

		const resumed = new ArtifactManager(manager.dir);
		await expect(resumed.describe(allocation.id)).resolves.toEqual(available);
	});

	test("reads only bounded binary-safe ranges", async () => {
		const manager = createManager();
		const allocation = await manager.allocatePath("eval", { sessionId: "session-1" });
		await Bun.write(allocation.path, new Uint8Array([0, 1, 2, 253, 254, 255]));

		await expect(manager.readRange(allocation.id, { offset: 2, length: 3 })).resolves.toMatchObject({
			offset: 2,
			byteLength: 3,
			eof: false,
			encoding: "base64",
			data: Buffer.from([2, 253, 254]).toString("base64"),
		});
		await expect(manager.readRange(allocation.id, { offset: 5, length: 64 })).resolves.toMatchObject({
			offset: 5,
			byteLength: 1,
			eof: true,
			data: Buffer.from([255]).toString("base64"),
		});
		await expect(
			manager.readRange(allocation.id, { offset: 0, length: MAX_ARTIFACT_RANGE_BYTES + 1 }),
		).rejects.toThrow("range length");
	});

	test("exports atomically only when source and destination hashes verify", async () => {
		const manager = createManager();
		const allocation = await manager.allocatePath("read", { sessionId: "session-1" });
		await Bun.write(allocation.path, "verified export");
		const descriptor = await manager.describe(allocation.id);
		if (!descriptor.sha256) throw new Error("Expected artifact hash");

		const destination = path.join(tempDir.path(), "export.txt");
		await expect(manager.exportTo(allocation.id, destination, descriptor.sha256)).resolves.toEqual({
			path: destination,
			byteLength: 15,
			sha256: descriptor.sha256,
			verified: true,
		});
		expect(await Bun.file(destination).text()).toBe("verified export");

		const rejected = path.join(tempDir.path(), "rejected.txt");
		await expect(manager.exportTo(allocation.id, rejected, "0".repeat(64))).rejects.toThrow("hash mismatch");
		await expect(fs.stat(rejected)).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("preserves readable partial content while exposing cancellation", async () => {
		const manager = createManager();
		const allocation = await manager.allocatePath("bash", { sessionId: "session-1", toolCallId: "call-1" });
		await Bun.write(allocation.path, "partial");
		await manager.cancel(allocation.id, "tool_cancelled");

		await expect(manager.describe(allocation.id)).resolves.toMatchObject({
			lifecycle: "cancelled",
			byteLength: 7,
			cancellation: { cancelled: true, reason: "tool_cancelled" },
		});
		await expect(manager.readRange(allocation.id, { offset: 0, length: 7 })).resolves.toMatchObject({
			byteLength: 7,
			eof: true,
		});
	});

	test("validates bounded artifact RPC commands before dispatch", () => {
		expect(
			validateRpcCommand({
				id: "read-1",
				type: "artifact_read",
				artifactId: "7",
				offset: 0,
				length: MAX_ARTIFACT_RANGE_BYTES,
			}),
		).toMatchObject({ ok: true, scheduling: "serial" });
		expect(
			validateRpcCommand({
				id: "read-2",
				type: "artifact_read",
				artifactId: "7",
				length: MAX_ARTIFACT_RANGE_BYTES + 1,
			}),
		).toMatchObject({ ok: false, command: "artifact_read", code: "invalid_request" });
		expect(
			validateRpcCommand({
				id: "export-1",
				type: "artifact_export",
				artifactId: "7",
				destination: "output.txt",
				expectedSha256: "not-a-hash",
			}),
		).toMatchObject({ ok: false, command: "artifact_export", code: "invalid_request" });
	});
});
