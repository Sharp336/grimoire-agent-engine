import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getWorkspaceRegistryPath } from "@oh-my-pi/pi-utils/dirs";
import type { SessionManager } from "./session-manager";
import type { WorkspaceBindingMetadata } from "./session-entries";

export type { WorkspaceBindingMetadata } from "./session-entries";

const REGISTRY_VERSION = 1;
const REGISTRY_FILE_PROPERTY = "__workspaceBindingRegistryFile";

export type WorkspaceBindingKind = "main" | "sub" | string;
export type WorkspaceBindingStatus = "running" | "parked" | "stopped" | "completed" | "failed" | string;

export interface WorkspaceBinding {
	sessionId: string;
	sessionFile: string;
	workspaceRoot: string;
	agentId?: string;
	kind?: WorkspaceBindingKind;
	status: WorkspaceBindingStatus;
	createdAt: string;
	lastSeenAt: string;
}

export interface RegisterWorkspaceBindingInput {
	sessionId: string;
	sessionFile: string;
	workspaceRoot: string;
	agentId?: string;
	kind?: WorkspaceBindingKind;
	status?: WorkspaceBindingStatus;
	createdAt?: string;
	lastSeenAt?: string;
}

export interface WorkspaceBindingStatusUpdate {
	status: WorkspaceBindingStatus;
	lastSeenAt?: string;
}

interface WorkspaceBindingRegistryFile {
	version: typeof REGISTRY_VERSION;
	bindings: WorkspaceBinding[];
}

export type WorkspaceBindingUnavailableCode = "WORKSPACE_BINDING_MISSING" | "WORKSPACE_MISSING";


export class WorkspaceBindingUnavailableError extends Error {
	readonly code: WorkspaceBindingUnavailableCode;
	readonly sessionId: string;
	readonly workspaceRoot: string | undefined;
	readonly fallbackCwd: string | undefined;

	constructor(options: {
		code: WorkspaceBindingUnavailableCode;
		sessionId: string;
		workspaceRoot?: string;
		fallbackCwd?: string;
	}) {
		const workspace = options.workspaceRoot ? ` workspace ${options.workspaceRoot}` : " no bound workspace";
		const fallback = options.fallbackCwd ? ` (fallback cwd ${options.fallbackCwd})` : "";
		super(`${options.code}: session ${options.sessionId} has${workspace}${fallback}`);
		this.name = "WorkspaceBindingUnavailableError";
		this.code = options.code;
		this.sessionId = options.sessionId;
		this.workspaceRoot = options.workspaceRoot;
		this.fallbackCwd = options.fallbackCwd;
	}
}

const registryFileByBinding = new WeakMap<WorkspaceBinding, string>();

