import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { refreshDirsFromEnv, TempDir } from "@oh-my-pi/pi-utils";

// Isolate the dirs resolver into a throwaway XDG cache root so the session
// starts from an EMPTY hardware cache and its background probes can never
// write into the developer's or CI profile's real hardware_cache.json.
const DIRS_ENV_KEYS = ["XDG_CACHE_HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR"];
let savedDirsEnv: Record<string, string | undefined> = {};
let tempCacheRoot = "";

beforeEach(async () => {
	tempCacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-hw-refresh-"));
	savedDirsEnv = {};
	for (const key of DIRS_ENV_KEYS) {
		savedDirsEnv[key] = process.env[key];
		delete process.env[key];
	}
	process.env.XDG_CACHE_HOME = tempCacheRoot;
	// The dirs resolver only adopts an XDG root whose omp/ subdir already exists.
	await fs.mkdir(path.join(tempCacheRoot, "omp"), { recursive: true });
	refreshDirsFromEnv();
});

afterEach(async () => {
	for (const [key, value] of Object.entries(savedDirsEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	refreshDirsFromEnv();
	await fs.rm(tempCacheRoot, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("first-session hardware prompt refresh", () => {
	it("updates the live system prompt once the background hardware probe settles", async () => {
		using tempDir = TempDir.createSync("@omp-hw-prompt-refresh-");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const model = getBundledModel("openai", "gpt-4o-mini");
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			modelRegistry: new ModelRegistry(authStorage),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated({}),
			model,
			disableExtensionDiscovery: true,
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});

		try {
			// Session start never blocks on probes: the cold cache renders no RAM line.
			expect(session.systemPrompt.join("\n")).not.toContain("- RAM: ");

			// The startup hook rebuilds the base prompt when the background probe
			// settles — the SAME session must surface the fields before any turn
			// (RAM always resolves on Linux via the capacity fallback).
			// Real-time poll (not fake timers) is deliberate: the awaited condition
			// is a fire-and-forget pipeline of real child-process probes with no
			// session-exposed completion event; deterministic clock control cannot
			// advance lspci/udevadm.
			const deadline = Date.now() + 15_000;
			while (Date.now() < deadline && !session.systemPrompt.join("\n").includes("- RAM: ")) {
				await Bun.sleep(50);
			}
			expect(session.systemPrompt.join("\n")).toContain("- RAM: ");
		} finally {
			await session.dispose();
			authStorage.close();
		}
	}, 30_000);
});
