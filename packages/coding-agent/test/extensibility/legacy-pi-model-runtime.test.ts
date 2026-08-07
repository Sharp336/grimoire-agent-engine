import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ModelRuntime } from "@oh-my-pi/pi-coding-agent/config/model-runtime";
import {
	__resetLegacyPiResolutionCache,
	installLegacyPiSpecifierShim,
	loadLegacyPiModule,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { TempDir, removeWithRetries } from "@oh-my-pi/pi-utils";

// Issue #7068: pi >= 0.80.8 split model/auth ownership out of ModelRegistry
// into an async-created ModelRuntime (`ModelRuntime.create({ authPath,
// modelsPath })`) and turned ModelRegistry into a sync facade over it. OMP
// never adopted that split, so `@quintinshaw/pi-dynamic-workflows` — which
// imports `ModelRuntime` at module scope and builds `new ModelRegistry(runtime)`
// — failed Bun's static export check at plugin validation with "Export named
// 'ModelRuntime' not found in module '.../legacy-pi-coding-agent-shim.ts'".
// These pin the shim surface through the aliased legacy specifier (the exact
// validation path) and the facade behavior behind it.
installLegacyPiSpecifierShim();

const tempRoots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	__resetLegacyPiResolutionCache();
});

afterAll(async () => {
	for (const dir of tempRoots) {
		await removeWithRetries(dir);
	}
});

async function writeFixtureExtension(source: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-pi-model-runtime-"));
	tempRoots.push(dir);
	const entry = path.join(dir, "index.ts");
	await fs.writeFile(entry, source, "utf8");
	return entry;
}

describe("legacy shim ModelRuntime surface (issue #7068)", () => {
	it("resolves ModelRuntime and ModelRegistry through the @earendil-works specifier", async () => {
		const entry = await writeFixtureExtension(
			[
				'import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";',
				"export const runtimeClass = ModelRuntime;",
				"export const registryClass = ModelRegistry;",
			].join("\n"),
		);

		const loaded = (await loadLegacyPiModule(entry)) as {
			runtimeClass: { create: unknown };
			registryClass: unknown;
		};
		// Pre-fix this threw `SyntaxError: Export named 'ModelRuntime' not found
		// in module '.../legacy-pi-coding-agent-shim.ts'` at load time.
		expect(typeof loaded.runtimeClass).toBe("function");
		expect(typeof loaded.runtimeClass.create).toBe("function");
		expect(typeof loaded.registryClass).toBe("function");
	});

	it("mirrors the pi >= 0.80.8 module-scope surface pi-dynamic-workflows uses", async () => {
		const entry = await writeFixtureExtension(
			[
				'import {',
				'  createAgentSession,',
				'  ModelRegistry,',
				'  ModelRuntime,',
				'  type CreateAgentSessionOptions,',
				'} from "@earendil-works/pi-coding-agent";',
				"export const sessionFactory = createAgentSession;",
				"export const runtimeClass = ModelRuntime;",
				"export const registryClass = ModelRegistry;",
				"export const runtimeCreate = ModelRuntime.create;",
				"export type SessionOptions = CreateAgentSessionOptions;",
			].join("\n"),
		);

		const loaded = (await loadLegacyPiModule(entry)) as {
			sessionFactory: unknown;
			runtimeClass: { create: unknown };
			registryClass: unknown;
			runtimeCreate: unknown;
		};
		expect(typeof loaded.sessionFactory).toBe("function");
		expect(typeof loaded.runtimeClass).toBe("function");
		expect(typeof loaded.runtimeCreate).toBe("function");
		expect(typeof loaded.registryClass).toBe("function");
	});
});

describe("legacy ModelRuntime facade behavior (issue #7068)", () => {
	it("ModelRuntime.create builds a registry from authPath/modelsPath and new ModelRegistry(runtime) shares it", async () => {
		const tempDir = TempDir.createSync("@legacy-model-runtime-");
		try {
			await Bun.write(path.join(tempDir.path(), "models.yml"), "{}");

			// The exact call shape pi >= 0.80.8 extensions use
			// (`join(agentDir, "auth.json")` / `join(agentDir, "models.json")`).
			const runtime = await ModelRuntime.create({
				authPath: path.join(tempDir.path(), "auth.json"),
				modelsPath: path.join(tempDir.path(), "models.json"),
			});

			// OMP credentials live in its own store: the facade must have
			// derived the agent dir from authPath and created the canonical db.
			await expect(fs.stat(path.join(tempDir.path(), "agent.db"))).resolves.toBeDefined();

			const registry = new ModelRegistry(runtime);
			// `new ModelRegistry(runtime)` resolves to the wrapped instance, so
			// catalog and auth identity are shared with the runtime.
			expect(ModelRuntime.registryOf(runtime)).toBe(registry);
			expect(registry.authStorage).toBeDefined();

			// Sync surface used by pi-dynamic-workflows (listAvailableModels /
			// resolveModelSpecWithThinking).
			expect(registry.getAll().length).toBeGreaterThan(0);
			expect(Array.isArray(registry.getAvailable())).toBe(true);
			expect(runtime.getAvailableSnapshot().length).toBe(registry.getAvailable().length);
			expect(runtime.getModel("anthropic", "claude-sonnet-4-5")).toBeDefined();
			expect(runtime.getProviders()).toContain("anthropic");
		} finally {
			await tempDir.remove().catch(() => {});
		}
	});

	it("exposes .runtime (runtimeOf() reach) and unwraps back to the same registry", async () => {
		const tempDir = TempDir.createSync("@legacy-model-runtime-");
		try {
			await Bun.write(path.join(tempDir.path(), "models.yml"), "{}");
			const runtime = await ModelRuntime.create({
				authPath: path.join(tempDir.path(), "auth.json"),
				modelsPath: path.join(tempDir.path(), "models.yml"),
			});
			const registry = new ModelRegistry(runtime);

			// pi extensions reach the runtime via `runtimeOf()`, which reads the
			// (previously private) `runtime` field — now a public getter that
			// lazily materializes the facade wrapping this registry.
			const reachable = registry.runtime;
			expect(reachable).toBeDefined();
			expect(ModelRuntime.registryOf(reachable)).toBe(registry);
		} finally {
			await tempDir.remove().catch(() => {});
		}
	});

	it("reports auth state per provider against the wrapped registry", async () => {
		const tempDir = TempDir.createSync("@legacy-model-runtime-");
		try {
			await Bun.write(path.join(tempDir.path(), "models.yml"), "{}");
			const runtime = await ModelRuntime.create({
				authPath: path.join(tempDir.path(), "auth.json"),
				modelsPath: path.join(tempDir.path(), "models.yml"),
			});

			// Fresh empty credential store — nothing is configured.
			expect(runtime.hasConfiguredAuth("anthropic")).toBe(false);
			expect(runtime.isUsingOAuth("anthropic")).toBe(false);
			expect(runtime.getError()).toBeUndefined();
		} finally {
			await tempDir.remove().catch(() => {});
		}
	});
});
