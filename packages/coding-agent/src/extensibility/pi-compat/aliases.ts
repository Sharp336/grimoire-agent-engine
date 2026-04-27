import * as fs from "node:fs";
import * as path from "node:path";
import { getPluginsNodeModules } from "@oh-my-pi/pi-utils";

export interface PiImportAlias {
	from: string;
	to: string;
}

const PI_IMPORT_ALIASES: PiImportAlias[] = [
	{ from: "@mariozechner/pi-coding-agent", to: "@oh-my-pi/pi-coding-agent" },
	{ from: "@mariozechner/pi-agent-core", to: "@oh-my-pi/pi-agent-core" },
	{ from: "@mariozechner/pi-ai", to: "@oh-my-pi/pi-ai" },
	{ from: "@mariozechner/pi-ai/oauth", to: "@oh-my-pi/pi-ai/utils/oauth" },
	{ from: "@mariozechner/pi-tui", to: "@oh-my-pi/pi-tui" },
	{ from: "typebox", to: "@sinclair/typebox" },
	{ from: "typebox/compile", to: "@sinclair/typebox/compiler" },
	{ from: "typebox/compiler", to: "@sinclair/typebox/compiler" },
	{ from: "typebox/value", to: "@sinclair/typebox/value" },
];

interface ShimPackage {
	name: string;
	files: Record<string, string>;
	exports: Record<string, string>;
	skipIfPackageExists?: boolean;
}

function resolveShimTarget(target: string): string {
	return import.meta.resolve(target);
}

function makeReExport(target: string): string {
	return [`export * from "${resolveShimTarget(target)}";`, ""].join("\n");
}

function codingAgentShimContent(): string {
	return [
		makeReExport("@oh-my-pi/pi-coding-agent").trimEnd(),
		`import { parseFrontmatter } from "${resolveShimTarget("@oh-my-pi/pi-utils/frontmatter")}";`,
		"export { parseFrontmatter };",
		"export function stripFrontmatter(content) {",
		"\treturn parseFrontmatter(content).body;",
		"}",
		"export function keyText(key) {",
		"\treturn key;",
		"}",
		"",
	].join("\n");
}

function piAiShimContent(): string {
	return [
		makeReExport("@oh-my-pi/pi-ai").trimEnd(),
		"export function getModel() {",
		"\treturn undefined;",
		"}",
		"",
	].join("\n");
}

function piTuiShimContent(): string {
	return [
		makeReExport("@oh-my-pi/pi-tui").trimEnd(),
		"export const Key = {",
		'\tescape: "escape",',
		'\tenter: "enter",',
		'\ttab: "tab",',
		'\tbackspace: "backspace",',
		'\tup: "up",',
		'\tdown: "down",',
		'\tleft: "left",',
		'\tright: "right",',
		"\tctrl: key => 'ctrl+' + key,",
		"\tshift: key => 'shift+' + key,",
		"\talt: key => 'alt+' + key,",
		"\tctrlShift: key => 'ctrl+shift+' + key,",
		"};",
		"",
	].join("\n");
}

function typeboxShimContent(): string {
	const target = resolveShimTarget("@sinclair/typebox");
	return [
		`export * from "${target}";`,
		`import { Type as BaseType } from "${target}";`,
		"export const Type = {",
		"\t...BaseType,",
		"\tCyclic: BaseType.Cyclic ?? ((schema) => schema),",
		"};",
		"",
	].join("\n");
}

async function writeShimPackage(nodeModulesDir: string, shim: ShimPackage): Promise<void> {
	const packageDir = path.join(nodeModulesDir, shim.name);
	if (shim.skipIfPackageExists && fs.existsSync(path.join(packageDir, "package.json"))) {
		return;
	}
	await fs.promises.mkdir(packageDir, { recursive: true });
	await Bun.write(
		path.join(packageDir, "package.json"),
		JSON.stringify(
			{
				name: shim.name,
				version: "0.0.0-omp-pi-compat",
				private: true,
				type: "module",
				main: "./index.ts",
				exports: shim.exports,
			},
			null,
			2,
		),
	);
	for (const [fileName, content] of Object.entries(shim.files)) {
		await Bun.write(path.join(packageDir, fileName), content);
	}
}

export function getPiImportAliases(): readonly PiImportAlias[] {
	return PI_IMPORT_ALIASES;
}

export async function ensurePiCompatImportShims(nodeModulesDir: string = getPluginsNodeModules()): Promise<void> {
	const shims: ShimPackage[] = [
		{
			name: "@mariozechner/pi-coding-agent",
			files: { "index.ts": codingAgentShimContent() },
			exports: { ".": "./index.ts", "./*": "./*.ts" },
		},
		{
			name: "@mariozechner/pi-agent-core",
			files: { "index.ts": makeReExport("@oh-my-pi/pi-agent-core") },
			exports: { ".": "./index.ts", "./*": "./*.ts" },
		},
		{
			name: "@mariozechner/pi-ai",
			files: {
				"index.ts": piAiShimContent(),
				"oauth.ts": makeReExport("@oh-my-pi/pi-ai/utils/oauth"),
			},
			exports: { ".": "./index.ts", "./oauth": "./oauth.ts", "./*": "./*.ts" },
		},
		{
			name: "@mariozechner/pi-tui",
			files: { "index.ts": piTuiShimContent() },
			exports: { ".": "./index.ts", "./*": "./*.ts" },
		},
		{
			name: "typebox",
			files: {
				"index.ts": typeboxShimContent(),
				"compile.ts": makeReExport("@sinclair/typebox/compiler"),
				"compiler.ts": makeReExport("@sinclair/typebox/compiler"),
				"value.ts": makeReExport("@sinclair/typebox/value"),
			},
			exports: {
				".": "./index.ts",
				"./compile": "./compile.ts",
				"./compiler": "./compiler.ts",
				"./value": "./value.ts",
			},
		},
		{
			name: "@sinclair/typebox",
			skipIfPackageExists: true,
			files: {
				"index.ts": typeboxShimContent(),
				"compiler.ts": makeReExport("@sinclair/typebox/compiler"),
				"value.ts": makeReExport("@sinclair/typebox/value"),
			},
			exports: {
				".": "./index.ts",
				"./compiler": "./compiler.ts",
				"./value": "./value.ts",
			},
		},
	];

	await fs.promises.mkdir(nodeModulesDir, { recursive: true });
	await Promise.all(shims.map(shim => writeShimPackage(nodeModulesDir, shim)));
}
