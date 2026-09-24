import * as fs from "node:fs/promises";
import * as path from "node:path";
import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import type { NativeSessionPosition } from "../session/native-session-storage";
import type { SessionHeader } from "../session/session-entries";
import { EngineTargetError } from "./contracts";
import type { RocksBinding } from "./rocks-runtime-rows";
import type { RocksEngineStore } from "./rocks-runtime-store";
import type { RuntimeTransaction } from "./runtime-records";

export interface RestoreWorkspacePlan {
	schema: "artel.storage.workspace_rebind.v1";
	operationId: string;
	backupId: string;
	manifestHash: string;
	sourceStorageInstance: string;
	restoreEpoch: string;
	targetWorkRoot: string;
	mappings: Array<{ source: string; destination: string }>;
	planHash: string;
}

export interface RestoreWorkspaceDescriptor {
	subtype: "restore_workspace";
	schema: "grimoire.engine.restore_workspace.v1";
	restoreEpoch: string;
	targetWorkRoot: string;
	targetIncarnation: number;
	plans: RestoreWorkspacePlan[];
}

export interface RestoreWorkspaceReceipt {
	subtype: "restore_workspace";
	schema: "grimoire.engine.restore_workspace_receipt.v1";
	state: "pending" | "complete";
	restoreEpoch: string;
	planHash: string;
	agentInstanceId: string;
	sessionFile: string;
	sessionId: string;
	oldCwd: string;
	originalCwd: string;
	newCwd: string;
	oldAdditionalDirectories: string[];
	newAdditionalDirectories: string[];
	oldThroughSeq: number;
	oldHeaderHash: string;
	newHeaderHash: string;
	oldProfileDigest: string;
	oldIdentityDigest: string | null;
	oldBindingId: string;
	authorityGeneration: number;
}

export interface RestoreWorkspaceResolution {
	descriptor: RestoreWorkspaceDescriptor;
	plan: RestoreWorkspacePlan;
	cwd: string;
	additionalDirectories: string[];
	originalCwd: string;
	receipt?: RestoreWorkspaceReceipt;
	checkpointNeeded: boolean;
}

const digest = (value: unknown) => new Bun.CryptoHasher("sha256").update(stableStringifyJson(value)).digest("hex");
const samePath = (left: string, right: string) =>
	path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase();
const inside = (candidate: string, root: string) => {
	const relative = path.win32.relative(root, candidate);
	return (
		relative === "" ||
		(relative !== ".." && !relative.startsWith(`..${path.win32.sep}`) && !path.win32.isAbsolute(relative))
	);
};
const fail = (message: string): never => {
	throw new EngineTargetError("stale_target", message);
};

export function restoreReceiptId(epoch: string, agentInstanceId: string, sessionFile: string): string {
	return `restore-workspace:${digest([epoch, agentInstanceId, sessionFile])}`;
}

export function validateRestorePlan(value: unknown): RestoreWorkspacePlan {
	const plan = value as RestoreWorkspacePlan;
	if (
		plan?.schema !== "artel.storage.workspace_rebind.v1" ||
		![
			plan.operationId,
			plan.backupId,
			plan.manifestHash,
			plan.sourceStorageInstance,
			plan.restoreEpoch,
			plan.targetWorkRoot,
			plan.planHash,
		].every(item => typeof item === "string" && item.length > 0) ||
		!Array.isArray(plan.mappings) ||
		plan.mappings.length < 1 ||
		plan.mappings.length > 16 ||
		plan.mappings.some(
			item =>
				typeof item.source !== "string" ||
				typeof item.destination !== "string" ||
				!path.win32.isAbsolute(item.source) ||
				!path.win32.isAbsolute(item.destination),
		) ||
		digest({ ...plan, planHash: undefined }) !== plan.planHash
	)
		fail("Restore workspace plan is incompatible");
	return plan;
}

export function restoreDescriptor(
	previous: RestoreWorkspaceDescriptor | undefined,
	plan: RestoreWorkspacePlan,
	incarnation: number,
): RestoreWorkspaceDescriptor {
	if (previous?.restoreEpoch === plan.restoreEpoch) {
		if (previous.plans.at(-1)?.planHash !== plan.planHash) fail("Restore workspace plan changed");
		return previous;
	}
	const plans = [...(previous?.plans ?? []), plan];
	if (plans.length > 4 || (previous && !plan.mappings.some(item => samePath(item.source, previous.targetWorkRoot))))
		fail("Restore workspace provenance cannot be composed");
	return {
		subtype: "restore_workspace",
		schema: "grimoire.engine.restore_workspace.v1",
		restoreEpoch: plan.restoreEpoch,
		targetWorkRoot: plan.targetWorkRoot,
		targetIncarnation: incarnation,
		plans,
	};
}

