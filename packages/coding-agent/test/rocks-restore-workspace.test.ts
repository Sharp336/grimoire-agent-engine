import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import {
	beginRestoreRebind,
	completeRestoreRebind,
	type RestoreWorkspacePlan,
	resolveRestoreWorkspace,
	restoreDescriptor,
	validateRestorePlan,
} from "../src/engine/rocks-restore-workspace";
import type { RocksBinding } from "../src/engine/rocks-runtime-rows";
import type { RocksEngineStore } from "../src/engine/rocks-runtime-store";
import type { RuntimeTransaction } from "../src/engine/runtime-records";
import type { NativeSessionPosition } from "../src/session/native-session-storage";
import type { SessionHeader } from "../src/session/session-entries";

const hash = (value: unknown) => new Bun.CryptoHasher("sha256").update(stableStringifyJson(value)).digest("hex");

it("accepts the Python ClientHost hash for a Unicode workspace plan", () => {
	const plan: RestoreWorkspacePlan = {
		schema: "artel.storage.workspace_rebind.v1",
		operationId: "op",
		backupId: "backup",
		manifestHash: "abc",
		sourceStorageInstance: "instance",
		restoreEpoch: "epoch",
		targetWorkRoot: "C:\\цель",
		mappings: [{ source: "C:\\исток", destination: "C:\\цель" }],
		planHash: "696f175a1ae3ed071efa5920e3d961c6d8c1a4373c11c30b9c380cc91d8d8801",
	};
	expect(validateRestorePlan(plan)).toBe(plan);
	expect(() =>
		validateRestorePlan({ ...plan, mappings: [{ ...plan.mappings[0], destination: "C:\\другое" }] }),
	).toThrow("Restore workspace plan is incompatible");
});

