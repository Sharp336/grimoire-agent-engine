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
}

function makeReExport(target: string): string {
	return [`export * from "${target}";`, ""].join("\n");
}

async function writeShimPackage(nodeModulesDir: string, shim: ShimPackage): Promise<void> {
	const packageDir = path.join(nodeModulesDir, shim.name);
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
			files: { "index.ts": makeReExport("@oh-my-pi/pi-coding-agent") },
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
				"index.ts": makeReExport("@oh-my-pi/pi-ai"),
				"oauth.ts": makeReExport("@oh-my-pi/pi-ai/utils/oauth"),
			},
			exports: { ".": "./index.ts", "./oauth": "./oauth.ts", "./*": "./*.ts" },
		},
		{
			name: "@mariozechner/pi-tui",
			files: { "index.ts": makeReExport("@oh-my-pi/pi-tui") },
			exports: { ".": "./index.ts", "./*": "./*.ts" },
		},
		{
			name: "typebox",
			files: {
				"index.ts": makeReExport("@sinclair/typebox"),
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
	];

	await fs.promises.mkdir(nodeModulesDir, { recursive: true });
	await Promise.all(shims.map(shim => writeShimPackage(nodeModulesDir, shim)));
}
