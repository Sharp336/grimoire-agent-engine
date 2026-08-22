import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { COMPOSER_DEFAULTS } from "@oh-my-pi/pi-coding-agent/modes/composer";
import {
	readComposerStartupCache,
	writeComposerLspCache,
	writeComposerRecentSessionsCache,
	writeComposerStatusCache,
	writeComposerUiCache,
	writeComposerWelcomeCache,
} from "@oh-my-pi/pi-coding-agent/modes/composer-cache";
import { getAgentDir } from "@oh-my-pi/pi-utils/dirs";

describe("composer startup cache", () => {
	it("round-trips per-project UI, recent-session JSONL, and LSP speculation", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-composer-cache-"));
		const otherCwd = `${cwd}-other`;
		const key = Bun.hash.wyhash(path.resolve(cwd)).toString(16).padStart(16, "0");
		const cacheDir = path.join(getAgentDir(), "cache", "composer", key);
		try {
			const preferences = { ...COMPOSER_DEFAULTS, composerShape: "rail", autocompleteMaxVisible: 7 };
			const recentSessions = [{ name: "cached work", timeAgo: "3m ago" }];
			const lspServers = [{ name: "rust-analyzer", status: "connecting" as const, fileTypes: [".rs"] }];
			const status = {
				shape: "rail",
				borderColor: { prefix: "\u001b[34m", suffix: "\u001b[39m" },
				topBorder: { content: "model · branch", width: 14 },
				bottomLines: ["tokens 42%"],
			};
			await Promise.all([
				writeComposerUiCache(cwd, preferences, {
					symbolPreset: "ascii",
					colorBlindMode: true,
					darkTheme: "dark",
					lightTheme: "light",
				}),
				writeComposerRecentSessionsCache(cwd, recentSessions),
				writeComposerLspCache(cwd, lspServers),
				writeComposerStatusCache(cwd, status),
				writeComposerWelcomeCache(cwd, { modelName: "Claude Fable 5", providerName: "anthropic" }),
			]);

			expect(readComposerStartupCache(cwd)).toEqual({
				preferences,
				theme: {
					symbolPreset: "ascii",
					colorBlindMode: true,
					darkTheme: "dark",
					lightTheme: "light",
				},
				welcome: { modelName: "Claude Fable 5", providerName: "anthropic" },
				recentSessions,
				lspServers,
				status,
			});
			expect(readComposerStartupCache(otherCwd)).toEqual({
				preferences: undefined,
				theme: undefined,
				welcome: undefined,
				recentSessions: [],
				lspServers: [],
				status: undefined,
			});
			const jsonl: unknown = Bun.JSONL.parse(await Bun.file(path.join(cacheDir, "recent-sessions.jsonl")).text());
			expect(jsonl).toEqual(recentSessions);
		} finally {
			await Promise.all([
				fs.rm(cwd, { recursive: true, force: true }),
				fs.rm(cacheDir, { recursive: true, force: true }),
			]);
		}
	});
});
