import { randomUUID } from "node:crypto";
import type { BridgeMessage, BridgeReceipt, ExternalPeer } from "@oh-my-pi/prime-bridge-protocol";
import { type PrimeBridgeFetch, PrimeBridgeHttpClient, type PrimeBridgeReadFile } from "./client";
import { ensurePrimeBridge } from "./lifecycle";

export interface ExternalPeerWaitClaim {
	message: BridgeMessage;
	claimToken: string;
	claimedUntilMs?: number;
}

export interface ExternalPeerProvider {
	list(): Promise<ExternalPeer[]>;
	send(target: string, message: string, replyTo?: string): Promise<BridgeReceipt>;
	inbox(peek: boolean): Promise<BridgeMessage[]>;
	wait(from: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<ExternalPeerWaitClaim | null>;
	ack(claimToken: string): Promise<boolean>;
	release(claimToken: string): Promise<boolean>;
}

export type PrimeBridgeEnsure = () => Promise<void>;

export interface PrimeExternalPeerProviderOptions {
	enabled?: boolean;
	autoStart?: boolean;
	url?: string;
	tokenPath?: string;
	originSessionId?: string;
	projectRoot?: string;
	fetch?: PrimeBridgeFetch;
	readFile?: PrimeBridgeReadFile;
	ensureReady?: PrimeBridgeEnsure;
}

const receiptStatuses: Record<string, true> = {
	delivered: true,
	queued: true,
	injected: true,
	woken: true,
	revived: true,
	failed: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function validatePeer(value: unknown): asserts value is ExternalPeer {
	if (
		!isRecord(value) ||
		!isNonEmptyString(value.id) ||
		!value.id.isWellFormed() ||
		!isNonEmptyString(value.displayName) ||
		!isNonEmptyString(value.status) ||
		(value.activeSessionId !== undefined &&
			(!isNonEmptyString(value.activeSessionId) || !value.activeSessionId.isWellFormed()))
	) {
		throw new Error("Prime bridge peers response has invalid shape");
	}
}

function validateMessage(value: unknown): asserts value is BridgeMessage {
	if (!isRecord(value)) throw new Error("Prime bridge message response has invalid shape");
	for (const field of [
		"meshMessageId",
		"idempotencyKey",
		"originSessionId",
		"targetId",
		"body",
		"projectRoot",
		"createdAt",
	] as const) {
		if (!isNonEmptyString(value[field])) throw new Error(`Prime bridge message response has invalid ${field}`);
	}
	const originSessionId = value.originSessionId;
	if (typeof originSessionId !== "string" || !originSessionId.isWellFormed())
		throw new Error("Prime bridge message response has invalid originSessionId");
	const targetId = value.targetId;
	if (typeof targetId !== "string" || !targetId.isWellFormed())
		throw new Error("Prime bridge message response has invalid targetId");
	if (value.originHarness !== "omp" && value.originHarness !== "prime")
		throw new Error("Prime bridge message response has invalid originHarness");
	if (value.targetHarness !== "omp" && value.targetHarness !== "prime")
		throw new Error("Prime bridge message response has invalid targetHarness");
	if (value.replyTo !== undefined && typeof value.replyTo !== "string")
		throw new Error("Prime bridge message response has invalid replyTo");
}

function validateReceipt(value: unknown): asserts value is BridgeReceipt {
	if (
		!isRecord(value) ||
		!isNonEmptyString(value.meshMessageId) ||
		typeof value.status !== "string" ||
		receiptStatuses[value.status] !== true
	) {
		throw new Error("Prime bridge receipt response has invalid shape");
	}
}

function validateWaitClaim(value: unknown): asserts value is ExternalPeerWaitClaim {
	if (!isRecord(value) || !isNonEmptyString(value.claimToken) || !isRecord(value.message))
		throw new Error("Prime bridge wait response has invalid claim shape");
	validateMessage(value.message);
	if (
		value.claimedUntilMs !== undefined &&
		(typeof value.claimedUntilMs !== "number" ||
			!Number.isSafeInteger(value.claimedUntilMs) ||
			value.claimedUntilMs < 0)
	)
		throw new Error("Prime bridge wait response has invalid lease expiry");
}

function validateClaimOperation(value: unknown): boolean {
	if (!isRecord(value) || typeof value.ok !== "boolean")
		throw new Error("Prime bridge claim response has invalid shape");
	return value.ok;
}

function defaultEnsureReady(options: PrimeExternalPeerProviderOptions): PrimeBridgeEnsure {
	if (options.autoStart !== true) return async () => {};
	return async () => {
		await ensurePrimeBridge({
			enabled: true,
			autoStart: true,
			url: options.url,
			tokenPath: options.tokenPath,
		});
	};
}

export class PrimeExternalPeerProvider implements ExternalPeerProvider {
	readonly #client: PrimeBridgeHttpClient;
	readonly #ensureReady: PrimeBridgeEnsure;
	readonly #originSessionId: string;
	readonly #projectRoot: string;

	constructor(options: PrimeExternalPeerProviderOptions) {
		if (!isNonEmptyString(options.url)) throw new Error("Prime bridge url is required");
		if (!isNonEmptyString(options.tokenPath)) throw new Error("Prime bridge tokenPath is required");
		if (!isNonEmptyString(options.originSessionId)) throw new Error("Prime bridge originSessionId is required");
		if (!isNonEmptyString(options.projectRoot)) throw new Error("Prime bridge projectRoot is required");
		this.#client = new PrimeBridgeHttpClient({
			url: options.url,
			tokenPath: options.tokenPath,
			fetch: options.fetch,
			readFile: options.readFile,
		});
		this.#ensureReady = options.ensureReady ?? defaultEnsureReady(options);
		this.#originSessionId = options.originSessionId;
		this.#projectRoot = options.projectRoot;
	}

