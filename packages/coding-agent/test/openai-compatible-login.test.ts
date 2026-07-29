import { afterAll, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";

const originalAgentDir = getAgentDir();
const testAgentDir = TempDir.createSync("@openai-compatible-login-agent-");
setAgentDir(testAgentDir.path());

// The config singleton resolves its default path at module initialization, so
// load the login modules only after this test's agent directory is isolated.
const { ModelsConfigFile } = await import("../src/config/models-config");
const {
	normalizeOpenAICompatibleBaseUrl,
	validateOpenAICompatibleApi,
	validateOpenAICompatibleProviderName,
	writeOpenAICompatibleProvider,
} = await import("../src/config/openai-compatible-login");
const { MODELS_CONFIG_API_IDS } = await import("../src/config/models-config-schema-bundle");
const { LoginDialogComponent } = await import("../src/modes/components/login-dialog");
const { SelectorController } = await import("../src/modes/controllers/selector-controller");
const { initTheme } = await import("../src/modes/theme/theme");

await initTheme();

afterAll(async () => {
	setAgentDir(originalAgentDir);
	await testAgentDir.remove().catch(() => {});
});

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
		expect(content).toContain('apiKey: "apikey-next"');
		const emitted = YAML.parse(content) as { providers: Record<string, unknown> };
		expect(emitted).toEqual({
			providers: {
				"team-proxy": {
					baseUrl: "https://next.example.test/v1",
					apiKey: "apikey-next",
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

test("rejects built-in provider names, malformed compatible endpoint URLs, and unsupported APIs", () => {
	expect(() => validateOpenAICompatibleProviderName("openai")).toThrow('Provider name "openai" is built in');
	expect(() => normalizeOpenAICompatibleBaseUrl("not a URL")).toThrow("well-formed absolute http(s) URL");
	expect(validateOpenAICompatibleApi("")).toBe("openai-completions");
	expect(validateOpenAICompatibleApi("openai-responses")).toBe("openai-responses");
	expect(() => validateOpenAICompatibleApi("not-an-api")).toThrow("not accepted by models.yml");
});

type LoginDialog = InstanceType<typeof LoginDialogComponent>;

interface CompatibleLoginHarness {
	controller: InstanceType<typeof SelectorController>;
	dialog(): LoginDialog;
	modelsPath: string;
	refreshCalls: string[][];
}

function createCompatibleLoginHarness(): CompatibleLoginHarness {
	const editor = {};
	const editorSlot: unknown[] = [];
	const refreshCalls: string[][] = [];
	const refreshProvider = async (...args: string[]): Promise<void> => {
		refreshCalls.push(args);
	};
	const context = {
		editor,
		editorContainer: {
			clear: vi.fn(() => editorSlot.splice(0)),
			addChild: vi.fn((child: unknown) => editorSlot.push(child)),
			children: editorSlot,
		},
		session: { modelRegistry: { refreshProvider } },
		ui: { requestRender: vi.fn(), setFocus: vi.fn() },
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
		expect(apiSelector?.[1]).toEqual([...MODELS_CONFIG_API_IDS]);
		expect(apiSelector?.[2]).toBe(MODELS_CONFIG_API_IDS.indexOf("openai-completions"));

		const rendered = dialog
			.render(120)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		for (const api of MODELS_CONFIG_API_IDS) expect(rendered).toContain(api);

		dialog.handleInput("\x1b");
		await login;
	} finally {
		showSelect.mockRestore();
	}
});

test("cancelling a failed compatible-endpoint probe leaves models.yml unchanged", async () => {
	const harness = createCompatibleLoginHarness();
	const before = "providers:\n  existing:\n    apiKey: existing-key\n    auth: none\n";
	await fs.mkdir(path.dirname(harness.modelsPath), { recursive: true });
	await fs.writeFile(harness.modelsPath, before, "utf-8");
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

		expect(await fs.readFile(harness.modelsPath, "utf-8")).toBe(before);
		expect(harness.refreshCalls).toEqual([]);
	} finally {
		showSelect.mockRestore();
		fetchSpy.mockRestore();
	}
});
