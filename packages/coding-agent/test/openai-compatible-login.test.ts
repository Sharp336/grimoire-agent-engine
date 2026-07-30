import { afterAll, expect, type Mock, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { ModelRegistry } from "../src/config/model-registry";
import { ModelsConfigFile } from "../src/config/models-config";
import {
	normalizeOpenAICompatibleBaseUrl,
	OPENAI_COMPATIBLE_API_IDS,
	probeOpenAICompatibleEndpoint,
	validateOpenAICompatibleApi,
	validateOpenAICompatibleProviderName,
	writeOpenAICompatibleProvider,
} from "../src/config/openai-compatible-login";
import { LoginDialogComponent } from "../src/modes/components/login-dialog";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { initTheme } from "../src/modes/theme/theme";
import { AuthStorage } from "../src/session/auth-storage";
import {
	openAICompatibleLoginAgentDir,
	restoreOpenAICompatibleLoginAgentDir,
} from "./fixtures/openai-compatible-login-agent-dir";

restoreOpenAICompatibleLoginAgentDir();
afterAll(async () => {
	await openAICompatibleLoginAgentDir.remove().catch(() => {});
});
await initTheme();

test("writes a schema-valid dynamically discovered OpenAI-compatible provider and updates it on re-login", async () => {
	const tempDir = TempDir.createSync("@openai-compatible-login-");
	const modelsPath = path.join(tempDir.path(), "models.yml");
	try {
		await writeOpenAICompatibleProvider(
			{
				providerName: "team-proxy",
				baseUrl: "https://models.example.test/v1/",
				apiKey: "sk-team",
			},
			modelsPath,
		);
		await writeOpenAICompatibleProvider(
			{
				providerName: "team-proxy",
				baseUrl: "https://next.example.test/v1",
				apiKey: "apikey-next",
				api: "openai-responses",
			},
			modelsPath,
		);

		const content = await fs.readFile(modelsPath, "utf-8");
		expect(content).toContain('openaiCompatibleApiKey: "apikey-next"');
		const emitted = YAML.parse(content) as { providers: Record<string, unknown> };
		expect(emitted).toEqual({
			providers: {
				"team-proxy": {
					baseUrl: "https://next.example.test/v1",
					openaiCompatibleApiKey: "apikey-next",
					api: "openai-responses",
					authHeader: true,
					discovery: { type: "openai-models-list" },
				},
			},
		});
		const schemaValidated = ModelsConfigFile.schema(emitted);
		expect(schemaValidated).not.toBeInstanceOf(Error);

		const loaded = ModelsConfigFile.relocate(modelsPath).tryLoad();
		expect(loaded.status).toBe("ok");
		if (loaded.status !== "ok") throw loaded.error;
		expect(Object.keys(loaded.value.providers ?? {})).toEqual(["team-proxy"]);
	} finally {
		await tempDir.remove().catch(() => {});
	}
});

test("stores compatible keys in a scoped literal field without rewriting legacy backslashes", async () => {
	const tempDir = TempDir.createSync("@openai-compatible-login-");
	const modelsPath = path.join(tempDir.path(), "models.yml");
	try {
		await fs.writeFile(
			modelsPath,
			YAML.stringify({
				providers: {
					legacySingle: { apiKey: "\\legacy" },
					legacyMultiple: { apiKey: "\\\\legacy" },
				},
			}),
		);

		await writeOpenAICompatibleProvider(
			{
				providerName: "team-proxy",
				baseUrl: "https://models.example.test/v1",
				apiKey: "!literal-compatible-key",
			},
			modelsPath,
		);

		const emitted = YAML.parse(await fs.readFile(modelsPath, "utf-8")) as {
			providers: Record<string, Record<string, string>>;
		};
		expect(emitted.providers.legacySingle.apiKey).toBe("\\legacy");
		expect(emitted.providers.legacyMultiple.apiKey).toBe("\\\\legacy");
		expect(emitted.providers["team-proxy"]).toMatchObject({
			openaiCompatibleApiKey: "!literal-compatible-key",
		});
		expect(emitted.providers["team-proxy"]).not.toHaveProperty("apiKey");

		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		try {
			const registry = new ModelRegistry(authStorage, modelsPath);
			expect(await registry.getApiKeyForProvider("team-proxy")).toBe("!literal-compatible-key");
			expect(await registry.getApiKeyForProvider("legacySingle")).toBe("\\legacy");
			expect(await registry.getApiKeyForProvider("legacyMultiple")).toBe("\\\\legacy");
		} finally {
			authStorage.close();
		}
	} finally {
		await tempDir.remove().catch(() => {});
	}
});

test("cancels an atomic compatible-provider write before rename and removes its temp file", async () => {
	const tempDir = TempDir.createSync("@openai-compatible-login-");
	const modelsPath = path.join(tempDir.path(), "models.yml");
	const original = "providers:\n  existing:\n    apiKey: existing-key\n";
	const controller = new AbortController();
	const writeFile = fs.writeFile;
	try {
		await fs.writeFile(modelsPath, original);
		const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
			if (String(args[0]).endsWith(".tmp")) controller.abort();
			await writeFile(...args);
		});

		await expect(
			writeOpenAICompatibleProvider(
				{
					providerName: "team-proxy",
					baseUrl: "https://models.example.test/v1",
					apiKey: "new-key",
				},
				modelsPath,
				controller.signal,
			),
		).rejects.toThrow();
		writeSpy.mockRestore();

		expect(await fs.readFile(modelsPath, "utf-8")).toBe(original);
		expect((await fs.readdir(tempDir.path())).filter(entry => entry.endsWith(".tmp"))).toEqual([]);
	} finally {
		vi.restoreAllMocks();
		await tempDir.remove().catch(() => {});
	}
});

