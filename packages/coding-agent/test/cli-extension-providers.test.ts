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
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import {
	__hasCommonJsModuleSourceForTests,
	__inFlightLegacyPiLoadsForTests,
	__setLegacyPiInFlightChangedForTests,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
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

type ExtensionImportGate = {
	firstImportStarted: () => void;
	secondImported: () => void;
	wait: Promise<void>;
};

type ExtensionFlagProbe = {
	getFlag: () => boolean | string | undefined;
};

describe("loadExtensions registration order", () => {
	let orderTmp: TempDir;

	beforeEach(async () => {
		orderTmp = await TempDir.create("@cli-ext-providers-order-");
	});

	afterEach(async () => {
		resetSettingsForTest();
		await orderTmp.remove();
	});

	test("imports independent modules concurrently before sequential factory init", async () => {
		const firstPath = orderTmp.join("first-import.ts");
		const secondPath = orderTmp.join("second-import.ts");
		const firstImportStarted = Promise.withResolvers<void>();
		const secondImported = Promise.withResolvers<void>();
		const releaseFirstImport = Promise.withResolvers<void>();
		const gateKey = `__ompExtensionImportGate_${Bun.hash(orderTmp.path()).toString(36)}`;
		const globals = globalThis as typeof globalThis & Record<string, ExtensionImportGate | undefined>;
		globals[gateKey] = {
			firstImportStarted: () => firstImportStarted.resolve(),
			secondImported: () => secondImported.resolve(),
			wait: releaseFirstImport.promise,
		};

		try {
			await fs.writeFile(
				firstPath,
				`const gate = globalThis[${JSON.stringify(gateKey)}] as {
	firstImportStarted: () => void;
	wait: Promise<void>;
};
gate.firstImportStarted();
await gate.wait;
export default function (pi) {
	pi.registerProvider("first-provider", { baseUrl: "https://first.example.com/v1" });
}
`,
			);
			await fs.writeFile(
				secondPath,
				`(globalThis[${JSON.stringify(gateKey)}] as { secondImported: () => void }).secondImported();
export default function (pi) {
	pi.registerProvider("second-provider", { baseUrl: "https://second.example.com/v1" });
}
`,
			);

			const resultPromise = loadExtensions([firstPath, secondPath], orderTmp.path());
			// Sequential imports would deadlock here: the first module awaits release
			await Promise.all([firstImportStarted.promise, secondImported.promise]);
			releaseFirstImport.resolve();
			const result = await resultPromise;

			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(2);
			expect(result.runtime.pendingProviderRegistrations).toEqual([
				{
					name: "first-provider",
					config: { baseUrl: "https://first.example.com/v1" },
					sourceId: firstPath,
				},
				{
					name: "second-provider",
					config: { baseUrl: "https://second.example.com/v1" },
					sourceId: secondPath,
				},
			]);
		} finally {
			delete globals[gateKey];
		}
	});

	test("preserves provider order across sequential factory initialization", async () => {
		const firstPath = orderTmp.join("first-provider.ts");
		const secondPath = orderTmp.join("second-provider.ts");
		await fs.writeFile(
			firstPath,
			`export default function (pi) {
	pi.registerProvider("shared-provider", { baseUrl: "https://first.example.com/v1" });
}
`,
		);
		await fs.writeFile(
			secondPath,
			`export default function (pi) {
	pi.registerProvider("shared-provider", { baseUrl: "https://second.example.com/v1" });
}
`,
		);

		const result = await loadExtensions([firstPath, secondPath], orderTmp.path());

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(2);
		expect(result.runtime.pendingProviderRegistrations).toEqual([
			{
				name: "shared-provider",
				config: { baseUrl: "https://first.example.com/v1" },
				sourceId: firstPath,
			},
			{
				name: "shared-provider",
				config: { baseUrl: "https://second.example.com/v1" },
				sourceId: secondPath,
			},
		]);
	});

	test("preserves later flag defaults from configured path order", async () => {
		const firstPath = orderTmp.join("first-flag.ts");
		const secondPath = orderTmp.join("second-flag.ts");
		await fs.writeFile(
			firstPath,
			`export default function (pi) {
	pi.registerFlag("shared-flag", { type: "string", default: "first" });
}
`,
		);
		await fs.writeFile(
			secondPath,
			`export default function (pi) {
	pi.registerFlag("shared-flag", { type: "string", default: "second" });
}
`,
		);

		const result = await loadExtensions([firstPath, secondPath], orderTmp.path());

		expect(result.errors).toEqual([]);
		expect(result.runtime.flagValues.get("shared-flag")).toBe("second");
	});

	test("getFlag reads runtime overrides after loading", async () => {
		const flagPath = orderTmp.join("flag-override.ts");
		const probeKey = `__ompExtensionFlagProbe_${Bun.hash(orderTmp.path()).toString(36)}`;
		const globals = globalThis as typeof globalThis & Record<string, ExtensionFlagProbe | undefined>;

		try {
			await fs.writeFile(
				flagPath,
				`export default function (pi) {
	pi.registerFlag("demo-flag", { type: "string", default: "from-default" });
	(globalThis[${JSON.stringify(probeKey)}] as { getFlag: () => boolean | string | undefined }).getFlag = () =>
		pi.getFlag("demo-flag");
}
`,
			);
			globals[probeKey] = { getFlag: () => undefined };

			const result = await loadExtensions([flagPath], orderTmp.path());

			expect(result.errors).toEqual([]);
			expect(globals[probeKey]?.getFlag()).toBe("from-default");
			result.runtime.flagValues.set("demo-flag", "from-cli");
			expect(globals[probeKey]?.getFlag()).toBe("from-cli");
		} finally {
			delete globals[probeKey];
		}
	});

	test("delivers shared startup events from later factories to earlier listeners", async () => {
		const listenerPath = orderTmp.join("event-listener.ts");
		const emitterPath = orderTmp.join("event-emitter.ts");
		const seenKey = `__ompExtensionEventSeen_${Bun.hash(orderTmp.path()).toString(36)}`;
		const globals = globalThis as typeof globalThis & Record<string, string[] | undefined>;
		globals[seenKey] = [];

		try {
			await fs.writeFile(
				listenerPath,
				`export default function (pi) {
	pi.events.on("extension-boot", (payload) => {
		(globalThis[${JSON.stringify(seenKey)}] as string[]).push(String(payload));
	});
}
`,
			);
			await fs.writeFile(
				emitterPath,
				`export default function (pi) {
	pi.events.emit("extension-boot", "hello-from-later");
}
`,
			);

			const result = await loadExtensions([listenerPath, emitterPath], orderTmp.path());

			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(2);
			expect(globals[seenKey]).toEqual(["hello-from-later"]);
		} finally {
			delete globals[seenKey];
		}
	});

	test("keeps providers registered before a factory fails", async () => {
		const failingPath = orderTmp.join("failing-provider.ts");
		await fs.writeFile(
			failingPath,
			`export default function (pi) {
	pi.registerProvider("kept-provider", { baseUrl: "https://kept.example.com/v1" });
	throw new Error("failure after provider registration");
}
`,
		);

		const result = await loadExtensions([failingPath], orderTmp.path());

		expect(result.extensions).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.path).toBe(failingPath);
		expect(result.runtime.pendingProviderRegistrations).toEqual([
			{
				name: "kept-provider",
				config: { baseUrl: "https://kept.example.com/v1" },
				sourceId: failingPath,
			},
		]);
	});

	test("keeps flag defaults registered before a factory fails", async () => {
		const failingPath = orderTmp.join("failing-flag.ts");
		await fs.writeFile(
			failingPath,
			`export default function (pi) {
	pi.registerFlag("kept-flag", { type: "string", default: "kept" });
	throw new Error("failure after flag registration");
}
`,
		);

		const result = await loadExtensions([failingPath], orderTmp.path());

		expect(result.extensions).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.runtime.flagValues.get("kept-flag")).toBe("kept");
	});

	test("retains shared rewritten CommonJS sources across reverse-completion imports", async () => {
		const sharedDir = orderTmp.join("node_modules", "direct");
		await fs.mkdir(sharedDir, { recursive: true });
		await fs.writeFile(
			orderTmp.join("node_modules", "direct", "package.json"),
			JSON.stringify({ name: "direct", version: "1.0.0", main: "index.js" }),
		);
		await fs.writeFile(
			orderTmp.join("node_modules", "direct", "index.js"),
			'module.exports = require("@mariozechner/pi-ai").Type;\n',
		);

		const firstPath = orderTmp.join("shared-cjs-first.ts");
		const secondPath = orderTmp.join("shared-cjs-second.ts");
		const firstReady = Promise.withResolvers<boolean>();
		const releaseFirst = Promise.withResolvers<void>();
		const onlyFirstInFlight = Promise.withResolvers<void>();
		const gateKey = `__ompSharedCjsExtGate_${Bun.hash(orderTmp.path()).toString(36)}`;
		const globals = globalThis as typeof globalThis &
			Record<string, { firstReady: (ok: boolean) => void; wait: Promise<void> } | undefined>;
		globals[gateKey] = {
			firstReady: ok => firstReady.resolve(ok),
			wait: releaseFirst.promise,
		};
		let sawOverlappingLoads = false;
		__setLegacyPiInFlightChangedForTests(count => {
			if (count >= 2) sawOverlappingLoads = true;
			if (sawOverlappingLoads && count === 1) onlyFirstInFlight.resolve();
		});
		let resultPromise: Promise<LoadExtensionsResult> | undefined;

		try {
			await fs.writeFile(
				firstPath,
				`import { Type } from "@oh-my-pi/pi-ai";
import requiredType from "direct";
const gate = globalThis[${JSON.stringify(gateKey)}] as {
	firstReady: (ok: boolean) => void;
	wait: Promise<void>;
};
gate.firstReady(requiredType === Type);
await gate.wait;
export default function (pi) {
	pi.registerProvider("shared-cjs-first", { baseUrl: "https://first-shared.example.com/v1" });
}
`,
			);
			await fs.writeFile(
				secondPath,
				`import { Type } from "@oh-my-pi/pi-ai";
import requiredType from "direct";
if (requiredType !== Type) {
	throw new Error("shared rewritten CommonJS dependency failed to remap");
}
export default function (pi) {
	pi.registerProvider("shared-cjs-second", { baseUrl: "https://second-shared.example.com/v1" });
}
`,
			);

			const sharedPath = await fs.realpath(orderTmp.join("node_modules", "direct", "index.js"));
			resultPromise = loadExtensions([firstPath, secondPath], orderTmp.path());
			expect(await firstReady.promise).toBe(true);

			// Reverse completion: wait until only the gated first import remains
			// in flight. Eager cleanup would have cleared the shared source here.
			await onlyFirstInFlight.promise;
			expect(__inFlightLegacyPiLoadsForTests()).toBe(1);
			expect(__hasCommonJsModuleSourceForTests(sharedPath)).toBe(true);

			releaseFirst.resolve();
			const result = await resultPromise;
			expect(result.errors).toEqual([]);
			expect(result.extensions).toHaveLength(2);
			expect(result.runtime.pendingProviderRegistrations.map(entry => entry.name)).toEqual([
				"shared-cjs-first",
				"shared-cjs-second",
			]);
			expect(__inFlightLegacyPiLoadsForTests()).toBe(0);
			expect(__hasCommonJsModuleSourceForTests(sharedPath)).toBe(false);
		} finally {
			releaseFirst.resolve();
			await resultPromise?.catch(() => undefined);
			__setLegacyPiInFlightChangedForTests(undefined);
			delete globals[gateKey];
		}
	});
});