it.skipIf(process.platform !== "win32")(
	"projects cold native roots through two restores and completes a retryable receipt only with the original binding",
	async () => {
		const root = await fs.realpath(process.cwd());
		const firstRoot = await fs.realpath(path.join(root, "packages"));
		const firstExtra = await fs.realpath(path.join(firstRoot, "utils"));
		const secondRoot = await fs.realpath(path.join(firstRoot, "coding-agent"));
		const secondExtra = await fs.realpath(path.join(secondRoot, "test"));
		const source = "C:\\source\\workspace";
		const sourceExtra = "C:\\source\\shared";
		const plan = (
			restoreEpoch: string,
			targetWorkRoot: string,
			mappings: RestoreWorkspacePlan["mappings"],
		): RestoreWorkspacePlan => {
			const value = {
				schema: "artel.storage.workspace_rebind.v1" as const,
				operationId: `operation-${restoreEpoch}`,
				backupId: `backup-${restoreEpoch}`,
				manifestHash: `manifest-${restoreEpoch}`,
				sourceStorageInstance: `instance-${restoreEpoch}`,
				restoreEpoch,
				targetWorkRoot,
				mappings,
			};
			return { ...value, planHash: hash(value) };
		};
		const first = plan("epoch-1", firstRoot, [
			{ source, destination: firstRoot },
			{ source: sourceExtra, destination: firstExtra },
		]);
		let descriptor = restoreDescriptor(undefined, first, 2);
		const firstDescriptor = descriptor;
		const rows = new Map<string, unknown>([["metadata:restore-workspace", descriptor]]);
		const agentInstanceId = "restored-agent";
		const sessionFile = "native:family/generation";
		const binding = {
			binding_id: "old-binding",
			session_file: sessionFile,
			profile_digest: "old-profile",
			conversation_identity_digest: "old-identity",
			authority_generation: 1,
		} as RocksBinding;
		rows.set(`binding:${agentInstanceId}`, binding);
		const tx = {
			get: async (kind: string, id: string) => rows.get(`${kind}:${id}`) ?? null,
			put: async (kind: string, id: string, value: unknown) => {
				rows.set(`${kind}:${id}`, value);
			},
		} as unknown as RuntimeTransaction;
		const store = {
			records: { get: async (kind: string, id: string) => ({ value: rows.get(`${kind}:${id}`) ?? null }) },
			getStoreEpoch: async () => descriptor.restoreEpoch,
			storageClient: { incarnation: 3 },
			mutation: async (_agent: string, action: (transaction: RuntimeTransaction) => Promise<unknown>) => action(tx),
		} as unknown as RocksEngineStore;
		const previousRoot = process.env.GRIMOIRE_ENGINE_WORK_ROOT;
		process.env.GRIMOIRE_ENGINE_WORK_ROOT = firstRoot;
		try {
			const header: SessionHeader = {
				type: "session",
				id: "same-native-session",
				timestamp: "2026-09-24T00:00:00.000Z",
				cwd: source,
				additionalDirectories: [sourceExtra],
				providerPromptCacheKey: "same-cache-key",
			};
			const position: NativeSessionPosition = {
				familyId: "family",
				generationId: "generation",
				throughSeq: 7,
				incarnation: 3,
			};
			const cold = await resolveRestoreWorkspace(store, agentInstanceId, sessionFile, header, position);
			expect(cold?.cwd).toBe(firstRoot);
			expect(cold?.additionalDirectories).toEqual([firstExtra]);
			const receipt = await beginRestoreRebind(store, cold!, agentInstanceId, sessionFile, header, position);
			expect(receipt.state).toBe("pending");
			expect(
				(await resolveRestoreWorkspace(store, agentInstanceId, sessionFile, header, position))?.checkpointNeeded,
			).toBe(true);
			const reboundHeader = { ...header, cwd: firstRoot, additionalDirectories: [firstExtra] };
			const reboundPosition = { ...position, throughSeq: position.throughSeq + 1 };
			expect(
				(await resolveRestoreWorkspace(store, agentInstanceId, sessionFile, reboundHeader, reboundPosition))
					?.checkpointNeeded,
			).toBe(false);
			await expect(
				resolveRestoreWorkspace(store, agentInstanceId, sessionFile, reboundHeader, {
					...position,
					throughSeq: position.throughSeq + 2,
				}),
			).rejects.toThrow("pending receipt");
			await expect(
				resolveRestoreWorkspace(
					store,
					agentInstanceId,
					sessionFile,
					{ ...reboundHeader, title: "unexpected write" },
					reboundPosition,
				),
			).rejects.toThrow("pending receipt");
			const second = plan("epoch-2", secondRoot, [
				{ source: firstRoot, destination: secondRoot },
				{ source: firstExtra, destination: secondExtra },
			]);
			descriptor = restoreDescriptor(firstDescriptor, second, 3);
			rows.set("metadata:restore-workspace", descriptor);
			process.env.GRIMOIRE_ENGINE_WORK_ROOT = secondRoot;
			const pendingSecondRestore = await resolveRestoreWorkspace(
				store,
				agentInstanceId,
				sessionFile,
				reboundHeader,
				reboundPosition,
			);
			expect(pendingSecondRestore?.cwd).toBe(secondRoot);
			expect(pendingSecondRestore?.originalCwd).toBe(source);
			descriptor = firstDescriptor;
			rows.set("metadata:restore-workspace", descriptor);
			process.env.GRIMOIRE_ENGINE_WORK_ROOT = firstRoot;
			rows.set(`binding:${agentInstanceId}`, { ...binding, binding_id: "other-binding" });
			await expect(completeRestoreRebind(tx, receipt)).rejects.toThrow("receipt changed");
			rows.set(`binding:${agentInstanceId}`, binding);
			await completeRestoreRebind(tx, receipt);
			expect(
				(await resolveRestoreWorkspace(store, agentInstanceId, sessionFile, reboundHeader, reboundPosition))
					?.receipt?.state,
			).toBe("complete");
			await expect(resolveRestoreWorkspace(store, agentInstanceId, sessionFile, header, position)).rejects.toThrow(
				"lost its target native workspace",
			);
			await expect(
				resolveRestoreWorkspace(
					store,
					agentInstanceId,
					sessionFile,
					{ ...reboundHeader, title: "forged checkpoint" },
					reboundPosition,
				),
			).rejects.toThrow("lost its target native workspace");
			const advancedPosition = { ...position, throughSeq: position.throughSeq + 3 };
			const advancedHeader = { ...reboundHeader, additionalDirectories: [secondRoot], title: "later answer" };
			const continued = await resolveRestoreWorkspace(
				store,
				agentInstanceId,
				sessionFile,
				advancedHeader,
				advancedPosition,
			);
			expect(continued?.receipt?.state).toBe("complete");
			expect(continued?.checkpointNeeded).toBe(false);
			await expect(
				resolveRestoreWorkspace(
					store,
					agentInstanceId,
					sessionFile,
					{ ...advancedHeader, cwd: source },
					advancedPosition,
				),
			).rejects.toThrow("lost its target native workspace");
			await expect(
				resolveRestoreWorkspace(
					store,
					agentInstanceId,
					sessionFile,
					{ ...advancedHeader, additionalDirectories: [sourceExtra] },
					advancedPosition,
				),
			).rejects.toThrow("lost its target native workspace");
			descriptor = restoreDescriptor(descriptor, second, 3);
			rows.set("metadata:restore-workspace", descriptor);
			process.env.GRIMOIRE_ENGINE_WORK_ROOT = secondRoot;
			const movedAgain = await resolveRestoreWorkspace(
				store,
				agentInstanceId,
				sessionFile,
				reboundHeader,
				reboundPosition,
			);
			expect(movedAgain?.cwd).toBe(secondRoot);
			expect(movedAgain?.additionalDirectories).toEqual([secondExtra]);
		} finally {
			if (previousRoot === undefined) delete process.env.GRIMOIRE_ENGINE_WORK_ROOT;
			else process.env.GRIMOIRE_ENGINE_WORK_ROOT = previousRoot;
		}
	},
);
