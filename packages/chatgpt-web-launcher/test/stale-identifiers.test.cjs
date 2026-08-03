"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const launcherRoot = path.resolve(__dirname, "..");
const TEXT_EXTENSIONS = new Set([".cjs", ".css", ".html", ".js", ".json", ".lock", ".md", ".mjs", ".ts", ".tsx", ".txt", ".yaml", ".yml"]);
const ALLOWED_ATTRIBUTION_FILES = new Set([
	"build/runtime/LICENSES/NOTICE.md",
	"build/runtime/LICENSES/OpenCodex-MIT.txt",
]);
const SOURCE_REPOSITORY_PARTS = [
	"miuuyy",
	"codex",
	"chatgpt",
	"web",
];
const stalePatterns = [
	{ label: "source product slug", pattern: new RegExp(["codex", "web", "gpt"].join("[-_ ]"), "i") },
	{ label: "source package slug", pattern: new RegExp(["codex", "chatgpt", "web"].join("[-_ ]"), "i") },
	{ label: "source application id", pattern: new RegExp(["dev", "codexwebgpt"].join("\\."), "i") },
	{ label: "source launcher environment", pattern: new RegExp(["CODEX", "WEB", "GPT", ""].join("_")) },
	{ label: "source provider environment", pattern: new RegExp(["CODEX", "CHATGPT", "WEB", ""].join("_")) },
	{ label: "source home environment", pattern: new RegExp(["CODEX", "HOME"].join("_")) },
	{ label: "source catalog monitor", pattern: new RegExp(["codex", "Catalog", "Verified"].join("")) },
	{ label: "source route integration", pattern: new RegExp(["bridge", "Route"].join("")) },
	{ label: "source integration journal", pattern: new RegExp(["integration", "journal"].join("[-_]"), "i") },
	{ label: "source repository URL", pattern: new RegExp(SOURCE_REPOSITORY_PARTS.join(".*"), "i") },
];

function textFiles(root) {
	const files = [];
	function visit(directory) {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			if (["node_modules", ".git"].includes(entry.name)) continue;
			const value = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error("launcher_scan_encountered_link");
			if (entry.isDirectory()) visit(value);
			else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name))) files.push(value);
		}
	}
	visit(root);
	return files.sort();
}

test("launcher sources and generated artifacts contain no source-launcher identifiers", () => {
	const failures = [];
	for (const file of textFiles(launcherRoot)) {
		const relative = path.relative(launcherRoot, file).split(path.sep).join("/");
		if (ALLOWED_ATTRIBUTION_FILES.has(relative)) continue;
		const source = fs.readFileSync(file, "utf8");
		for (const stale of stalePatterns) {
			if (stale.pattern.test(source)) failures.push(`${relative}: ${stale.label}`);
		}
	}
	assert.deepEqual(failures, []);
});

test("the attribution allowlist is limited to deliberate packaged notices", () => {
	assert.deepEqual([...ALLOWED_ATTRIBUTION_FILES], [
		"build/runtime/LICENSES/NOTICE.md",
		"build/runtime/LICENSES/OpenCodex-MIT.txt",
	]);
});
