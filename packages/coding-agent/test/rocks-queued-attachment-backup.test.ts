import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "../src/config/settings";
import type { EngineAttachmentDescriptor, EngineBindingSnapshot } from "../src/engine/contracts";
import { RocksEngineStore } from "../src/engine/rocks-runtime-store";
import { engineAgentInstanceId } from "../src/engine/route";
import { EngineRuntime } from "../src/engine/runtime";
import { EngineAttachmentUploads } from "../src/engine/runtime-attachments";
import type { EngineCommandIdentity } from "../src/engine/store";
import { BlobStore } from "../src/session/blob-store";
import { startStorageWorker, storageBlobsDir } from "./helpers/storage-worker-fixture";

const executable = process.env.ARTEL_STORAGE_TEST_RUNTIME_EXE;
const runRoot = process.env.ARTEL_STORAGE_TEST_RUN_ROOT;

it.skipIf(!(executable && runRoot))(
	"restores an accepted queued attachment into a fresh worker and delivers it on explicit Continue",
	async () => {
		const root = await fs.mkdtemp(path.join(runRoot!, "queued-attachment-"));
		console.log(`Queued attachment fixture: ${root}`);
		const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
		let worker = await startStorageWorker(executable!, root, token, 1);
		try {
			const blobs = new BlobStore(storageBlobsDir(root));
			const store = new RocksEngineStore(worker.client);
			const uploads = new EngineAttachmentUploads(path.join(root, "uploads"), blobs, store.records);
			const suffix = crypto.randomUUID();
			const principalId = `owner-${suffix}`;
			const agentInstanceRef = `grimoire://tasks/grimoire/queue-fixture/agents/${suffix}`;
			const agentInstanceId = engineAgentInstanceId(agentInstanceRef);
			const clientMessageId = `message-${suffix}`;
			const uploadId = `upload-${suffix}`;
			const body = Buffer.from(`Example in a file: "blob:sha256:${"0".repeat(64)}"\n`);
			const hash = new Bun.SHA256().update(body).digest("hex");
			const image = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
				"base64",
			);
			const imageHash = new Bun.SHA256().update(image).digest("hex");
			const imageUploadId = `image-${suffix}`;
			const attachment = {
				uploadId,
				clientMessageId,
				name: "note.txt",
				mediaType: "text/plain",
				bytes: body.length,
				contentHash: `sha256:${hash}`,
			};
			const imageAttachment = {
				uploadId: imageUploadId,
				clientMessageId,
				name: "pixel.png",
				mediaType: "image/png",
				bytes: image.length,
				contentHash: `sha256:${imageHash}`,
			};
			expect(
				(await uploads.stage(principalId, { ...attachment, offset: 0, contentBase64: body.toString("base64") }))
					.complete,
			).toBe(true);
			expect(
				(
					await uploads.stage(principalId, {
						...imageAttachment,
						offset: 0,
						contentBase64: image.toString("base64"),
					})
				).complete,
			).toBe(true);
			const generation = await store.nextEngineGeneration();
			const command: EngineCommandIdentity = {
				commandId: `start-${suffix}`,
				operation: "start",
				deviceId: "fixture-device",
				engineId: "fixture-engine",
				engineGeneration: generation,
				agentInstanceId,
				agentInstanceRef,
				executionId: `execution-${suffix}`,
				attemptId: `attempt-${suffix}`,
				authorityGeneration: 1,
				principalId,
				payloadHash: "payload",
				canonicalHash: "canonical",
				serializedCommand: JSON.stringify({ payload: { expectedIntentRevision: 0 } }),
			};
			expect(await store.admitCommand(command, generation)).toEqual({ status: "claimed" });
			const binding: EngineBindingSnapshot = {
				commandId: command.commandId,
				agentInstanceId,
				executionId: command.executionId!,
				attemptId: command.attemptId!,
				bindingId: `binding-${suffix}`,
				engineAgentId: `family-${suffix}`,
				profileDigest: "fixture-profile",
				state: "running",
				engineGeneration: generation,
				bindingGeneration: 1,
				authorityGeneration: 1,
			};
			await store.commitAttemptTransition(binding, "running", [], {
				requireNew: true,
				settleCommandId: command.commandId,
			});
			const refs = { principalId, uploadIds: [uploadId, imageUploadId] };
			const queued = await store.enqueueInboxItem(
				{ ...binding, sessionId: `pending:${agentInstanceId}` },
				{
					sourceEventId: clientMessageId,
					sourceType: "user",
					body: "Read my file",
					createdAt: Date.now(),
					attachments: refs,
				},
			);
			expect(queued.created).toBe(true);
			expect(queued.item.attachmentDescriptors).toEqual([attachment, imageAttachment]);
			await uploads.remove(principalId, uploadId);
			await uploads.remove(principalId, imageUploadId);
			await expect(uploads.resolve(principalId, clientMessageId, uploadId)).rejects.toThrow();
			const blobPath = await blobs.existingPath(hash);
			expect(blobPath).not.toBeNull();
			const old = new Date(Date.now() - 600_000);
			await fs.utimes(blobPath!, old, old);
			const operationId = `backup-${suffix}`;
			const backup = async (operation: "backup_start" | "backup_status") => {
				const response = await fetch(
					`${worker.url}/v1/backup/${operation === "backup_start" ? "start" : "status"}`,
					{
						method: "POST",
						headers: { Authorization: `Bearer ${worker.token}`, "Content-Type": "application/json" },
						body: JSON.stringify({
							schema: "artel.storage.protocol.v1",
							version: "1.0",
							operation,
							backup: {
								requestId: crypto.randomUUID(),
								incarnation: worker.incarnation,
								operationId,
							},
						}),
					},
				);
				const result = (await response.json()) as {
					backup?: { status: string; error?: string };
					error?: { message: string };
				};
				if (!response.ok) throw new Error(result.error?.message ?? `Backup HTTP ${response.status}`);
				return result.backup!;
			};
			let status = await backup("backup_start");
			for (let attempt = 0; attempt < 200 && status.status === "running"; attempt++) {
				await Bun.sleep(50);
				status = await backup("backup_status");
			}
			expect(status.status).toBe("complete");
			const backupDir = path.join(root, "backups", operationId);
			const manifest = await Bun.file(path.join(backupDir, "manifest.json")).json();
			expect(manifest.blobs.some((item: { hash: string }) => item.hash === hash)).toBe(true);
			expect(manifest.blobs.some((item: { hash: string }) => item.hash === imageHash)).toBe(true);
			expect(await fs.readFile(path.join(backupDir, "blobs", hash))).toEqual(body);
			expect(await fs.readFile(path.join(backupDir, "blobs", imageHash))).toEqual(image);
			await Bun.sleep(6_000);
			expect(await fs.readFile(blobPath!)).toEqual(body);
			await worker.stop();
			const freshRoot = await fs.mkdtemp(path.join(runRoot!, "queued-restored-"));
			console.log(`Queued attachment restore fixture: ${freshRoot}`);
			const restoredData = path.join(freshRoot, "storage");
			const restore = Bun.spawn(
				[
					executable!,
					"restore",
					"--backup",
					backupDir,
					"--target",
					restoredData,
					"--minimum-incarnation",
					String(worker.incarnation + 1),
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const restoreExit = await restore.exited;
			if (restoreExit !== 0) throw new Error(`Storage restore failed: ${await new Response(restore.stderr).text()}`);
			expect(await fs.readdir(freshRoot)).not.toContain("uploads");
			worker = await startStorageWorker(executable!, freshRoot, token, 1);
			const resumed = new RocksEngineStore(worker.client);
			const inbox = (await resumed.records.get("inbox", clientMessageId)).value;
			const descriptors = inbox?.attachment_descriptors as EngineAttachmentDescriptor[] | undefined;
			expect(descriptors).toEqual([attachment, imageAttachment]);
			const restoredBlobs = new BlobStore(storageBlobsDir(freshRoot));
			const delivery = await new EngineAttachmentUploads(
				path.join(freshRoot, "uploads"),
				restoredBlobs,
				resumed.records,
			).prepareForMessage(clientMessageId, refs, undefined, descriptors);
			expect(delivery.originalAttachments[0]?.contentHash).toBe(attachment.contentHash);
			expect(delivery.images).toEqual([{ type: "image", mimeType: "image/png", data: image.toString("base64") }]);
			expect(await restoredBlobs.get(hash)).toEqual(body);
			const previousBinding = process.env.GRIMOIRE_STORAGE_BINDING;
			const previousBlobs = process.env.PI_BLOBS_DIR;
			process.env.GRIMOIRE_STORAGE_BINDING = JSON.stringify(worker.binding);
			process.env.PI_BLOBS_DIR = restoredBlobs.dir;
			let runtime: EngineRuntime | undefined;
			try {
				const settings = await Settings.loadReadOnly({ cwd: freshRoot, agentDir: freshRoot });
				const mock = createMockModel();
				mock.input.push("image");
				const delivered: Array<{ input: string; imageData?: string }> = [];
				runtime = await EngineRuntime.create({
					databasePath: path.join(freshRoot, "engine.sqlite"),
					attachmentBlobStore: restoredBlobs,
					sessionDefaults: {
						cwd: freshRoot,
						agentDir: freshRoot,
						settings,
						model: mock.model,
						disableExtensionDiscovery: true,
						skills: [],
						contextFiles: [],
						promptTemplates: [],
						slashCommands: [],
						enableMCP: false,
						enableLsp: false,
					},
					dispatchPrompt: async (_session, input, _identity, _kind, images) => {
						delivered.push({ input, imageData: images?.[0]?.data });
						return true;
					},
				});
				const intent = await runtime.store.intent(agentInstanceId);
				await runtime.start(
					{
						commandId: `continue-${suffix}`,
						agentInstanceId,
						agentInstanceRef,
						principalId,
						executionId: `continued-execution-${suffix}`,
						attemptId: `continued-attempt-${suffix}`,
						authorityGeneration: 1,
						cwd: freshRoot,
						queueId: queued.item.queueId,
						expectedRevision: queued.item.revision,
						mutationId: `deliver-${suffix}`,
						expectedIntentRevision: intent.intentRevision,
						explicitContinue: true,
					},
					{ spawns: "", profileDigest: "fixture-profile", enableMCP: false, enableLsp: false },
				);
				await runtime.drain();
				expect(delivered).toContainEqual({ input: "Read my file", imageData: image.toString("base64") });
			} finally {
				await runtime?.dispose();
				if (previousBinding === undefined) delete process.env.GRIMOIRE_STORAGE_BINDING;
				else process.env.GRIMOIRE_STORAGE_BINDING = previousBinding;
				if (previousBlobs === undefined) delete process.env.PI_BLOBS_DIR;
				else process.env.PI_BLOBS_DIR = previousBlobs;
			}
		} finally {
			await worker.stop();
		}
	},
	60_000,
);