export async function loadRestoreDescriptor(store: RocksEngineStore): Promise<RestoreWorkspaceDescriptor | undefined> {
	const value = (await store.records.get("metadata", "restore-workspace")).value as RestoreWorkspaceDescriptor | null;
	if (!value) return undefined;
	const configured = process.env.GRIMOIRE_ENGINE_WORK_ROOT;
	if (
		value.subtype !== "restore_workspace" ||
		value.schema !== "grimoire.engine.restore_workspace.v1" ||
		value.restoreEpoch !== (await store.getStoreEpoch()) ||
		value.targetIncarnation > store.storageClient.incarnation ||
		!configured ||
		!samePath(configured, value.targetWorkRoot) ||
		!Array.isArray(value.plans) ||
		value.plans.length < 1 ||
		value.plans.length > 4 ||
		value.plans.at(-1)?.restoreEpoch !== value.restoreEpoch ||
		value.plans.some(plan => validateRestorePlan(plan) !== plan)
	)
		fail("Restore workspace descriptor does not match the current storage and work root");
	if (!configured) throw new EngineTargetError("stale_target", "Restore work root is not configured");
	const root = await fs.realpath(configured).catch(() => fail("Restore work root is unavailable"));
	if (!samePath(root, configured)) fail("Restore work root is a link");
	return value;
}

async function availableTarget(target: string, root: string): Promise<void> {
	if (!inside(target, root)) fail("Restored workspace escapes the target work root");
	const resolved = await fs.realpath(target).catch(() => fail("Restored workspace is unavailable"));
	if (!samePath(resolved, target) || !(await fs.stat(resolved)).isDirectory())
		fail("Restored workspace contains a link or is not a directory");
}

function mapPath(value: string, plans: RestoreWorkspacePlan[]): string | undefined {
	if (inside(value, plans.at(-1)!.targetWorkRoot)) return value;
	let current = value;
	for (const plan of plans) {
		const match = plan.mappings.find(item => samePath(item.source, current));
		if (match) current = match.destination;
		else if (!inside(current, plan.targetWorkRoot)) return undefined;
	}
	return current;
}

export async function resolveRestoreWorkspace(
	store: RocksEngineStore,
	agentInstanceId: string,
	sessionFile: string,
	header: SessionHeader,
	position: NativeSessionPosition,
): Promise<RestoreWorkspaceResolution | undefined> {
	const descriptor = await loadRestoreDescriptor(store);
	if (!descriptor) return undefined;
	const plan = descriptor.plans.at(-1)!;
	const key = restoreReceiptId(descriptor.restoreEpoch, agentInstanceId, sessionFile);
	const receipt = (await store.records.get("metadata", key)).value as RestoreWorkspaceReceipt | null;
	const original = (header.additionalDirectories ?? []).slice();
	const cwd = mapPath(header.cwd, descriptor.plans) ?? fail("Restored native workspace has an unmapped cwd");
	const additionalDirectories = original.map(directory => mapPath(directory, descriptor.plans));
	if (additionalDirectories.some(directory => !directory)) {
		fail("Restored native workspace has an unmapped executable root");
	}
	await availableTarget(cwd, descriptor.targetWorkRoot);
	for (const directory of additionalDirectories) await availableTarget(directory!, descriptor.targetWorkRoot);
	let originalCwd = header.cwd;
	for (const older of descriptor.plans.slice(0, -1)) {
		const old = (
			await store.records.get("metadata", restoreReceiptId(older.restoreEpoch, agentInstanceId, sessionFile))
		).value as RestoreWorkspaceReceipt | null;
		if (old?.state === "pending") {
			originalCwd = old.originalCwd;
			break;
		}
	}
	if (receipt) {
		if (
			receipt.schema !== "grimoire.engine.restore_workspace_receipt.v1" ||
			(receipt.state !== "pending" && receipt.state !== "complete") ||
			receipt.restoreEpoch !== descriptor.restoreEpoch ||
			receipt.planHash !== plan.planHash ||
			receipt.agentInstanceId !== agentInstanceId ||
			receipt.sessionFile !== sessionFile ||
			receipt.sessionId !== header.id
		)
			fail("Restore workspace receipt conflicts with native session");
		const oldHead = digest(header) === receipt.oldHeaderHash && position.throughSeq === receipt.oldThroughSeq;
		const newHead = digest(header) === receipt.newHeaderHash && position.throughSeq === receipt.oldThroughSeq + 1;
		if (receipt.state === "pending") {
			if (!samePath(receipt.newCwd, cwd) || (!oldHead && !newHead))
				fail("Restored native header changed outside its pending receipt");
		} else {
			if (
				position.throughSeq < receipt.oldThroughSeq + 1 ||
				(position.throughSeq === receipt.oldThroughSeq + 1 && !newHead) ||
				!samePath(header.cwd, cwd) ||
				original.some((directory, index) => !samePath(directory, additionalDirectories[index]!))
			)
				fail("Completed restore workspace receipt lost its target native workspace");
		}
		return {
			descriptor,
			plan,
			cwd,
			additionalDirectories: additionalDirectories as string[],
			originalCwd: receipt.originalCwd,
			receipt,
			checkpointNeeded: receipt.state === "pending" && oldHead,
		};
	}
	if (
		samePath(header.cwd, cwd) &&
		original.every((directory, index) => samePath(directory, additionalDirectories[index]!))
	)
		return undefined;
	return {
		descriptor,
		plan,
		cwd,
		additionalDirectories: additionalDirectories as string[],
		originalCwd,
		checkpointNeeded: true,
	};
}

