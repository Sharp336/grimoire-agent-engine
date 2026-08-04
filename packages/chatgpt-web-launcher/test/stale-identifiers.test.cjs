"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(launcherRoot, "package.json"), "utf8"));
const { LINUX_DESKTOP_NAME, linuxDesktopEntry } = require("../electron/autostart.cjs");
const { PUBLIC_IPC_CHANNELS, RENDERER_ORIGIN, RENDERER_URL, SMOKE_READY_MARKER } = require("../electron/main.cjs");
const { IPC_CHANNELS } = require("../electron/preload.cjs");
const { expectedArtifactNames } = require("../scripts/package.cjs");
const { expectedArtifactName, smokeEnvironment } = require("../scripts/smoke-package.cjs");

const stalePatterns = [
	new RegExp(["codex", "web", "gpt"].join("[-_ ]"), "i"),
	new RegExp(["codex", "chatgpt", "web"].join("[-_ ]"), "i"),
	new RegExp(["dev", "codexwebgpt"].join("\\."), "i"),
	new RegExp(["CODEX", "WEB", "GPT", ""].join("_")),
	new RegExp(["CODEX", "CHATGPT", "WEB", ""].join("_")),
	new RegExp(["CODEX", "HOME"].join("_")),
];

test("packaging and runtime surfaces expose only OMP launcher identifiers", () => {
	const appDir = path.resolve("observable-app-data");
	const markerPath = path.join(appDir, "ready.json");
	const observable = JSON.stringify({
		package: {
			name: manifest.name,
			description: manifest.description,
			build: manifest.build,
		},
		renderer: { RENDERER_ORIGIN, RENDERER_URL, PUBLIC_IPC_CHANNELS, IPC_CHANNELS },
		autostart: {
			file: LINUX_DESKTOP_NAME,
			entry: linuxDesktopEntry({ getPath: () => "/opt/omp-chatgpt-web" }, "/opt/omp-chatgpt-web"),
		},
		smoke: {
			marker: SMOKE_READY_MARKER,
			environment: smokeEnvironment(appDir, markerPath, { PATH: "safe" }),
			artifacts: [
				...expectedArtifactNames("darwin", "arm64"),
				...expectedArtifactNames("linux", "x64"),
				...expectedArtifactNames("win32", "x64"),
				expectedArtifactName("darwin", "x64"),
				expectedArtifactName("linux", "arm64"),
				expectedArtifactName("win32", "arm64"),
			],
		},
	});
	for (const pattern of stalePatterns) assert.doesNotMatch(observable, pattern);
	assert.match(observable, /OMP ChatGPT Web/);
	assert.match(observable, /omp-chatgpt-web/);
});
