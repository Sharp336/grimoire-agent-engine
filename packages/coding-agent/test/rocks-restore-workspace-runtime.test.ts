import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import type { EngineAttachmentDescriptor } from "../src/engine/contracts";
import { runEngineCommand } from "../src/engine/control-query";
import { dispatchEngineCommand, type EngineCommandEnvelope, engineCommandIdentity } from "../src/engine/nats-adapter";
import type { RestoreWorkspacePlan } from "../src/engine/rocks-restore-workspace";
import { RocksEngineStore } from "../src/engine/rocks-runtime-store";
import { engineAgentInstanceId } from "../src/engine/route";
import { EngineRuntime } from "../src/engine/runtime";
import { EngineAttachmentUploads } from "../src/engine/runtime-attachments";
import { AuthStorage } from "../src/session/auth-storage";
import { BlobStore } from "../src/session/blob-store";
import { parseNativeSessionLocator, RocksNativeSessionStorage } from "../src/session/rocks-native-session-storage";
import { startStorageWorker, storageBlobsDir } from "./helpers/storage-worker-fixture";

const executable = process.env.ARTEL_STORAGE_TEST_RUNTIME_EXE;
const runRoot = process.env.ARTEL_STORAGE_TEST_RUN_ROOT;
const digest = (value: unknown) => new Bun.CryptoHasher("sha256").update(stableStringifyJson(value)).digest("hex");

