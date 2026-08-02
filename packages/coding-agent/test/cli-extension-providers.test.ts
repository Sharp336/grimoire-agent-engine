/**
 * Regression test for `loadCliExtensionProviders`.
 *
 * One-shot CLIs (`omp bench`, dry-balance) build a bare `ModelRegistry` that
 * only knows built-in catalog providers. Before the helper existed they never
 * loaded extensions, so a provider contributed by an extension
 * (`pi.registerProvider(...)`, e.g. a custom OpenAI-compatible gateway under
 * `~/.omp/agent/extensions/`) was invisible to model resolution and
 * `omp bench <provider>/<model>` failed with "Model not found".
 *
 * Contract under test: after `loadCliExtensionProviders` drains the extension's
 * provider registrations into the registry, a `provider/id` selector for that
 * extension provider resolves. Discovery is disabled and the extension path is
 * passed explicitly so the test never touches the developer's real `~/.omp`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { getModelMatchPreferences, resolveCliModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { loadCliExtensionProviders } from "@oh-my-pi/pi-coding-agent/sdk";
import { TempDir } from "@oh-my-pi/pi-utils";

let tmp: TempDir;
let extPath: string;
let dbPath: string;

beforeAll(async () => {
	tmp = await TempDir.create("@cli-ext-providers-");
	extPath = tmp.join("ext.ts");
	dbPath = tmp.join("auth.db");
	await fs.writeFile(
		extPath,
		`export default function (pi) {
	pi.registerProvider("bench-gw", {
		baseUrl: "https://example.com/v1",
		apiKey: "literal-test-key",
		api: "openai-completions",
		models: [{
			id: "bench-model",
			name: "Bench Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		}],
	});
}
`,
	);
});

afterAll(async () => {
	resetSettingsForTest();
	await tmp.remove();
});

test("loadCliExtensionProviders makes extension providers resolvable by selector", async () => {
	const authStorage = await AuthStorage.create(dbPath);
	try {
		const settings = await Settings.init({
			inMemory: true,
			cwd: tmp.path(),
			overrides: { extensions: [extPath], disabledExtensions: [] },
		});
		const modelRegistry = new ModelRegistry(authStorage);
		const preferences = getModelMatchPreferences(settings);

		// Before the drain the extension provider is unknown: resolution fails.
		const before = resolveCliModel({ cliModel: "bench-gw/bench-model", modelRegistry, preferences });
		expect(before.model).toBeUndefined();

		await loadCliExtensionProviders(modelRegistry, settings, tmp.path(), {
			disableExtensionDiscovery: true,
			additionalExtensionPaths: [extPath],
		});

		// After the drain the same selector resolves to the extension provider.
		const after = resolveCliModel({ cliModel: "bench-gw/bench-model", modelRegistry, preferences });
		expect(after.error).toBeUndefined();
		expect(after.model?.provider).toBe("bench-gw");
		expect(after.model?.id).toBe("bench-model");
	} finally {
		authStorage.close();
	}
});

type CliExtProvidersOrderTestGlobals = typeof globalThis & {
	__cliExtProvidersTestWaitProviderSecondGate?: () => Promise<void>;
	__cliExtProvidersTestReleaseProviderSecondGate?: () => void;
	__cliExtProvidersTestWaitFlagSecondGate?: () => Promise<void>;
	__cliExtProvidersTestReleaseFlagSecondGate?: () => void;
};

function cliExtProvidersOrderTestGlobals(): CliExtProvidersOrderTestGlobals {
	return globalThis as CliExtProvidersOrderTestGlobals;
}

describe("loadExtensions provider registration order", () => {
	let orderTmp: TempDir;

	beforeEach(async () => {
		orderTmp = await TempDir.create("@cli-ext-providers-order-");

		const providerSecondGate = Promise.withResolvers<void>();
		const flagSecondGate = Promise.withResolvers<void>();
		const globals = cliExtProvidersOrderTestGlobals();

		globals.__cliExtProvidersTestWaitProviderSecondGate = () => providerSecondGate.promise;
		globals.__cliExtProvidersTestReleaseProviderSecondGate = () => {
			providerSecondGate.resolve();
		};
		globals.__cliExtProvidersTestWaitFlagSecondGate = () => flagSecondGate.promise;
		globals.__cliExtProvidersTestReleaseFlagSecondGate = () => {
			flagSecondGate.resolve();
		};
	});

	afterEach(async () => {
		const globals = cliExtProvidersOrderTestGlobals();
		delete globals.__cliExtProvidersTestWaitProviderSecondGate;
		delete globals.__cliExtProvidersTestReleaseProviderSecondGate;
		delete globals.__cliExtProvidersTestWaitFlagSecondGate;
		delete globals.__cliExtProvidersTestReleaseFlagSecondGate;

		resetSettingsForTest();
		await orderTmp.remove();
	});

	test("preserves input order when concurrent factories finish out of order", async () => {
		const firstPath = orderTmp.join("first-provider.ts");
		const secondPath = orderTmp.join("second-provider.ts");

		await fs.writeFile(
			firstPath,
			`export default async function (pi) {
	await globalThis.__cliExtProvidersTestWaitProviderSecondGate();
	pi.registerProvider("shared-provider", { baseUrl: "https://first.example.com/v1" });
}`,
		);

		await fs.writeFile(
			secondPath,
			`export default function (pi) {
	pi.registerProvider("shared-provider", { baseUrl: "https://second.example.com/v1" });
	globalThis.__cliExtProvidersTestReleaseProviderSecondGate();
}`,
		);

		const result = await loadExtensions([firstPath, secondPath], orderTmp.path());

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(2);
		expect(result.runtime.pendingProviderRegistrations).toHaveLength(2);

		expect(result.runtime.pendingProviderRegistrations[0]).toEqual({
			name: "shared-provider",
			config: { baseUrl: "https://first.example.com/v1" },
			sourceId: firstPath,
		});
		expect(result.runtime.pendingProviderRegistrations[1]).toEqual({
			name: "shared-provider",
			config: { baseUrl: "https://second.example.com/v1" },
			sourceId: secondPath,
		});
	});

	test("preserves flag default input order when concurrent factories finish out of order", async () => {
		const firstPath = orderTmp.join("first-flag.ts");
		const secondPath = orderTmp.join("second-flag.ts");

		await fs.writeFile(
			firstPath,
			`export default async function (pi) {
	await globalThis.__cliExtProvidersTestWaitFlagSecondGate();
	pi.registerFlag("shared-flag", { type: "string", default: "first" });
	if (pi.getFlag("shared-flag") !== "first") {
		throw new Error("expected local getFlag to observe first default");
	}
}`,
		);

		await fs.writeFile(
			secondPath,
			`export default function (pi) {
	pi.registerFlag("shared-flag", { type: "string", default: "second" });
	if (pi.getFlag("shared-flag") !== "second") {
		throw new Error("expected local getFlag to observe second default");
	}
	globalThis.__cliExtProvidersTestReleaseFlagSecondGate();
}`,
		);

		const result = await loadExtensions([firstPath, secondPath], orderTmp.path());

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(2);
		expect(result.runtime.flagValues.get("shared-flag")).toBe("second");
	});
});
