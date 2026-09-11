import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type EngineAttachment, EngineAttachmentUploads } from "@oh-my-pi/pi-coding-agent/engine/runtime-attachments";
import { BLOB_RANGE_BYTES, BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import { withOriginalAttachmentNotices } from "@oh-my-pi/pi-coding-agent/session/original-attachments";
import { collectPersistedBlobHashes } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MAX_IMAGE_INPUT_BYTES } from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { TempDir } from "@oh-my-pi/pi-utils";

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
		const uploads = new EngineAttachmentUploads(
			path.join(temp.path(), "uploads"),
			new BlobStore(path.join(temp.path(), "blobs")),
		);
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
		const uploads = new EngineAttachmentUploads(path.join(temp.path(), "uploads"), blobs);
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
		const canonical = path.join(blobs.dir, attachment.contentHash.slice(7));
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
		const uploads = new EngineAttachmentUploads(
			path.join(temp.path(), "uploads"),
			new BlobStore(path.join(temp.path(), "blobs")),
		);
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
		await expect(uploads.resolveMessage("message-a", references)).rejects.toThrow("owner");
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
				uploadIds: Array.from({ length: 2000 }, (_, index) => `${index}-${"x".repeat(180)}`),
			}),
		).rejects.toThrow("byte budget");
		const cancelled = new AbortController();
		cancelled.abort(new Error("delivery cancelled"));
		await expect(
			uploads.resolveMessage("message-a", { principalId: "alice", uploadIds: ["first"] }, cancelled.signal),
		).rejects.toThrow("delivery cancelled");
		await uploads.remove("alice", "second");
		await expect(
			uploads.resolveMessage("message-a", { principalId: "alice", uploadIds: ["first", "second"] }),
		).rejects.toThrow("removed");
		expect(
			(await uploads.resolveMessage("message-a", { principalId: "alice", uploadIds: ["first"] })).map(
				attachment => attachment.uploadId,
			),
		).toEqual(["first"]);
	});

	it("resumes exact chunks after restart, deduplicates retries, and binds ready bytes to owner plus message", async () => {
		using temp = TempDir.createSync("@omp-attachment-");
		const root = path.join(temp.path(), "uploads");
		const blobs = new BlobStore(path.join(temp.path(), "blobs"));
		let uploads = new EngineAttachmentUploads(root, blobs);
		const data = Buffer.alloc(BLOB_RANGE_BYTES * 2 + 13, 71);
		const attachment = identity(data);
		const first = { ...attachment, offset: 0, contentBase64: data.subarray(0, BLOB_RANGE_BYTES).toString("base64") };
		expect(await uploads.stage("alice", first)).toMatchObject({ complete: false, nextOffset: BLOB_RANGE_BYTES });
		await expect(uploads.resolve("alice", "message-a", "upload-a")).rejects.toThrow("not ready");
		uploads = new EngineAttachmentUploads(root, blobs);
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
		expect(await uploads.resolve("alice", "message-a", "upload-a")).toEqual(attachment);
		await expect(uploads.resolve("bob", "message-a", "upload-a")).rejects.toThrow("owner");
		await expect(uploads.resolve("alice", "message-b", "upload-a")).rejects.toThrow("message");
		await expect(uploads.stage("alice", { ...last, name: "changed.png" })).rejects.toThrow("identity changed");
		expect(await fs.readFile(path.join(blobs.dir, attachment.contentHash.slice(7)))).toEqual(data);
		const [dir] = await fs.readdir(root);
		expect(await fs.readdir(path.join(root, dir!))).toEqual(["manifest.json"]);
		expect(await uploads.remove("alice", "upload-a")).toEqual({ removed: true });
		await expect(new EngineAttachmentUploads(root, blobs).stage("alice", last)).rejects.toThrow("removed");
		await expect(uploads.resolve("alice", "message-a", "upload-a")).rejects.toThrow("removed");
		expect(await fs.readFile(path.join(blobs.dir, attachment.contentHash.slice(7)))).toEqual(data);
	});

	it("recovers a torn chunk only when the prefix matches, and removal fences even a not-yet-arrived upload", async () => {
		using temp = TempDir.createSync("@omp-attachment-");
		const root = path.join(temp.path(), "uploads");
		const blobs = new BlobStore(path.join(temp.path(), "blobs"));
		const uploads = new EngineAttachmentUploads(root, blobs);
		const data = Buffer.alloc(BLOB_RANGE_BYTES + 11, 67);
		const attachment = identity(data);
		const first = { ...attachment, offset: 0, contentBase64: data.subarray(0, BLOB_RANGE_BYTES).toString("base64") };
		await uploads.stage("alice", first);
		const [dir] = await fs.readdir(root);
		const payload = path.join(root, dir!, "payload.bin");
		await fs.truncate(payload, 107);
		const resumed = new EngineAttachmentUploads(root, blobs);
		await expect(
			resumed.stage("alice", { ...first, contentBase64: Buffer.alloc(BLOB_RANGE_BYTES, 1).toString("base64") }),
		).rejects.toThrow("conflicts");
		expect((await fs.stat(payload)).size).toBe(107);
		expect(await resumed.stage("alice", first)).toMatchObject({ nextOffset: BLOB_RANGE_BYTES, complete: false });
		expect(await fs.readFile(payload)).toEqual(data.subarray(0, BLOB_RANGE_BYTES));
		await resumed.remove("alice", "late-upload");
		await expect(resumed.stage("alice", { ...first, uploadId: "late-upload" })).rejects.toThrow("removed");
		await resumed.remove("alice", "upload-a");
		expect(await fs.readdir(path.join(root, dir!))).toEqual(["manifest.json", "removed"]);
		// Removing one owner's id cannot fence another owner's upload with the same id.
		expect(await resumed.stage("bob", first)).toMatchObject({ complete: false, nextOffset: BLOB_RANGE_BYTES });
	});

	it("rejects invalid bytes, paths, changed identity and linked storage, without publishing failed content", async () => {
		using temp = TempDir.createSync("@omp-attachment-");
		const root = path.join(temp.path(), "uploads");
		const blobs = new BlobStore(path.join(temp.path(), "blobs"));
		const uploads = new EngineAttachmentUploads(root, blobs);
		const data = Buffer.from("file content");
		const attachment = identity(data);
		const request = { ...attachment, offset: 0, contentBase64: data.toString("base64") };
		await expect(uploads.stage("", request)).rejects.toThrow("owner");
		await expect(uploads.stage("alice", { ...request, name: "../secret" })).rejects.toThrow("filename");
		await expect(uploads.stage("alice", { ...request, contentBase64: "invalid!" })).rejects.toThrow("canonical");
		await expect(uploads.stage("alice", { ...request, contentHash: `sha256:${"0".repeat(64)}` })).rejects.toThrow(
			"hash",
		);
		expect(await fs.readdir(blobs.dir)).toEqual([]);
		await uploads.remove("alice", attachment.uploadId);
		const aborted = new AbortController();
		aborted.abort(new Error("cancelled"));
		await expect(
			uploads.stage("alice", { ...request, uploadId: "cancelled-upload" }, aborted.signal),
		).rejects.toThrow("cancelled");
		const linked = path.join(temp.path(), "linked");
		await fs.symlink(root, linked, process.platform === "win32" ? "junction" : "dir");
		try {
			await expect(new EngineAttachmentUploads(linked, blobs).stage("alice", request)).rejects.toThrow("unsafe");
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
});