it.skipIf(!(executable && runRoot))(
	"continues a queued attachment after isolated restore in the same native session without replay",
	async () => {
		registerMockApi("rocks-restore-workspace-runtime-test");
		const root = await fs.mkdtemp(path.join(runRoot!, "rebind-runtime-"));
		const sourceRoot = path.join(root, "source");
		const targetRoot = path.join(root, "target");
		const sourceWork = path.join(sourceRoot, "work");
		const targetWork = path.join(targetRoot, "work");
		await fs.mkdir(sourceWork, { recursive: true });
		await fs.mkdir(targetWork, { recursive: true });
		const sourceCwd = await fs.realpath(sourceWork);
		const targetCwd = await fs.realpath(targetWork);
		const sourceSentinel = path.join(sourceCwd, "source-only.txt");
		await fs.writeFile(sourceSentinel, "source workspace must stay untouched\n");
		await fs.writeFile(path.join(sourceCwd, "workspace-marker.txt"), "source workspace marker\n");
		await fs.writeFile(path.join(targetCwd, "workspace-marker.txt"), "target workspace marker\n");
		const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
		let worker = await startStorageWorker(executable!, sourceRoot, token, 1);
		let sourceWorker: typeof worker | undefined;
		let runtime: EngineRuntime | undefined;
		const authStorage = await AuthStorage.create(path.join(root, "test-auth.db"));
		authStorage.setRuntimeApiKey("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(root, "test-models.yml"));
		const savedEnv = {
			binding: process.env.GRIMOIRE_STORAGE_BINDING,
			epoch: process.env.GRIMOIRE_STORAGE_RESTORE_ID,
			plan: process.env.GRIMOIRE_STORAGE_RESTORE_WORKSPACE_REBIND,
			workRoot: process.env.GRIMOIRE_ENGINE_WORK_ROOT,
			blobs: process.env.PI_BLOBS_DIR,
		};
		const suffix = crypto.randomUUID();
		const agentInstanceRef = `grimoire://tasks/grimoire/restore-fixture/agents/${suffix}`;
		const agentInstanceId = engineAgentInstanceId(agentInstanceRef);
		const principalId = `owner-${suffix}`;
		try {
			process.env.GRIMOIRE_STORAGE_BINDING = JSON.stringify(worker.binding);
			process.env.GRIMOIRE_ENGINE_WORK_ROOT = sourceCwd;
			delete process.env.GRIMOIRE_STORAGE_RESTORE_ID;
			delete process.env.GRIMOIRE_STORAGE_RESTORE_WORKSPACE_REBIND;
			const sourceModel = createMockModel({ handler: () => ({ content: ["retained answer"] }) });
			const sourceBlobs = new BlobStore(storageBlobsDir(sourceRoot));
			process.env.PI_BLOBS_DIR = sourceBlobs.dir;
			runtime = await EngineRuntime.create({
				databasePath: path.join(sourceRoot, "engine.sqlite"),
				attachmentBlobStore: sourceBlobs,
				sessionDefaults: {
					cwd: sourceCwd,
					agentDir: sourceRoot,
					settings: await Settings.loadReadOnly({ cwd: sourceCwd, agentDir: sourceRoot }),
					model: sourceModel.model,
					modelRegistry,
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
				},
			});
			const profile = { spawns: "" as const, profileDigest: "fixture-profile", enableMCP: false, enableLsp: false };
			const first = await runtime.start(
				{
					commandId: `first-${suffix}`,
					agentInstanceId,
					agentInstanceRef,
					principalId,
					executionId: `first-execution-${suffix}`,
					attemptId: `first-attempt-${suffix}`,
					authorityGeneration: 1,
					cwd: sourceCwd,
					input: "retained question",
				},
				profile,
			);
			await runtime.drain();
			expect(sourceModel.calls).toHaveLength(1);
			const sourceStore = new RocksEngineStore(worker.client);
			const sourceBinding = await sourceStore.getBinding(agentInstanceId);
			expect(sourceBinding?.sessionFile).toMatch(/^native:/);
			const locator = parseNativeSessionLocator(sourceBinding!.sessionFile!);
			const sourceNative = new RocksNativeSessionStorage(worker.client, locator.familyId, locator.generationId);
			const sourceContext = await sourceNative.readContext();
			const sessionId = sourceContext.checkpoint.header.id;
			expect(JSON.stringify(sourceContext.entries)).toContain("retained answer");
			await runtime.dispose();
			runtime = undefined;
			const sourceBeforeBackup = await sourceNative.readContext();
			await sourceStore.branchIntent(agentInstanceId, `pause-${suffix}`, "pause");
			const body = Buffer.from("queued restore attachment, exact bytes\n");
			const bodyHash = new Bun.CryptoHasher("sha256").update(body).digest("hex");
			const clientMessageId = `queued-${suffix}`;
			const uploadId = `upload-${suffix}`;
			const uploads = new EngineAttachmentUploads(
				path.join(sourceRoot, "uploads"),
				sourceBlobs,
				sourceStore.records,
			);
			const attachment: EngineAttachmentDescriptor = {
				uploadId,
				clientMessageId,
				name: "note.txt",
				mediaType: "text/plain",
				bytes: body.length,
				contentHash: `sha256:${bodyHash}`,
			};
			expect(
				(await uploads.stage(principalId, { ...attachment, offset: 0, contentBase64: body.toString("base64") }))
					.complete,
			).toBe(true);
			const queued = await sourceStore.enqueueInboxItem(
				{ ...first, sessionId },
				{
					sourceEventId: clientMessageId,
					sourceType: "user",
					body: "read queued note",
					createdAt: Date.now(),
					attachments: { principalId, uploadIds: [uploadId] },
				},
			);
			expect(queued.created).toBe(true);
			await uploads.remove(principalId, uploadId);
			const backupId = `backup-${suffix}`;
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
								operationId: backupId,
							},
						}),
					},
				);
				const result = (await response.json()) as { backup?: { status: string }; error?: { message: string } };
				if (!response.ok) throw new Error(result.error?.message ?? `Backup HTTP ${response.status}`);
				return result.backup!;
			};
			let status = await backup("backup_start");
			for (let attempt = 0; attempt < 200 && status.status === "running"; attempt++) {
				await Bun.sleep(50);
				status = await backup("backup_status");
			}
			expect(status.status).toBe("complete");
			const backupDir = path.join(sourceRoot, "backups", backupId);
			const manifestBytes = await fs.readFile(path.join(backupDir, "manifest.json"));
			const manifest = JSON.parse(manifestBytes.toString("utf8")) as { instance_id: string };
			await worker.stop();
			const restore = Bun.spawn(
				[
					executable!,
					"restore",
					"--backup",
					backupDir,
					"--target",
					path.join(targetRoot, "storage"),
					"--minimum-incarnation",
					String(worker.incarnation + 1),
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			if ((await restore.exited) !== 0)
				throw new Error(`Storage restore failed: ${await new Response(restore.stderr).text()}`);
			const targetBlobs = new BlobStore(storageBlobsDir(targetRoot));
			process.env.PI_BLOBS_DIR = targetBlobs.dir;
			worker = await startStorageWorker(executable!, targetRoot, token, 1);
			sourceWorker = await startStorageWorker(executable!, sourceRoot, token, 2);
			await expect(fs.access(path.join(targetCwd, "source-only.txt"))).rejects.toMatchObject({ code: "ENOENT" });
			const restoreEpoch = crypto.randomUUID();
			const planBody = {
				schema: "artel.storage.workspace_rebind.v1" as const,
				operationId: `restore-${suffix}`,
				backupId,
				manifestHash: new Bun.CryptoHasher("sha256").update(manifestBytes).digest("hex"),
				sourceStorageInstance: manifest.instance_id,
				restoreEpoch,
				targetWorkRoot: targetCwd,
				mappings: [{ source: sourceCwd, destination: targetCwd }],
			};
			const plan: RestoreWorkspacePlan = { ...planBody, planHash: digest(planBody) };
			process.env.GRIMOIRE_STORAGE_BINDING = JSON.stringify(worker.binding);
			process.env.GRIMOIRE_STORAGE_RESTORE_ID = restoreEpoch;
			process.env.GRIMOIRE_STORAGE_RESTORE_WORKSPACE_REBIND = JSON.stringify(plan);
			process.env.GRIMOIRE_ENGINE_WORK_ROOT = targetCwd;
			const seenContexts: string[] = [];
			const staleTurnStarted = Promise.withResolvers<void>();
			const releaseStaleTurn = Promise.withResolvers<void>();
			const targetModel = createMockModel({
				handler: async context => {
					seenContexts.push(JSON.stringify(context.messages));
					if (seenContexts.length === 1) {
						staleTurnStarted.resolve();
						await releaseStaleTurn.promise;
						return { content: ["stale turn must not finish"] };
					}
					if (seenContexts.length === 2)
						return { content: [{ type: "toolCall", name: "read", arguments: { path: "workspace-marker.txt" } }] };
					if (seenContexts.length === 3) {
						expect(seenContexts[2]).toContain("target workspace marker");
						expect(seenContexts[2]).not.toContain("source workspace marker");
					}
					return { content: ["continued answer"] };
				},
			});
			const createTargetRuntime = async () =>
				EngineRuntime.create({
					databasePath: path.join(targetRoot, "engine.sqlite"),
					attachmentBlobStore: targetBlobs,
					sessionDefaults: {
						cwd: targetCwd,
						agentDir: targetRoot,
						settings: await Settings.loadReadOnly({ cwd: targetCwd, agentDir: targetRoot }),
						model: targetModel.model,
						modelRegistry,
						disableExtensionDiscovery: true,
						skills: [],
						contextFiles: [],
						promptTemplates: [],
						slashCommands: [],
						enableMCP: false,
						enableLsp: false,
					},
				});
			runtime = await createTargetRuntime();
			const cold = await runtime.store.nativeSessionHeader(first);
			expect(cold).toEqual({ sessionId, cwd: targetCwd });
			expect(targetModel.calls).toHaveLength(0);
			const intent = await runtime.store.intent(agentInstanceId);
			const stale = await runtime.start(
				{
					commandId: `stale-${suffix}`,
					agentInstanceId,
					agentInstanceRef,
					principalId,
					executionId: `stale-execution-${suffix}`,
					attemptId: `stale-attempt-${suffix}`,
					authorityGeneration: 1,
					cwd: targetCwd,
					input: "stale turn",
					expectedIntentRevision: intent.intentRevision,
					explicitContinue: true,
				},
				profile,
			);
			await staleTurnStarted.promise;
			const cancelled = await runtime.cancel({
				...stale,
				commandId: `cancel-stale-${suffix}`,
				expectedIntentRevision: stale.intentRevision,
			});
			releaseStaleTurn.resolve();
			await runtime.drain();
			expect((await runtime.store.getAttempt(stale.attemptId))?.state).toBe("cancelled");
			expect((await runtime.store.getInboxItemByQueueId(queued.item.queueId))?.disposition).toBe("pending");
			const unsupportedProfile = {
				...profile,
				profileDigest: "fixture-profile-without-read",
				toolNames: ["bash", "task"],
			};
			const rejectedStart: EngineCommandEnvelope = {
				schema: "grimoire.engine.command.v1",
				commandId: `rejected-${suffix}`,
				op: "start",
				deviceId: "fixture-device",
				engineId: "fixture-engine",
				engineGeneration: runtime.engineGeneration,
				agentInstanceId,
				agentInstanceRef,
				principalId,
				executionId: `rejected-execution-${suffix}`,
				attemptId: `rejected-attempt-${suffix}`,
				authorityGeneration: 1,
				issuedAt: Date.now(),
				payload: {
					cwd: targetCwd,
					queueId: queued.item.queueId,
					expectedRevision: queued.item.revision,
					mutationId: `reject-deliver-${suffix}`,
					expectedIntentRevision: cancelled.intentRevision,
					explicitContinue: true,
					profileDigest: unsupportedProfile.profileDigest,
					launchProfile: unsupportedProfile,
				},
			};
			const rejectedIdentity = engineCommandIdentity(rejectedStart);
			expect((await runtime.store.admitCommand(rejectedIdentity, runtime.engineGeneration)).status).toBe("claimed");
			await expect(
				dispatchEngineCommand({
					runtime,
					command: rejectedStart,
					resolveLaunchProfile: () => unsupportedProfile,
					provisionMailbox: async () => {},
				}),
			).rejects.toMatchObject({
				code: "attachment_requires_read",
				message: expect.stringContaining('"note.txt"'),
			});
			await runtime.recordCommandRejection({
				commandId: rejectedStart.commandId,
				agentInstanceId,
				executionId: rejectedStart.executionId!,
				attemptId: rejectedStart.attemptId!,
				authorityGeneration: 1,
				code: "attachment_requires_read",
				message: 'File "note.txt" cannot be sent',
				operation: "start",
			});
			const rejectedAdmission = await runtime.store.admitCommand(rejectedIdentity, runtime.engineGeneration);
			expect(rejectedAdmission.status).toBe("replay");
			if (rejectedAdmission.status !== "replay") throw new Error("Rejected Start did not settle");
			expect(rejectedAdmission.receipt.outcome).toBe("rejected");
			expect(rejectedAdmission.receipt.detail?.code).toBe("attachment_requires_read");
			expect(await runtime.store.getAttempt(rejectedStart.attemptId!)).toBeUndefined();
			expect((await runtime.store.getBinding(agentInstanceId))?.attemptId).toBe(stale.attemptId);
			expect((await runtime.store.getInboxItemByQueueId(queued.item.queueId))?.disposition).toBe("pending");
			// The refused Start leaves no pending target, so the retained item can start again.
			expect((await runtime.store.runtimeSummary({ principalId, agentInstanceRef })).summary).toMatchObject({
				pendingStart: null,
			});
			const command: EngineCommandEnvelope = {
				schema: "grimoire.engine.command.v1",
				commandId: `continue-${suffix}`,
				op: "start",
				deviceId: "fixture-device",
				engineId: "fixture-engine",
				engineGeneration: runtime.engineGeneration,
				agentInstanceId,
				agentInstanceRef,
				principalId,
				executionId: `continued-execution-${suffix}`,
				attemptId: `continued-attempt-${suffix}`,
				authorityGeneration: 1,
				issuedAt: Date.now(),
				payload: {
					cwd: targetCwd,
					queueId: queued.item.queueId,
					expectedRevision: queued.item.revision,
					mutationId: `deliver-${suffix}`,
					expectedIntentRevision: cancelled.intentRevision,
					explicitContinue: true,
					profileDigest: profile.profileDigest,
					launchProfile: profile,
				},
			};
			const receipt = await runEngineCommand(
				{
					runtime,
					deviceId: command.deviceId,
					engineId: command.engineId,
					resolveLaunchProfile: () => profile,
					provisionMailbox: async () => {},
				},
				command,
			);
			expect(receipt.outcome).toBe("applied");
			const continued = (await runtime.store.getBinding(agentInstanceId))!;
			await runtime.drain();
			expect(continued.sessionFile).toBe(sourceBinding!.sessionFile);
			const targetNative = new RocksNativeSessionStorage(worker.client, locator.familyId, locator.generationId);
			const targetContext = await targetNative.readContext();
			expect(targetContext.checkpoint.header.id).toBe(sessionId);
			expect(targetContext.checkpoint.header.cwd).toBe(targetCwd);
			expect(seenContexts.join("\n")).toContain("retained answer");
			expect(seenContexts).toHaveLength(3);
			expect(await targetBlobs.get(bodyHash)).toEqual(body);
			const inbox = (await new RocksEngineStore(worker.client).records.get("inbox", clientMessageId)).value;
			expect(inbox?.disposition).toBe("acknowledged");
			expect(await runtime.store.nativeSessionHeader(continued)).toEqual({ sessionId, cwd: targetCwd });
			await runtime.dispose();
			runtime = undefined;
			delete process.env.GRIMOIRE_STORAGE_RESTORE_ID;
			delete process.env.GRIMOIRE_STORAGE_RESTORE_WORKSPACE_REBIND;
			runtime = await createTargetRuntime();
			expect(await runtime.store.nativeSessionHeader(continued)).toEqual({ sessionId, cwd: targetCwd });
			const afterRestart = await runtime.start(
				{
					commandId: `after-restart-${suffix}`,
					agentInstanceId,
					agentInstanceRef,
					principalId,
					executionId: `after-restart-execution-${suffix}`,
					attemptId: `after-restart-attempt-${suffix}`,
					authorityGeneration: 1,
					cwd: targetCwd,
					input: "second target question",
					explicitContinue: true,
				},
				profile,
			);
			await runtime.drain();
			expect(afterRestart.sessionFile).toBe(sourceBinding!.sessionFile);
			expect(seenContexts).toHaveLength(4);
			expect(seenContexts[3]).toContain("continued answer");
			const finalContext = await targetNative.readContext();
			expect(finalContext.checkpoint.header.id).toBe(sessionId);
			expect(finalContext.checkpoint.header.cwd).toBe(targetCwd);
			const sourceAfter = await new RocksNativeSessionStorage(
				sourceWorker.client,
				locator.familyId,
				locator.generationId,
			).readContext();
			expect(sourceAfter.checkpoint.header.cwd).toBe(sourceCwd);
			expect(sourceAfter.entries).toEqual(sourceBeforeBackup.entries);
			expect(await fs.readFile(sourceSentinel, "utf8")).toBe("source workspace must stay untouched\n");
			expect(await fs.readFile(path.join(sourceCwd, "workspace-marker.txt"), "utf8")).toBe(
				"source workspace marker\n",
			);
		} finally {
			await runtime?.dispose();
			await sourceWorker?.stop();
			await worker.stop();
			authStorage.close();
			for (const [key, value] of [
				["GRIMOIRE_STORAGE_BINDING", savedEnv.binding],
				["GRIMOIRE_STORAGE_RESTORE_ID", savedEnv.epoch],
				["GRIMOIRE_STORAGE_RESTORE_WORKSPACE_REBIND", savedEnv.plan],
				["GRIMOIRE_ENGINE_WORK_ROOT", savedEnv.workRoot],
				["PI_BLOBS_DIR", savedEnv.blobs],
			] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	},
	60_000,
);
