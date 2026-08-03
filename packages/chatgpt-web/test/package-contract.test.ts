import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import path from "node:path";
import * as packageRoot from "@oh-my-pi/pi-chatgpt-web";
import { CHATGPT_WEB_API, type ChatGptWebEvent, type ChatGptWebTurnIdentity } from "@oh-my-pi/pi-chatgpt-web";

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..");
const WORKSPACE_ROOT = path.resolve(PACKAGE_ROOT, "../..");
const SOURCE_FAMILY = ["co", "dex"].join("");
const SOURCE_PACKAGE = `${SOURCE_FAMILY}-chatgpt-web`;
const FORBIDDEN_HOST = `@oh-my-pi/pi-${["coding", "agent"].join("-")}`;

interface PackageManifest {
	name: string;
	version: string;
	private?: boolean;
	bin: Record<string, string>;
	scripts: Record<string, string>;
	dependencies: Record<string, string>;
	devDependencies: Record<string, string>;
	engines: Record<string, string>;
	files: string[];
	exports: Record<string, { types: string; import: string }>;
}

interface RootManifest {
	workspaces: {
		packages: string[];
		catalog: Record<string, string>;
	};
}

interface LockWorkspace {
	name: string;
	version: string;
	bin?: Record<string, string>;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

interface Lockfile {
	workspaces: Record<string, LockWorkspace>;
	packages: Record<string, [string, ...unknown[]]>;
}

async function readJson<T>(filePath: string): Promise<T> {
	return JSON.parse(await Bun.file(filePath).text()) as T;
}

async function listFiles(directory: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await listFiles(entryPath)));
		else if (entry.isFile()) files.push(entryPath);
	}
	return files.sort();
}