test("rejects built-in provider names, malformed compatible endpoint URLs, and unsupported APIs", () => {
	expect(() => validateOpenAICompatibleProviderName("OpenAI")).toThrow('Provider name "OpenAI" is built in');
	expect(() => validateOpenAICompatibleProviderName("team/proxy")).toThrow("must not contain forward or back slashes");
	expect(() => validateOpenAICompatibleProviderName("team\\proxy")).toThrow(
		"must not contain forward or back slashes",
	);
	expect(() => normalizeOpenAICompatibleBaseUrl("not a URL")).toThrow("well-formed absolute http(s) URL");
	expect(validateOpenAICompatibleApi("")).toBe("openai-completions");
	expect(validateOpenAICompatibleApi("openai-responses")).toBe("openai-responses");
	expect(() => validateOpenAICompatibleApi("anthropic-messages")).toThrow(
		"not supported by OpenAI-compatible endpoints",
	);
	expect(() => validateOpenAICompatibleApi("not-an-api")).toThrow("not supported by OpenAI-compatible endpoints");
});

type LoginDialog = InstanceType<typeof LoginDialogComponent>;

interface CompatibleLoginHarness {
	controller: InstanceType<typeof SelectorController>;
	dialog(): LoginDialog;
	modelsPath: string;
	refreshCalls: string[][];
	setFocus: Mock<() => void>;
}

function createCompatibleLoginHarness(): CompatibleLoginHarness {
	const editor = {};
	const editorSlot: unknown[] = [];
	const refreshCalls: string[][] = [];
	const refreshProvider = async (...args: string[]): Promise<void> => {
		refreshCalls.push(args);
	};
	const setFocus = vi.fn();
	const context = {
		editor,
		editorContainer: {
			clear: vi.fn(() => editorSlot.splice(0)),
			addChild: vi.fn((child: unknown) => editorSlot.push(child)),
			children: editorSlot,
		},
		session: { modelRegistry: { refreshProvider } },
		ui: { requestRender: vi.fn(), setFocus },
		showError: vi.fn(),
		showStatus: vi.fn(),
		present: vi.fn(),
		// SelectorController's context is intentionally application-wide; this fixture
		// supplies only the members reached by the compatible-login flow.
	} as never;
	return {
		controller: new SelectorController(context),
		dialog: () => {
			const dialog = editorSlot[0];
			if (!(dialog instanceof LoginDialogComponent)) throw new Error("Expected the compatible login dialog");
			return dialog;
		},
		modelsPath: ModelsConfigFile.path(),
		refreshCalls,
		setFocus,
	};
}

