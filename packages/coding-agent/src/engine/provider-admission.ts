import type { Model, SimpleStreamOptions, UsageReport } from "@oh-my-pi/pi-ai";
import type { ProviderRequestHook } from "../sdk";
import type { AuthStorage } from "../session/auth-storage";

type Fetch = NonNullable<SimpleStreamOptions["fetch"]>;

export interface ProviderAdmissionIdentity {
	providerAccountRef: string;
	routeRef: string;
	providerKind: "openai_codex_subscription";
	providerId: string;
	accountBindingId: string;
}

interface ProviderAdmissionDecision {
	allowed: boolean;
	status?: string;
	reason?: string;
}

export class ProviderAdmissionError extends Error {
	readonly retryable = false;

	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ProviderAdmissionError";
	}
}

export class ProviderAdmissionClient {
	constructor(
		readonly endpoint: string,
		readonly token: string,
		readonly requestFetch: Fetch = globalThis.fetch,
	) {}

	createHook(identity: ProviderAdmissionIdentity, authStorage: AuthStorage, baseUrl: string): ProviderRequestHook {
		return {
			wrapFetch: (model, fetch) => this.#wrapFetch(identity, authStorage, baseUrl, model, fetch),
		};
	}

	#wrapFetch(
		identity: ProviderAdmissionIdentity,
		authStorage: AuthStorage,
		baseUrl: string,
		model: Model,
		fetch: Fetch,
	): Fetch {
		return async (input, init) => {
			if (model.provider !== identity.providerId) {
				throw new ProviderAdmissionError(
					"provider_identity_mismatch",
					"The provider request does not match the admitted account",
				);
			}
			const signal = init?.signal ?? undefined;
			let reports: UsageReport[] | null;
			try {
				await authStorage.invalidateUsageCache(identity.providerId, signal);
				reports = await authStorage.fetchUsageReports({
					baseUrlResolver: provider => (provider === identity.providerId ? baseUrl : undefined),
					signal,
				});
			} catch (error) {
				if (signal?.aborted) throw error;
				throw new ProviderAdmissionError(
					"provider_usage_unavailable",
					"Fresh usage for the selected provider account is unavailable",
				);
			}
			const report = selectExactUsageReport(reports, identity);
			if (!report) {
				throw new ProviderAdmissionError(
					"provider_usage_unavailable",
					"Fresh usage for the selected provider account is unavailable",
				);
			}
			const request = {
				phase: "before",
				...identity,
				modelId: model.id,
				usageReport: withoutRaw(report),
			};
			const decision = await this.#post(request, signal);
			if (!decision.allowed) {
				throw new ProviderAdmissionError(
					decision.status || "provider_admission_denied",
					decision.reason || "Provider quota admission was denied",
				);
			}
			try {
				return await fetch(input, init);
			} finally {
				await authStorage.invalidateUsageCache(identity.providerId).catch(() => {});
				void this.#post({ phase: "after", ...identity, modelId: model.id }, undefined).catch(() => {});
			}
		};
	}

	async #post(body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<ProviderAdmissionDecision> {
		let response: Response;
		try {
			response = await this.requestFetch(this.endpoint, {
				method: "POST",
				headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
				body: JSON.stringify(body),
				signal,
			});
		} catch (error) {
			if (signal?.aborted) throw error;
			throw new ProviderAdmissionError(
				"provider_admission_unavailable",
				error instanceof Error ? error.message : "Provider admission is unavailable",
			);
		}
		if (!response.ok) {
			throw new ProviderAdmissionError(
				"provider_admission_unavailable",
				`Provider admission returned HTTP ${response.status}`,
			);
		}
		const value: unknown = await response.json().catch(() => undefined);
		if (!isDecision(value)) {
			throw new ProviderAdmissionError(
				"provider_admission_invalid_response",
				"Provider admission returned an invalid response",
			);
		}
		return value;
	}
}

function selectExactUsageReport(
	reports: UsageReport[] | null,
	identity: ProviderAdmissionIdentity,
): UsageReport | undefined {
	return reports?.find(report => {
		if (report.provider !== identity.providerId) return false;
		const metadata = report.metadata;
		return typeof metadata?.accountId === "string" && metadata.accountId === identity.accountBindingId;
	});
}

function withoutRaw(report: UsageReport): Omit<UsageReport, "raw"> {
	const { raw: _raw, ...safe } = report;
	return safe;
}

function isDecision(value: unknown): value is ProviderAdmissionDecision {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "allowed") === "boolean";
}
