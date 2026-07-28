import { readFileSync } from "node:fs";
import { parseEnvSpecDotEnvFile } from "@env-spec/parser";
import type { SecretHandle, SecretValue, VaultProvider } from "./types";

/**
 * Phase D Task D4 — Varlock provider adapter (research refinement R1).
 *
 * Declarative schema layer for secrets via Varlock's `@env-spec/parser`
 * (MIT, zero-runtime-coupling). A schema file (`env.schema`) declares keys
 * with decorators (`@sensitive`, `@type`, ...); a sibling values file
 * (`env`) holds the actual values. Only `@sensitive` keys resolve through
 * the broker — non-sensitive keys are not secrets and do not belong in this
 * path. Fail-closed (R2): every failure mode throws, never returns a
 * partial or empty value.
 *
 * The value is read from the values file on disk — NEVER from
 * `process.env` (R4: the agent's env is agent-visible).
 */

interface EnvSpecConfigItem {
	data?: {
		key?: string;
		preComments?: Array<{
			data?: {
				decorators?: Array<{
					data?: { name?: string };
					value?: { value?: unknown };
				}>;
			};
		}>;
		value?: { value?: unknown };
	};
}

function parseConfigItems(text: string): EnvSpecConfigItem[] {
	const parsed = parseEnvSpecDotEnvFile(text) as { configItems?: EnvSpecConfigItem[] };
	return parsed.configItems ?? [];
}

function isSensitive(item: EnvSpecConfigItem): boolean {
	for (const comment of item.data?.preComments ?? []) {
		for (const decorator of comment.data?.decorators ?? []) {
			if (decorator.data?.name === "sensitive" && decorator.value?.value !== false) return true;
		}
	}
	return false;
}

export class VarlockProvider implements VaultProvider {
	readonly name = "varlock";
	readonly #schemaPath: string;

	constructor(opts?: { schemaPath?: string }) {
		this.#schemaPath =
			opts?.schemaPath ??
			process.env.VARLOCK_SCHEMA_PATH ??
			`${process.env.OMP_SECRET_HOME ?? `${process.env.HOME}/.oh-my-pi-secret/agent`}/env.schema`;
	}

	/** Sibling values file: `env.schema` → `env`. */
	#valuesPath(): string {
		return this.#schemaPath.replace(/\.schema$/, "");
	}

	async isAvailable(): Promise<boolean> {
		try {
			parseConfigItems(readFileSync(this.#schemaPath, "utf8"));
			return true;
		} catch {
			return false;
		}
	}

	async resolve(handle: SecretHandle): Promise<SecretValue> {
		if (handle.provider !== "varlock") {
			throw new Error(`VarlockProvider: wrong provider "${handle.provider}"`);
		}
		let items: EnvSpecConfigItem[];
		try {
			items = parseConfigItems(readFileSync(this.#schemaPath, "utf8"));
		} catch (err) {
			throw new Error(`VarlockProvider: schema unreadable: ${err instanceof Error ? err.message : String(err)}`);
		}
		const item = items.find(candidate => candidate.data?.key === handle.itemId);
		if (!item) {
			throw new Error(`VarlockProvider: key "${handle.itemId}" not declared in schema`);
		}
		if (!isSensitive(item)) {
			throw new Error(
				`VarlockProvider: key "${handle.itemId}" is not marked @sensitive — only @sensitive keys resolve through the broker`,
			);
		}
		let values: EnvSpecConfigItem[];
		try {
			values = parseConfigItems(readFileSync(this.#valuesPath(), "utf8"));
		} catch (err) {
			throw new Error(
				`VarlockProvider: values file unreadable: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		const entry = values.find(candidate => candidate.data?.key === handle.itemId);
		const value = entry?.data?.value?.value;
		if (typeof value !== "string" || value.length === 0) {
			throw new Error(`VarlockProvider: no value for "${handle.itemId}" in the values file`);
		}
		return { handle, value };
	}
}