async function flushLogin(): Promise<void> {
	for (let i = 0; i < 4; i++) await Promise.resolve();
}

async function submitText(dialog: LoginDialog, value: string): Promise<void> {
	dialog.pasteText(value);
	dialog.handleInput("\n");
	await flushLogin();
}

test("uses the models.yml API discriminator set in the compatible-login selector", async () => {
	const harness = createCompatibleLoginHarness();
	const showSelect = vi.spyOn(LoginDialogComponent.prototype, "showSelect");
	try {
		const login = harness.controller.showOAuthSelector("login", "openai-compatible");
		const dialog = harness.dialog();
		await submitText(dialog, "team-proxy");
		await submitText(dialog, "https://models.example.test/v1");
		await submitText(dialog, "sk-team");

		const apiSelector = showSelect.mock.calls.find(([message]) => message === "API:");
		expect(apiSelector).toBeDefined();
		expect(apiSelector?.[1]).toEqual([...OPENAI_COMPATIBLE_API_IDS]);
		expect(apiSelector?.[2]).toBe(OPENAI_COMPATIBLE_API_IDS.indexOf("openai-completions"));

		const rendered = dialog
			.render(120)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		for (const api of OPENAI_COMPATIBLE_API_IDS) expect(rendered).toContain(api);

		dialog.handleInput("\x1b");
		await login;
	} finally {
		showSelect.mockRestore();
	}
});

test("cancelling a failed compatible-endpoint probe leaves models.yml unchanged", async () => {
	const harness = createCompatibleLoginHarness();

	const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not available", { status: 503 }));
	const showSelect = vi.spyOn(LoginDialogComponent.prototype, "showSelect");
	try {
		const login = harness.controller.showOAuthSelector("login", "openai-compatible");
		const dialog = harness.dialog();
		await submitText(dialog, "team-proxy");
		await submitText(dialog, "https://models.example.test/v1");
		await submitText(dialog, "sk-team");
		dialog.handleInput("\n");
		await flushLogin();

		const probeSelector = showSelect.mock.calls.find(([message]) => message.includes("GET /models failed (503)"));
		expect(probeSelector?.[1]).toEqual(["Retry", "Save anyway", "Cancel"]);

		dialog.handleInput("\x1b[B");
		dialog.handleInput("\x1b[B");
		dialog.handleInput("\n");
		await login;

		expect(harness.refreshCalls).toEqual([]);
	} finally {
		showSelect.mockRestore();
		fetchSpy.mockRestore();
	}
});

test("normalizes the probe and persisted endpoint exactly like runtime discovery", () => {
	expect(normalizeOpenAICompatibleBaseUrl("https://models.example.test")).toBe("https://models.example.test/v1");
	expect(normalizeOpenAICompatibleBaseUrl("https://models.example.test/proxy/")).toBe(
		"https://models.example.test/proxy/v1",
	);
});

test("passes cancellation into the bounded endpoint probe", async () => {
	const controller = new AbortController();
	controller.abort();
	let signal: AbortSignal | undefined;
	let requestedUrl = "";
	const result = await probeOpenAICompatibleEndpoint(
		{ baseUrl: "https://models.example.test", apiKey: "sk-test" },
		async (url, options) => {
			requestedUrl = String(url);
			signal = options?.signal ?? undefined;
			throw new DOMException("aborted", "AbortError");
		},
		controller.signal,
	);
	expect(requestedUrl).toBe("https://models.example.test/v1/models");
	expect(signal?.aborted).toBe(true);
	expect(result.ok).toBe(false);
});