function attachRegistryFile(binding: WorkspaceBinding, registryFile: string): WorkspaceBinding {
	registryFileByBinding.set(binding, registryFile);
	Object.defineProperty(binding, REGISTRY_FILE_PROPERTY, {
		value: registryFile,
		enumerable: false,
		configurable: true,
	});
	return binding;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function normalizeBinding(value: unknown): WorkspaceBinding | null {
	if (!isRecord(value)) return null;
	const sessionId = readString(value, "sessionId");
	const sessionFile = readString(value, "sessionFile");
	const workspaceRoot = readString(value, "workspaceRoot");
	const status = readString(value, "status");
	const createdAt = readString(value, "createdAt");
	const lastSeenAt = readString(value, "lastSeenAt");
	if (!sessionId || !sessionFile || !workspaceRoot || !status || !createdAt || !lastSeenAt) return null;

	const binding: WorkspaceBinding = {
		sessionId,
		sessionFile,
		workspaceRoot,
		status,
		createdAt,
		lastSeenAt,
	};
	const agentId = readString(value, "agentId");
	const kind = readString(value, "kind");
	if (agentId !== undefined) binding.agentId = agentId;
	if (kind !== undefined) binding.kind = kind;
	return binding;
}

function normalizeRegistryFile(value: unknown): WorkspaceBindingRegistryFile {
	if (!isRecord(value)) return { version: REGISTRY_VERSION, bindings: [] };
	const source = Array.isArray(value.bindings) ? value.bindings : [];
	const bindings: WorkspaceBinding[] = [];
	for (const entry of source) {
		const binding = normalizeBinding(entry);
		if (binding) bindings.push(binding);
	}
	return { version: REGISTRY_VERSION, bindings };
}

function bindingFromInput(input: RegisterWorkspaceBindingInput): WorkspaceBinding {
	const now = new Date().toISOString();
	const binding: WorkspaceBinding = {
		sessionId: input.sessionId,
		sessionFile: path.resolve(input.sessionFile),
		workspaceRoot: path.resolve(input.workspaceRoot),
		status: input.status ?? "running",
		createdAt: input.createdAt ?? now,
		lastSeenAt: input.lastSeenAt ?? input.createdAt ?? now,
	};
	if (input.agentId !== undefined) binding.agentId = input.agentId;
	if (input.kind !== undefined) binding.kind = input.kind;
	return binding;
}

async function writeRegistryFileAtomic(registryFile: string, data: WorkspaceBindingRegistryFile): Promise<void> {
	const dir = path.dirname(registryFile);
	await fs.mkdir(dir, { recursive: true });
	const tempFile = path.join(dir, `.${path.basename(registryFile)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
	let published = false;
	try {
		await fs.writeFile(tempFile, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		await fs.rename(tempFile, registryFile);
		published = true;
	} finally {
		if (!published) {
			try {
				await fs.rm(tempFile, { force: true });
			} catch {}
		}
	}
}

export class WorkspaceBindingRegistry {
	readonly registryFile: string;

	constructor(options: { agentDir?: string } = {}) {
		this.registryFile = getWorkspaceRegistryPath(options.agentDir);
	}

	async register(input: RegisterWorkspaceBindingInput): Promise<WorkspaceBinding> {
		const registry = await this.#read();
		const binding = bindingFromInput(input);
		const existingIndex = registry.bindings.findIndex(entry => entry.sessionId === binding.sessionId);
		if (existingIndex === -1) registry.bindings.push(binding);
		else registry.bindings[existingIndex] = binding;
		await writeRegistryFileAtomic(this.registryFile, registry);
		return attachRegistryFile({ ...binding }, this.registryFile);
	}

	async lookupBySessionId(sessionId: string): Promise<WorkspaceBinding | null> {
		const registry = await this.#read();
		const binding = registry.bindings.find(entry => entry.sessionId === sessionId);
		return binding ? attachRegistryFile({ ...binding }, this.registryFile) : null;
	}

	async updateStatus(sessionId: string, update: WorkspaceBindingStatusUpdate): Promise<WorkspaceBinding> {
		const registry = await this.#read();
		const binding = registry.bindings.find(entry => entry.sessionId === sessionId);
		if (!binding) throw new Error(`Workspace binding not found for session ${sessionId}`);
		const updated: WorkspaceBinding = {
			...binding,
			status: update.status,
			lastSeenAt: update.lastSeenAt ?? new Date().toISOString(),
		};
		registry.bindings = registry.bindings.map(entry => (entry.sessionId === sessionId ? updated : entry));
		await writeRegistryFileAtomic(this.registryFile, registry);
		return attachRegistryFile({ ...updated }, this.registryFile);
	}

	async requireWorkspaceForSession(
		sessionId: string,
		options: { fallbackCwd?: string } = {},
	): Promise<string> {
		const binding = await this.lookupBySessionId(sessionId);
		const fallbackCwd = options.fallbackCwd ? path.resolve(options.fallbackCwd) : undefined;
		if (!binding) {
			throw new WorkspaceBindingUnavailableError({
				code: "WORKSPACE_BINDING_MISSING",
				sessionId,
				fallbackCwd,
			});
		}
		try {
			await fs.stat(binding.workspaceRoot);
			return binding.workspaceRoot;
		} catch {
			// Fall through to a typed fail-closed error instead of adopting fallbackCwd.
		}
		throw new WorkspaceBindingUnavailableError({
			code: "WORKSPACE_MISSING",
			sessionId,
			workspaceRoot: binding.workspaceRoot,
			fallbackCwd,
		});
	}

	async #read(): Promise<WorkspaceBindingRegistryFile> {
		let content: string;
		try {
			content = await fs.readFile(this.registryFile, "utf8");
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") return { version: REGISTRY_VERSION, bindings: [] };
			throw error;
		}
		if (content.trim().length === 0) return { version: REGISTRY_VERSION, bindings: [] };
		try {
			return normalizeRegistryFile(JSON.parse(content));
		} catch (error) {
			throw new Error(`Failed to read workspace binding registry ${this.registryFile}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

export function appendWorkspaceBindingSessionMetadata(
	sessionManager: SessionManager,
	binding: WorkspaceBinding,
	init: {
		systemPrompt: string;
		task: string;
		tools: string[];
		outputSchema?: unknown;
		spawns?: string;
		readSummarize?: boolean;
	},
): string {
	const registryFile =
		registryFileByBinding.get(binding) ??
		(binding as unknown as Record<string, string | undefined>)[REGISTRY_FILE_PROPERTY] ??
		getWorkspaceRegistryPath();
	const metadata: WorkspaceBindingMetadata = {
		sessionId: binding.sessionId,
		workspaceRoot: binding.workspaceRoot,
		registryFile,
	};
	sessionManager.setWorkspaceBinding(metadata);
	return sessionManager.appendSessionInit({ ...init, workspaceBinding: metadata });
}
