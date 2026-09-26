import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	attachmentUploadKey,
	type EngineAttachment,
	EngineAttachmentUploads,
} from "@oh-my-pi/pi-coding-agent/engine/runtime-attachments";
import { runtimeLimits } from "@oh-my-pi/pi-coding-agent/engine/runtime-protocol";
import { RuntimeRecords, RuntimeTransaction } from "@oh-my-pi/pi-coding-agent/engine/runtime-records";
import { BLOB_RANGE_BYTES, BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { withOriginalAttachmentNotices } from "@oh-my-pi/pi-coding-agent/session/original-attachments";
import { collectPersistedBlobHashes } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { StorageClient } from "@oh-my-pi/pi-coding-agent/session/storage-client";
import {
	STORAGE_PROTOCOL_SCHEMA_HASH,
	type StorageRuntimeKey,
	type StorageRuntimeRecord,
} from "@oh-my-pi/pi-coding-agent/session/storage-protocol";
import { MAX_IMAGE_INPUT_BYTES } from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { TempDir } from "@oh-my-pi/pi-utils";

/** The Rocks runtime ledger as the storage owner applies it: exact rows, atomic puts and deletes. */
class MemoryRecords extends RuntimeRecords {
	readonly rows = new Map<string, StorageRuntimeRecord>();
	constructor() {
		super(
			new StorageClient({
				url: "http://127.0.0.1:1",
				token: "test-only-not-a-credential",
				incarnation: 1,
				protocolHash: STORAGE_PROTOCOL_SCHEMA_HASH,
			}),
		);
	}
	override async getMany(keys: StorageRuntimeKey[]): Promise<StorageRuntimeRecord[]> {
		return keys.map(({ kind, id }) =>
			structuredClone(this.rows.get(`${kind}:${id}`) ?? { kind, id, revision: null, value: null }),
		);
	}
	override async mutate<T>(_scope: string, work: (tx: RuntimeTransaction) => Promise<T>): Promise<T> {
		const tx = new RuntimeTransaction(this, true);
		const result = await work(tx);
		const { puts, deletes } = tx.mutation();
		for (const { kind, id, value } of puts) this.rows.set(`${kind}:${id}`, { kind, id, revision: 1, value });
		for (const { kind, id } of deletes) this.rows.delete(`${kind}:${id}`);
		return result;
	}
}

function uploadsAt(root: string, blobs: BlobStore, records = new MemoryRecords()): EngineAttachmentUploads {
	return new EngineAttachmentUploads(root, blobs, records);
}

function identity(bytes: Buffer, uploadId = "upload-a"): EngineAttachment {
	return {
		uploadId,
		clientMessageId: "message-a",
		name: "diagram.png",
		mediaType: "image/png",
		bytes: bytes.length,
		contentHash: `sha256:${new Bun.SHA256().update(bytes).digest("hex")}`,
	};
}

describe("Engine attachment admission", () => {
	it("does not lend file handles to another message with the same timestamp or lose handles when rebuilding history", () => {
		const manager = SessionManager.inMemory();
		const original = identity(Buffer.from("file"));
		manager.appendMessage({ role: "user", content: "file owner", timestamp: 1 }, { originalAttachments: [original] });
		manager.appendMessage({ role: "user", content: "unrelated caption", timestamp: 1 });
		const messages = manager.buildSessionContext().messages;
		const converted = withOriginalAttachmentNotices(messages, manager.getBranch(), () => undefined);
		expect(JSON.stringify(converted[0])).toContain(`attachment://original/entry/${manager.getBranch()[0].id}/0`);
		expect(JSON.stringify(converted[1])).not.toContain("attachment://");
		expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain("attachment://");
	});

	it("archives only validated original user attachments and never retains upload authority in portable metadata", () => {
		const manager = SessionManager.inMemory();
		const attachment = identity(Buffer.from("original file"));
		const originalAttachments = [{ ...attachment, principalId: "private-owner", path: "private-local-path" }];
		manager.appendMessage({ role: "user", content: "file caption", timestamp: 1 }, { originalAttachments });
		originalAttachments[0]!.name = "mutated.txt";
		const entries = manager.getBranch();
		expect(entries[0]).toHaveProperty("originalAttachments", [
			{
				name: attachment.name,
				mediaType: attachment.mediaType,
				bytes: attachment.bytes,
				contentHash: attachment.contentHash,
			},
		]);
		expect(collectPersistedBlobHashes(entries)).toEqual([attachment.contentHash.slice(7)]);
		expect(
			collectPersistedBlobHashes([
				{ type: "message", message: { role: "assistant" }, originalAttachments },
				{ type: "custom", originalAttachments },
				{ type: "message", message: { role: "user", content: [{ originalAttachments }] } },
			]),
		).toEqual([]);
		for (const invalid of [
			{ ...attachment, name: "../escape" },
			{ ...attachment, mediaType: "image/png\r\nInjected: header" },
			{ ...attachment, bytes: -1 },
			{ ...attachment, contentHash: "sha256:../../escape" },
		]) {
			expect(() =>
				manager.appendMessage(
					{ role: "user", content: "invalid", timestamp: 2 },
					{ originalAttachments: [invalid] },
				),
			).toThrow("Invalid original attachment descriptor");
			expect(() =>
				collectPersistedBlobHashes([
					{ type: "message", message: { role: "user" }, originalAttachments: [invalid] },
				]),
			).toThrow("Invalid original attachment descriptor");
		}
		expect(manager.getBranch()).toEqual(entries);
		expect(() =>
			collectPersistedBlobHashes([
				{ type: "message", message: { role: "user" }, originalAttachments: Array(2000).fill(attachment) },
			]),
		).toThrow("metadata budget");
	});

	it("applies the cumulative model-image budget before materializing a batch of individually permitted uploads", async () => {
		using temp = TempDir.createSync("@omp-image-batch-budget-");
		const uploads = uploadsAt(path.join(temp.path(), "uploads"), new BlobStore(path.join(temp.path(), "blobs")));
		const data = Buffer.alloc(MAX_IMAGE_INPUT_BYTES / 2 + 1, 1);
		for (const uploadId of ["one", "two"]) {
			const attachment = identity(data, uploadId);
			for (let offset = 0; offset < data.length; offset += BLOB_RANGE_BYTES)
				await uploads.stage("alice", {
					...attachment,
					offset,
					contentBase64: data.subarray(offset, offset + BLOB_RANGE_BYTES).toString("base64"),
				});
		}
		await expect(
			uploads.prepareForMessage("message-a", { principalId: "alice", uploadIds: ["one", "two"] }),
		).rejects.toThrow("image-input byte budget");
		expect(
			(await uploads.resolveMessage("message-a", { principalId: "alice", uploadIds: ["one", "two"] })).map(
				attachment => attachment.bytes,
			),
		).toEqual([data.length, data.length]);
	});

	it("checks image bytes again at delivery and keeps nonimage originals outside the model image payload", async () => {
		using temp = TempDir.createSync("@omp-attachment-image-");
		const blobs = new BlobStore(path.join(temp.path(), "blobs"));
		const uploads = uploadsAt(path.join(temp.path(), "uploads"), blobs);
		const png = Buffer.from(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
			"base64",
		);
		const attachment = identity(png);
		await uploads.stage("alice", { ...attachment, offset: 0, contentBase64: png.toString("base64") });
		const references = { principalId: "alice", uploadIds: [attachment.uploadId] };
		expect(await uploads.prepareForMessage("message-a", references)).toEqual({
			images: [{ type: "image", mimeType: "image/png", data: png.toString("base64") }],
			originalAttachments: [
				{
					name: attachment.name,
					mediaType: attachment.mediaType,
					bytes: attachment.bytes,
					contentHash: attachment.contentHash,
				},
			],
		});
		const canonical = path.join(blobs.liveDir, attachment.contentHash.slice(7));
		await fs.writeFile(canonical, Buffer.alloc(png.length, 65));
		await expect(uploads.prepareForMessage("message-a", references)).rejects.toThrow("SHA-256");
		await fs.writeFile(canonical, png);
		for (const mediaType of ["image/jpeg", "application/pdf"]) {
			const uploadId = mediaType === "image/jpeg" ? "wrong-mime" : "file";
			await uploads.stage("alice", {
				...attachment,
				uploadId,
				mediaType,
				offset: 0,
				contentBase64: png.toString("base64"),
			});
			if (mediaType === "image/jpeg")
				await expect(
					uploads.prepareForMessage("message-a", { ...references, uploadIds: [uploadId] }),
				).rejects.toThrow("declared image type");
			else
				expect(
					await uploads.prepareForMessage("message-a", { ...references, uploadIds: [uploadId] }),
				).toMatchObject({
					images: [],
					originalAttachments: [{ mediaType: "application/pdf", contentHash: attachment.contentHash }],
				});
		}
		await fs.unlink(canonical);
		await expect(uploads.prepareForMessage("message-a", references)).rejects.toThrow("no longer retained");
	});

	it("resolves only explicitly ordered uploads for one message, without partial success or caller mutation", async () => {
		using temp = TempDir.createSync("@omp-attachment-message-");
		const uploads = uploadsAt(path.join(temp.path(), "uploads"), new BlobStore(path.join(temp.path(), "blobs")));
		const data = Buffer.from("retained attachment bytes");
		for (const uploadId of ["first", "second", "unselected"]) {
			await uploads.stage("alice", {
				...identity(data, uploadId),
				offset: 0,
				contentBase64: data.toString("base64"),
			});
		}
		const references = { principalId: "alice", uploadIds: ["second", "first"] };
		const resolving = uploads.resolveMessage("message-a", references);
		references.principalId = "bob";
		references.uploadIds.reverse();
		expect((await resolving).map(attachment => attachment.uploadId)).toEqual(["second", "first"]);
		await expect(uploads.resolveMessage("message-b", { principalId: "alice", uploadIds: ["first"] })).rejects.toThrow(
			"message",
		);
		await expect(uploads.resolveMessage("message-a", references)).rejects.toMatchObject({
			code: "attachment_expired",
		});
		await expect(
			uploads.resolveMessage("message-a", { principalId: "alice", uploadIds: ["first", "first"] }),
		).rejects.toThrow("duplicate");
		await expect(uploads.resolveMessage("message-a", { principalId: "alice", uploadIds: [] })).rejects.toThrow(
			"upload IDs",
		);
		await expect(
			uploads.resolveMessage("message-a", { principalId: "alice", uploadIds: ["../first"] }),
		).rejects.toThrow();
		await expect(
			uploads.resolveMessage("message-a", {
				principalId: "alice",
				uploadIds: Array.from({ length: 129 }, (_, index) => `upload-${index}`),
			}),
		).rejects.toThrow("at most 128");
		const cancelled = new AbortController();
		cancelled.abort(new Error("delivery cancelled"));
		await expect(
			uploads.resolveMessage("message-a", { principalId: "alice", uploadIds: ["first"] }, cancelled.signal),
		).rejects.toThrow("delivery cancelled");
		await uploads.remove("alice", "second");
		await expect(
			uploads.resolveMessage("message-a", { principalId: "alice", uploadIds: ["first", "second"] }),
		).rejects.toMatchObject({ code: "attachment_expired" });
		expect(
			(await uploads.resolveMessage("message-a", { principalId: "alice", uploadIds: ["first"] })).map(
				attachment => attachment.uploadId,
			),
		).toEqual(["first"]);
	});

	it("resumes exact chunks after restart, keeps only the ready row once complete, and binds it to owner plus message", async () => {
		using temp = TempDir.createSync("@omp-attachment-");
		const root = path.join(temp.path(), "uploads");
		const blobs = new BlobStore(path.join(temp.path(), "blobs"));
		const records = new MemoryRecords();
		let uploads = uploadsAt(root, blobs, records);
		const data = Buffer.alloc(BLOB_RANGE_BYTES * 2 + 13, 71);
		const attachment = identity(data);
		const first = { ...attachment, offset: 0, contentBase64: data.subarray(0, BLOB_RANGE_BYTES).toString("base64") };
		expect(await uploads.stage("alice", first)).toMatchObject({ complete: false, nextOffset: BLOB_RANGE_BYTES });
		// Pending is only `<root>/<key>/payload.bin`: no manifest, no row.
		const [dir] = await fs.readdir(root);
		expect(await fs.readdir(path.join(root, dir!))).toEqual(["payload.bin"]);
		expect(records.rows.size).toBe(0);
		await expect(uploads.resolve("alice", "message-a", "upload-a")).rejects.toMatchObject({
			code: "attachment_expired",
		});
		uploads = uploadsAt(root, blobs, records);
		expect(await uploads.stage("alice", first)).toMatchObject({ complete: false, nextOffset: BLOB_RANGE_BYTES });
		const second = {
			...attachment,
			offset: BLOB_RANGE_BYTES,
			contentBase64: data.subarray(BLOB_RANGE_BYTES, BLOB_RANGE_BYTES * 2).toString("base64"),
		};
		await Promise.all([uploads.stage("alice", second), uploads.stage("alice", second)]);
		const last = {
			...attachment,
			offset: BLOB_RANGE_BYTES * 2,
			contentBase64: data.subarray(BLOB_RANGE_BYTES * 2).toString("base64"),
		};
		expect(await uploads.stage("alice", last)).toEqual({ attachment, nextOffset: data.length, complete: true });
		expect(await uploads.stage("alice", last)).toEqual({ attachment, nextOffset: data.length, complete: true });
		// Ready is only the Rocks row that owns the linked body; the upload directory is gone.
		expect(await fs.readdir(root)).toEqual([]);
		expect([...records.rows.values()]).toEqual([
			{
				kind: "metadata",
				id: `blob-upload:${dir}`,
				revision: 1,
				value: {
					subtype: "blob_upload",
					state: "ready",
					owner_hash: new Bun.SHA256().update("alice").digest("hex"),
					attachment,
					ready_at: expect.any(Number),
				},
			},
		]);
		expect(await fs.readdir(path.join(blobs.intentsDir, attachment.contentHash.slice(7)))).toEqual([]);
		expect(await uploads.resolve("alice", "message-a", "upload-a")).toEqual(attachment);
		await expect(uploads.resolve("bob", "message-a", "upload-a")).rejects.toMatchObject({
			code: "attachment_expired",
		});
		await expect(uploads.resolve("alice", "message-b", "upload-a")).rejects.toThrow("message");
		await expect(uploads.stage("alice", { ...last, name: "changed.png" })).rejects.toThrow("identity changed");
		expect(await uploads.remove("alice", "upload-a")).toEqual({ removed: true });
		expect(records.rows.size).toBe(0);
		// A removed draft cannot resume; its body is left to the storage owner, never deleted here.
		await expect(uploadsAt(root, blobs, records).stage("alice", last)).rejects.toThrow("offset zero");
		await expect(uploads.resolve("alice", "message-a", "upload-a")).rejects.toMatchObject({
			code: "attachment_expired",
		});
		expect(await fs.readFile(path.join(blobs.liveDir, attachment.contentHash.slice(7)))).toEqual(data);
	});

	it("recovers a torn chunk only when the prefix matches, and asks for a fresh upload when the whole file is torn", async () => {
		using temp = TempDir.createSync("@omp-attachment-");
		const root = path.join(temp.path(), "uploads");
		const blobs = new BlobStore(path.join(temp.path(), "blobs"));
		const records = new MemoryRecords();
		const uploads = uploadsAt(root, blobs, records);
		const data = Buffer.alloc(BLOB_RANGE_BYTES + 11, 67);
		const attachment = identity(data);
		const first = { ...attachment, offset: 0, contentBase64: data.subarray(0, BLOB_RANGE_BYTES).toString("base64") };
		await uploads.stage("alice", first);
		const [dir] = await fs.readdir(root);
		const payload = path.join(root, dir!, "payload.bin");
		await fs.truncate(payload, 107);
		const resumed = uploadsAt(root, blobs, records);
		await expect(
			resumed.stage("alice", { ...first, contentBase64: Buffer.alloc(BLOB_RANGE_BYTES, 1).toString("base64") }),
		).rejects.toThrow("conflicts");
		expect((await fs.stat(payload)).size).toBe(107);
		expect(await resumed.stage("alice", first)).toMatchObject({ nextOffset: BLOB_RANGE_BYTES, complete: false });
		expect(await fs.readFile(payload)).toEqual(data.subarray(0, BLOB_RANGE_BYTES));
		// An OS crash can tear already acknowledged bytes; the final hash rejects them once, not on every retry.
		const torn = Buffer.from(data.subarray(0, BLOB_RANGE_BYTES));
		torn[5] ^= 0xff;
		await fs.writeFile(payload, torn);
		const last = {
			...attachment,
			offset: BLOB_RANGE_BYTES,
			contentBase64: data.subarray(BLOB_RANGE_BYTES).toString("base64"),
		};
		await expect(resumed.stage("alice", last)).rejects.toMatchObject({ code: "source_unavailable" });
		expect(await fs.readdir(root)).toEqual([]);
		expect(await fs.readdir(blobs.liveDir)).toEqual([]);
		expect(records.rows.size).toBe(0);
		await expect(resumed.stage("alice", last)).rejects.toThrow("offset zero");
		expect(await resumed.stage("alice", first)).toMatchObject({ nextOffset: BLOB_RANGE_BYTES, complete: false });
		await resumed.remove("alice", "upload-a");
		expect(await fs.readdir(root)).toEqual([]);
	});

	it("sweeps only pending uploads idle for a day", async () => {
		using temp = TempDir.createSync("@omp-attachment-sweep-");
		const root = path.join(temp.path(), "uploads");
		const blobs = new BlobStore(path.join(temp.path(), "blobs"));
		const uploads = uploadsAt(root, blobs);
		const data = Buffer.from("ab");
		for (const uploadId of ["stale", "fresh"])
			await uploads.stage("alice", { ...identity(data, uploadId), offset: 0, contentBase64: "YQ==" });
		const stale = attachmentUploadKey("alice", "stale").key;
		const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
		await fs.utimes(path.join(root, stale, "payload.bin"), old, old);
		await uploads.sweepAbandoned();
		expect(await fs.readdir(root)).toEqual([attachmentUploadKey("alice", "fresh").key]);
	});

	it("rejects invalid bytes, paths, changed identity and linked storage, without publishing failed content", async () => {
		using temp = TempDir.createSync("@omp-attachment-");
		const root = path.join(temp.path(), "uploads");
		const blobs = new BlobStore(path.join(temp.path(), "blobs"));
		const uploads = uploadsAt(root, blobs);
		const data = Buffer.from("file content");
		const attachment = identity(data);
		const request = { ...attachment, offset: 0, contentBase64: data.toString("base64") };
		await expect(uploads.stage("", request)).rejects.toThrow("owner");
		await expect(uploads.stage("alice", { ...request, name: "../secret" })).rejects.toThrow("filename");
		await expect(uploads.stage("alice", { ...request, contentBase64: "invalid!" })).rejects.toThrow("canonical");
		await expect(uploads.stage("alice", { ...request, contentHash: `sha256:${"0".repeat(64)}` })).rejects.toThrow(
			"upload the file again",
		);
		expect(await fs.readdir(blobs.liveDir).catch(() => [])).toEqual([]);
		await uploads.remove("alice", attachment.uploadId);
		const aborted = new AbortController();
		aborted.abort(new Error("cancelled"));
		await expect(
			uploads.stage("alice", { ...request, uploadId: "cancelled-upload" }, aborted.signal),
		).rejects.toThrow("cancelled");
		const linked = path.join(temp.path(), "linked");
		await fs.symlink(root, linked, process.platform === "win32" ? "junction" : "dir");
		try {
			await expect(uploadsAt(linked, blobs).stage("alice", request)).rejects.toThrow("unsafe");
		} finally {
			await fs.unlink(linked);
		}
		const empty = identity(Buffer.alloc(0), "empty");
		expect(await uploads.stage("alice", { ...empty, offset: 0, contentBase64: "" })).toMatchObject({
			complete: true,
			nextOffset: 0,
		});
		expect(await uploads.resolve("alice", empty.clientMessageId, empty.uploadId)).toEqual(empty);
	});

	it("rejects an oversized file and a 129th file of one message before staging a byte", async () => {
		using temp = TempDir.createSync("@omp-attachment-limits-");
		const root = path.join(temp.path(), "uploads");
		const uploads = uploadsAt(root, new BlobStore(path.join(temp.path(), "blobs")));
		const chunk = Buffer.from("a");
		const request = (uploadId: string) => ({
			...identity(Buffer.from("ab"), uploadId),
			offset: 0,
			contentBase64: chunk.toString("base64"),
		});
		await expect(
			uploads.stage("alice", { ...request("huge"), bytes: runtimeLimits.maxAttachmentBytes + 1 }),
		).rejects.toThrow("MiB file limit");
		await expect(fs.readdir(root)).rejects.toThrow();
		for (let index = 0; index < runtimeLimits.maxAttachmentsPerMessage; index++)
			await uploads.stage("alice", request(`upload-${index}`));
		await expect(uploads.stage("alice", request("one-too-many"))).rejects.toThrow("at most 128");
		expect(await fs.readdir(root)).toHaveLength(runtimeLimits.maxAttachmentsPerMessage);
		// A resumed upload is already counted, and removing one frees its slot.
		expect(await uploads.stage("alice", request("upload-0"))).toMatchObject({ nextOffset: 1 });
		await uploads.remove("alice", "upload-0");
		expect(await uploads.stage("alice", request("one-too-many"))).toMatchObject({ nextOffset: 1 });
		// The limit is per message, not per owner.
		expect(await uploads.stage("alice", { ...request("other"), clientMessageId: "message-b" })).toMatchObject({
			nextOffset: 1,
		});
	});
});