	async #prepare(): Promise<void> {
		await this.#ensureReady();
		await this.#client.post("/v1/peers", {
			targetHarness: "omp",
			id: this.#originSessionId,
			displayName: this.#originSessionId,
			status: "running",
		});
	}

	async list(): Promise<ExternalPeer[]> {
		await this.#prepare();
		const value = await this.#client.get<unknown>("/v1/peers?targetHarness=prime");
		if (!Array.isArray(value)) throw new Error("Prime bridge peers response has invalid shape");
		for (const peer of value) validatePeer(peer);
		return value as ExternalPeer[];
	}

	async send(target: string, message: string, replyTo?: string): Promise<BridgeReceipt> {
		await this.#prepare();
		const payload: BridgeMessage = {
			meshMessageId: randomUUID(),
			idempotencyKey: randomUUID(),
			originHarness: "omp",
			originSessionId: this.#originSessionId,
			targetHarness: "prime",
			targetId: target,
			body: message,
			projectRoot: this.#projectRoot,
			createdAt: new Date().toISOString(),
			...(replyTo === undefined ? {} : { replyTo }),
		};
		const value = await this.#client.post<unknown>("/v1/messages", payload);
		validateReceipt(value);
		return value;
	}

	async inbox(peek: boolean): Promise<BridgeMessage[]> {
		await this.#prepare();
		const value = await this.#client.get<unknown>(
			`/v1/inbox?targetId=${encodeURIComponent(this.#originSessionId)}&peek=${peek ? "true" : "false"}`,
		);
		if (!Array.isArray(value)) throw new Error("Prime bridge inbox response has invalid shape");
		for (const message of value) validateMessage(message);
		return value as BridgeMessage[];
	}

	async wait(
		from: string | undefined,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<ExternalPeerWaitClaim | null> {
		await this.#prepare();
		const value = await this.#client.post<unknown>(
			"/v1/wait",
			{
				targetId: this.#originSessionId,
				...(from === undefined ? {} : { from }),
				timeoutMs,
			},
			signal,
		);
		if (value === null) return null;
		const claimToken = isRecord(value) && isNonEmptyString(value.claimToken) ? value.claimToken : undefined;
		try {
			validateWaitClaim(value);
		} catch (error) {
			if (claimToken !== undefined) {
				try {
					await this.#client.post("/v1/wait/release", { claimToken });
				} catch {
					// Preserve the original validation error after the best-effort release.
				}
			}
			throw error;
		}
		return value;
	}

	async ack(claimToken: string): Promise<boolean> {
		await this.#prepare();
		return validateClaimOperation(await this.#client.post<unknown>("/v1/wait/ack", { claimToken }));
	}

	async release(claimToken: string): Promise<boolean> {
		await this.#prepare();
		return validateClaimOperation(await this.#client.post<unknown>("/v1/wait/release", { claimToken }));
	}
}

export function createExternalPeerProvider(
	options: PrimeExternalPeerProviderOptions = {},
): ExternalPeerProvider | undefined {
	if (options.enabled !== true) return undefined;
	return new PrimeExternalPeerProvider(options);
}