test("sanitizes endpoint response bodies before returning probe errors", async () => {
	const result = await probeOpenAICompatibleEndpoint(
		{ baseUrl: "https://models.example.test", apiKey: "sk-test" },
		async () => new Response("\x1b]52;c;clipboard\x07\x1b[31mnot available\x1b[0m", { status: 503 }),
	);
	expect(result).toEqual({ ok: false, error: "GET /models failed (503): not available" });
});

test("stores inline keys in the scoped field and removes incompatible retained transport", async () => {
	const tempDir = TempDir.createSync("@openai-compatible-literal-");
	const modelsPath = path.join(tempDir.path(), "models.yml");
	try {
		await fs.writeFile(
			modelsPath,
			"providers:\n  proxy:\n    baseUrl: https://old.example.test/v1\n    apiKey: old-key\n    api: openai-completions\n    transport: pi-native\n",
		);
		await writeOpenAICompatibleProvider(
			{ providerName: "proxy", baseUrl: "https://new.example.test", apiKey: "!not-a-command" },
			modelsPath,
		);
		const provider = (
			YAML.parse(await fs.readFile(modelsPath, "utf-8")) as { providers: Record<string, Record<string, unknown>> }
		).providers.proxy;
		expect(provider).toBeDefined();
		expect(provider?.openaiCompatibleApiKey).toBe("!not-a-command");
		expect(provider?.apiKey).toBeUndefined();
		expect(provider?.transport).toBeUndefined();
	} finally {
		await tempDir.remove().catch(() => {});
	}
});

test("updates custom providers case-insensitively without dropping manual models", async () => {
	const tempDir = TempDir.createSync("@openai-compatible-preserve-models-");
	const modelsPath = path.join(tempDir.path(), "models.yml");
	try {
		await fs.writeFile(
			modelsPath,
			YAML.stringify({
				providers: {
					TeamProxy: {
						baseUrl: "https://old.example.test/v1",
						apiKey: "old-key",
						api: "openai-completions",
						models: [{ id: "hand-tuned", contextWindow: 32_768 }],
					},
				},
			}),
		);
		const savedProviderName = await writeOpenAICompatibleProvider(
			{ providerName: "teamproxy", baseUrl: "https://new.example.test", apiKey: "new-key" },
			modelsPath,
		);
		const providers = (
			YAML.parse(await fs.readFile(modelsPath, "utf-8")) as {
				providers: Record<string, { baseUrl: string; models: unknown[] }>;
			}
		).providers;
		expect(savedProviderName).toBe("TeamProxy");
		expect(Object.keys(providers)).toEqual(["TeamProxy"]);
		expect(providers.TeamProxy).toMatchObject({
			baseUrl: "https://new.example.test/v1",
			models: [{ id: "hand-tuned", contextWindow: 32_768 }],
		});
	} finally {
		await tempDir.remove().catch(() => {});
	}
});

test("rejects an update when complete models configuration validation fails", async () => {
	const tempDir = TempDir.createSync("@openai-compatible-validation-");
	const modelsPath = path.join(tempDir.path(), "models.yml");
	try {
		await fs.writeFile(
			modelsPath,
			YAML.stringify({
				providers: {
					broken: { baseUrl: "https://broken.example.test/v1", apiKey: "key", models: [{ id: "missing-api" }] },
				},
			}),
		);
		await expect(
			writeOpenAICompatibleProvider(
				{ providerName: "new", baseUrl: "https://new.example.test", apiKey: "new-key" },
				modelsPath,
			),
		).rejects.toThrow('Provider broken, model missing-api: no "api" specified');
	} finally {
		await tempDir.remove().catch(() => {});
	}
});