export async function beginRestoreRebind(
	store: RocksEngineStore,
	resolution: RestoreWorkspaceResolution,
	agentInstanceId: string,
	sessionFile: string,
	header: SessionHeader,
	position: NativeSessionPosition,
): Promise<RestoreWorkspaceReceipt> {
	if (resolution.receipt) return resolution.receipt;
	const key = restoreReceiptId(resolution.descriptor.restoreEpoch, agentInstanceId, sessionFile);
	const nextHeader = {
		...header,
		cwd: resolution.cwd,
		additionalDirectories: resolution.additionalDirectories.length ? resolution.additionalDirectories : undefined,
	};
	return store.mutation(agentInstanceId, async tx => {
		const old = await tx.get<RestoreWorkspaceReceipt>("metadata", key);
		if (old) fail("Restore workspace receipt changed before rebind");
		const binding = await tx.get<RocksBinding>("binding", agentInstanceId);
		if (!binding || binding.session_file !== sessionFile || binding.authority_generation < 1)
			fail("Restored native binding changed before rebind");
		if (!binding) throw new EngineTargetError("stale_target", "Restored native binding is missing");
		const receipt: RestoreWorkspaceReceipt = {
			subtype: "restore_workspace",
			schema: "grimoire.engine.restore_workspace_receipt.v1",
			state: "pending",
			restoreEpoch: resolution.descriptor.restoreEpoch,
			planHash: resolution.plan.planHash,
			agentInstanceId,
			sessionFile,
			sessionId: header.id,
			oldCwd: header.cwd,
			originalCwd: resolution.originalCwd,
			newCwd: resolution.cwd,
			oldAdditionalDirectories: [...(header.additionalDirectories ?? [])],
			newAdditionalDirectories: resolution.additionalDirectories,
			oldThroughSeq: position.throughSeq,
			oldHeaderHash: digest(header),
			newHeaderHash: digest(nextHeader),
			oldProfileDigest: binding.profile_digest,
			oldIdentityDigest: binding.conversation_identity_digest,
			oldBindingId: binding.binding_id,
			authorityGeneration: binding.authority_generation,
		};
		await tx.put("metadata", key, receipt);
		return receipt;
	});
}

export async function completeRestoreRebind(tx: RuntimeTransaction, receipt: RestoreWorkspaceReceipt): Promise<void> {
	const key = restoreReceiptId(receipt.restoreEpoch, receipt.agentInstanceId, receipt.sessionFile);
	const current = await tx.get<RestoreWorkspaceReceipt>("metadata", key);
	const binding = await tx.get<RocksBinding>("binding", receipt.agentInstanceId);
	if (
		!current ||
		current.schema !== receipt.schema ||
		current.oldHeaderHash !== receipt.oldHeaderHash ||
		current.newHeaderHash !== receipt.newHeaderHash ||
		current.state !== "pending" ||
		!binding ||
		binding.binding_id !== receipt.oldBindingId ||
		binding.session_file !== receipt.sessionFile ||
		binding.profile_digest !== receipt.oldProfileDigest ||
		binding.conversation_identity_digest !== receipt.oldIdentityDigest ||
		binding.authority_generation !== receipt.authorityGeneration
	)
		fail("Restore workspace receipt changed before Attempt admission");
	await tx.put("metadata", key, { ...current, state: "complete" });
}