describe("package boundary", () => {
	test("exposes the Task 2 root contract without a default export", () => {
		const identity: ChatGptWebTurnIdentity = { sessionId: "session", turnId: "turn" };
		const event: ChatGptWebEvent = { type: "start", responseId: "response" };
		const task2RuntimeExports = [
			"BrowserLoginError",
			"CHATGPT_WEB_API",
			"CHATGPT_WEB_MODEL_ROUTES",
			"CHATGPT_WEB_TUNNEL_ID_PATTERN",
			"CHATGPT_WEB_VERIFICATION_MAX_AGE_MS",
			"LocalLoginHost",
			"NativeSecurityUnavailableError",
			"availableChatGptWebModelRoutes",
			"chatGptWebSetupExists",
			"chromeExecutableCandidates",
			"createChatGptWebOwnership",
			"createChatGptWebProviderModels",
			"decodeJson",
			"encodeJson",
			"getChatGptWebSecureConfigHost",
			"hasChatGptWebLogin",
			"loginChatGptWeb",
			"openChatGptWebState",
			"parseChatGptWebOwnership",
			"parseChatGptWebRuntimeConfig",
			"parseChatGptWebVerificationMarker",
			"readChatGptWebConfig",
			"readChatGptWebLoginStatus",
			"requireChatGptWebModelRoute",
			"resolveChatGptWebPaths",
			"setChatGptWebSecureConfigHost",
			"setupChatGptWeb",
			"uninstallChatGptWeb",
			"validateChatGptWebTunnelId",
		];

		expect(CHATGPT_WEB_API).toBe("chatgpt-web");
		expect(identity).toEqual({ sessionId: "session", turnId: "turn" });
		expect(event).toEqual({ type: "start", responseId: "response" });
		expect(Object.keys(packageRoot)).toEqual(expect.arrayContaining(task2RuntimeExports));
		expect(packageRoot).not.toHaveProperty("default");
	});

	test("declares the isolated public package and reserved subpaths", async () => {
		const manifest = await readJson<PackageManifest>(path.join(PACKAGE_ROOT, "package.json"));

		expect(manifest.name).toBe("@oh-my-pi/pi-chatgpt-web");
		expect(manifest.version).toBe("17.2.6");
		expect("private" in manifest).toBe(false);
		expect(manifest.bin).toEqual({ "chatgpt-web": "./src/cli.ts" });
		expect(manifest.engines).toEqual({ bun: ">=1.3.14" });
		expect(manifest.files).toEqual(["src", "README.md", "CHANGELOG.md", "LICENSES"]);
		expect(manifest.exports).toEqual({
			".": { types: "./src/index.ts", import: "./src/index.ts" },
			"./extension": { types: "./src/extension.ts", import: "./src/extension.ts" },
			"./cli": { types: "./src/cli.ts", import: "./src/cli.ts" },
		});
		expect(manifest.scripts).toMatchObject({
			check: "biome check . && bun run check:types",
			"check:types": "tsgo -p tsconfig.json --noEmit",
			test: "bun test --parallel",
		});
	});

	test("pins package-owned dependencies without host or transport leakage", async () => {
		const manifest = await readJson<PackageManifest>(path.join(PACKAGE_ROOT, "package.json"));
		const dependencyNames = [...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies)];

		expect(manifest.dependencies).toEqual({
			"@modelcontextprotocol/sdk": "catalog:",
			"@oh-my-pi/pi-ai": "catalog:",
			"@oh-my-pi/pi-catalog": "catalog:",
			"@oh-my-pi/pi-natives": "catalog:",
			"@oh-my-pi/pi-utils": "catalog:",
			fflate: "catalog:",
			"playwright-core": "1.62.1",
			turndown: "catalog:",
			"turndown-plugin-gfm": "catalog:",
			zod: "catalog:",
		});
		expect(manifest.devDependencies).toEqual({
			"@types/bun": "catalog:",
			"@types/turndown": "catalog:",
		});
		expect(dependencyNames).not.toContain(FORBIDDEN_HOST);
		expect(dependencyNames).not.toContain("chromium-bidi");
	});

	test("keeps source and build metadata independent of the source package", async () => {
		const scannedFiles = [
			...(await listFiles(path.join(PACKAGE_ROOT, "src"))),
			...(await listFiles(path.join(PACKAGE_ROOT, "test"))),
			path.join(PACKAGE_ROOT, "package.json"),
			path.join(PACKAGE_ROOT, "tsconfig.json"),
		].sort();

		for (const filePath of scannedFiles) {
			const relativePath = path.relative(PACKAGE_ROOT, filePath);
			expect(relativePath.toLowerCase()).not.toContain(SOURCE_PACKAGE);
			const isProvenanceNotice = relativePath
				.split(path.sep)
				.some(part => /^(?:LICENSES?|NOTICE)(?:\.|$)/i.test(part));
			if (isProvenanceNotice) continue;
			const content = (await Bun.file(filePath).text()).toLowerCase();
			expect(content).not.toContain(SOURCE_FAMILY);
			expect(content).not.toContain(FORBIDDEN_HOST);
		}
	});

	test("records catalog and lockfile workspace resolution", async () => {
		const rootManifest = await readJson<RootManifest>(path.join(WORKSPACE_ROOT, "package.json"));
		const lockText = await Bun.file(path.join(WORKSPACE_ROOT, "bun.lock")).text();
		const lock = Bun.JSONC.parse(lockText) as Lockfile;
		const workspace = lock.workspaces["packages/chatgpt-web"];

		expect(rootManifest.workspaces.packages).toContain("packages/*");
		expect(rootManifest.workspaces.catalog["@modelcontextprotocol/sdk"]).toBe("1.26.0");
		expect(rootManifest.workspaces.catalog["@types/turndown"]).toBe("5.0.6");
		expect(workspace).toEqual({
			name: "@oh-my-pi/pi-chatgpt-web",
			version: "17.2.6",
			bin: { "chatgpt-web": "./src/cli.ts" },
			dependencies: {
				"@modelcontextprotocol/sdk": "catalog:",
				"@oh-my-pi/pi-ai": "catalog:",
				"@oh-my-pi/pi-catalog": "catalog:",
				"@oh-my-pi/pi-natives": "catalog:",
				"@oh-my-pi/pi-utils": "catalog:",
				fflate: "catalog:",
				"playwright-core": "1.62.1",
				turndown: "catalog:",
				"turndown-plugin-gfm": "catalog:",
				zod: "catalog:",
			},
			devDependencies: {
				"@types/bun": "catalog:",
				"@types/turndown": "catalog:",
			},
		});
		expect(lock.packages["@oh-my-pi/pi-chatgpt-web"]?.[0]).toBe(
			"@oh-my-pi/pi-chatgpt-web@workspace:packages/chatgpt-web",
		);
		expect(lock.packages["@modelcontextprotocol/sdk"]?.[0]).toBe("@modelcontextprotocol/sdk@1.26.0");
		expect(lock.packages["playwright-core"]?.[0]).toBe("playwright-core@1.62.1");
		expect(Object.keys(workspace.dependencies ?? {}).some(name => name.toLowerCase().includes(SOURCE_FAMILY))).toBe(
			false,
		);
		expect(Object.keys(lock.packages).some(name => name.toLowerCase().includes(SOURCE_PACKAGE))).toBe(false);
	});
});