test("migrates legacy models.json before updating models.yml and preserves a symlink", async () => {
	const tempDir = TempDir.createSync("@openai-compatible-migration-");
	const jsonPath = path.join(tempDir.path(), "models.json");
	const modelsPath = path.join(tempDir.path(), "models.yml");
	const targetPath = path.join(tempDir.path(), "managed-models.yml");
	try {
		await fs.writeFile(jsonPath, '{"providers":{"legacy":{"apiKey":"legacy","api":"openai-completions"}}}');
		await writeOpenAICompatibleProvider(
			{ providerName: "new", baseUrl: "https://new.example.test", apiKey: "new-key" },
			modelsPath,
		);
		expect(
			Object.keys((YAML.parse(await fs.readFile(modelsPath, "utf-8")) as { providers: object }).providers),
		).toEqual(["legacy", "new"]);
		await fs.rename(modelsPath, targetPath);
		await fs.symlink(targetPath, modelsPath);
		await fs.unlink(targetPath);
		await writeOpenAICompatibleProvider(
			{ providerName: "newer", baseUrl: "https://newer.example.test", apiKey: "newer-key" },
			modelsPath,
		);
		expect((await fs.lstat(modelsPath)).isSymbolicLink()).toBe(true);
		expect(
			(YAML.parse(await fs.readFile(targetPath, "utf-8")) as { providers: Record<string, unknown> }).providers.newer,
		).toBeDefined();
	} finally {
		await tempDir.remove().catch(() => {});
	}
});

test("masks each API-key prompt and keeps the shared input below the active question", () => {
	const dialog = new LoginDialogComponent({ requestRender: vi.fn() } as never, "test", vi.fn());
	const first = dialog.showPrompt("First question");
	dialog.pasteText("first");
	dialog.handleInput("\n");
	void first;
	void dialog.showPrompt("API key:", undefined, { secret: true });
	dialog.pasteText("secret");
	const rendered = dialog
		.render(120)
		.map(line => Bun.stripANSI(line))
		.join("\n");
	expect(rendered).not.toContain("First question");
	expect(rendered).toContain("API key:");
	expect(rendered).toContain("••••••");
	expect(rendered.indexOf("API key:")).toBeLessThan(rendered.indexOf("••••••"));
	expect(rendered).not.toContain("secret");
});

test("Escape during probe aborts login flow without mounting retry selector", async () => {
	const harness = createCompatibleLoginHarness();

	const blockingFetch: typeof fetch = Object.assign(
		(_url: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
			const { promise, reject } = Promise.withResolvers<Response>();
			const signal = options?.signal;
			if (signal?.aborted) {
				reject(new DOMException("aborted", "AbortError"));
			} else {
				signal?.addEventListener("abort", () => {
					reject(new DOMException("aborted", "AbortError"));
				});
			}
			return promise;
		},
		{ preconnect: (_url: string | URL): void => {} },
	);
	const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(blockingFetch);
	const showSelect = vi.spyOn(LoginDialogComponent.prototype, "showSelect");
	try {
		const login = harness.controller.showOAuthSelector("login", "openai-compatible");
		const dialog = harness.dialog();
		await submitText(dialog, "team-proxy");
		await submitText(dialog, "https://models.example.test/v1");
		await submitText(dialog, "sk-team");
		// Accept the API selector (default selection).
		dialog.handleInput("\n");
		await flushLogin();

		// Probe is now blocked on fetch. Send Escape to abort.
		dialog.handleInput("\x1b");

		// The login handler must resolve (not hang forever).
		await login;

		// No retry selector was mounted after the abort.
		const retrySelectors = showSelect.mock.calls.filter(
			([message]) => typeof message === "string" && message.includes("What would you like to do?"),
		);
		expect(retrySelectors).toHaveLength(0);

		// Editor focus was restored.
		expect(harness.setFocus).toHaveBeenCalledWith({});

		// models.yml untouched — no refresh calls.
		expect(harness.refreshCalls).toEqual([]);
	} finally {
		showSelect.mockRestore();
		fetchSpy.mockRestore();
	}
});
