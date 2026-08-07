/**
 * Legacy pi `>=0.80.8` `ModelRuntime` compatibility facade (issue #7068).
 *
 * pi 0.80.8 split model/auth ownership out of `ModelRegistry` into an
 * async-created `ModelRuntime` (`ModelRuntime.create({ authPath, modelsPath })`)
 * and turned `ModelRegistry` into a sync facade over it. OMP never adopted
 * that split — its `ModelRegistry` owns the auth storage and the model catalog
 * directly — so extensions built against the new surface fail Bun's static
 * export check at install time when `ModelRuntime` is missing, and would fail
 * at runtime on `new ModelRegistry(runtime)` / `createAgentSession({ modelRuntime })`
 * even if the symbol were re-exported bare.
 *
 * This class bridges all three boundaries:
 *   - `ModelRuntime.create(...)` builds an OMP `ModelRegistry` (with the
 *     canonical auth storage for the agent dir derived from `authPath`, and the
 *     caller's models path when it exists) and wraps it.
 *   - `ModelRegistry`'s constructor overload accepts a `ModelRuntime` and
 *     resolves to the wrapped registry, so `new ModelRegistry(runtime)` shares
 *     the exact catalog/auth identity.
 *   - `createAgentSession({ modelRuntime })` unwraps the facade back to the
 *     underlying registry, so subagent sessions reuse the host session's
 *     catalog and credentials (including extension-registered providers).
 *
 * Only the surface pi extensions actually consume is mirrored here (see
 * `@quintinshaw/pi-dynamic-workflows@3.4.1`); the facade is deliberately thin
 * and delegates everything to the wrapped registry rather than reimplementing
 * streaming or auth flows OMP routes through sessions.
 */

import path from "node:path";
import type { Api, AuthCredentialStore, Model } from "@oh-my-pi/pi-ai";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { discoverAuthStorage } from "../session/auth-broker-config";
import { ModelRegistry } from "./model-registry";

/**
 * Construction inputs accepted by the legacy `ModelRuntime.create` facade.
 * Mirrors pi's `CreateModelRuntimeOptions` for the fields OMP can honor.
 */
export interface ModelRuntimeCreateOptions {
	/**
	 * Credential store. When provided it backs the wrapped registry directly;
	 * otherwise OMP's canonical store for the agent dir (broker-aware) is used.
	 */
	credentials?: AuthCredentialStore;
	/**
	 * Path to the agent credential file. pi extensions pass
	 * `<agentDir>/auth.json`; OMP derives the agent dir from it and uses its
	 * own credential store (SQLite / auth broker) for that dir.
	 */
	authPath?: string;
	/**
	 * Path to the models config. pi extensions pass `<agentDir>/models.json`;
	 * OMP reads that file when it exists and otherwise falls back to its
	 * canonical `models.yml`, so a config authored for omp is never shadowed
	 * by a nonexistent pi path.
	 */
	modelsPath?: string | null;
}

/**
 * Module-private brand shared with {@link ModelRegistry} so the constructor
 * overload can recognize a legacy runtime without importing this class at
 * module top level (avoiding an ESM import cycle between the two files).
 */
export const MODEL_RUNTIME_BRAND: unique symbol = Symbol("omp.legacy.ModelRuntime");

/** Type guard shared with {@link ModelRegistry} (see {@link MODEL_RUNTIME_BRAND}). */
export function isModelRuntime(value: unknown): value is ModelRuntime {
	return typeof value === "object" && value !== null && MODEL_RUNTIME_BRAND in value;
}

/**
 * Legacy pi `>=0.80.8` model/auth runtime facade over an OMP {@link ModelRegistry}.
 */
export class ModelRuntime {
	readonly [MODEL_RUNTIME_BRAND] = true;
	readonly #registry: ModelRegistry;

	private constructor(registry: ModelRegistry) {
		this.#registry = registry;
	}

	/**
	 * Create a runtime bound to the given agent credential/auth path and models
	 * config. Matches pi's `ModelRuntime.create({ authPath, modelsPath })`.
	 */
	static async create(options: ModelRuntimeCreateOptions = {}): Promise<ModelRuntime> {
		const agentDir = options.authPath ? path.dirname(options.authPath) : getAgentDir();
		const authStorage =
			options.credentials !== undefined ? new AuthStorage(options.credentials) : await discoverAuthStorage(agentDir);
		const modelsPath =
			options.modelsPath && (await Bun.file(options.modelsPath).exists()) ? options.modelsPath : undefined;
		return new ModelRuntime(new ModelRegistry(authStorage, modelsPath));
	}

	/**
	 * @internal — build a facade wrapping an existing OMP registry. Used by
	 * `ModelRegistry.runtime` to expose the legacy runtime surface on
	 * registries constructed the OMP-native way.
	 */
	static wrap(registry: ModelRegistry): ModelRuntime {
		return new ModelRuntime(registry);
	}

	/**
	 * @internal — unwrap to the wrapped OMP registry. Used by
	 * `ModelRegistry`'s runtime constructor overload and by
	 * `createAgentSession({ modelRuntime })`.
	 */
	static registryOf(runtime: ModelRuntime): ModelRegistry {
		return runtime.#registry;
	}

	/** Reload models from disk (built-in + custom config). */
	async refresh(): Promise<void> {
		await this.#registry.refresh();
	}

	/**
	 * Models currently available (auth configured), refreshing the catalog
	 * first — pi's async availability check. Best-effort: refresh failures are
	 * surfaced through the wrapped registry's error state, not thrown.
	 */
	async getAvailable(providerId?: string): Promise<readonly Model<Api>[]> {
		await this.#registry.refresh();
		return this.getAvailableSnapshot(providerId);
	}

	/** Synchronous snapshot of the currently available models. */
	getAvailableSnapshot(providerId?: string): readonly Model<Api>[] {
		const models = this.#registry.getAvailable();
		return providerId !== undefined ? models.filter(model => model.provider === providerId) : models;
	}

	/** All known models, optionally scoped to one provider. */
	getModels(providerId?: string): readonly Model<Api>[] {
		const models = this.#registry.getAll();
		return providerId !== undefined ? models.filter(model => model.provider === providerId) : models;
	}

	/** Look up a model by provider and id. */
	getModel(providerId: string, modelId: string): Model<Api> | undefined {
		return this.#registry.find(providerId, modelId);
	}

	/** Provider ids currently present in the catalog. */
	getProviders(): readonly string[] {
		return [...new Set(this.#registry.getAll().map(model => model.provider))];
	}

	/** Latest catalog composition error, if any. */
	getError(): string | undefined {
		return this.#registry.getError()?.message;
	}

	/** Whether the provider has credentials configured (command-backed or stored). */
	hasConfiguredAuth(providerId: string): boolean {
		return (
			this.#registry.hasCommandBackedApiKey(providerId) || this.#registry.authStorage.hasAuth(providerId)
		);
	}

	/** Whether the provider authenticates through OAuth. */
	isUsingOAuth(providerId: string): boolean {
		return this.#registry.authStorage.hasOAuth(providerId);
	}
}
