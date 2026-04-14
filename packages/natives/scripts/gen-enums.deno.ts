import * as path from "node:path";

const __dirname = import.meta.dirname!;
const nativeDir = path.resolve(__dirname, "../native");
const dtsPath = path.join(nativeDir, "index.d.ts");
const jsPath = path.join(nativeDir, "index.js");

const dts = await Deno.readTextFile(dtsPath);

const CONST_ENUM_RE = /export declare const enum (\w+)\s*\{(.*?)\n\}/gs;
const enums: string[] = [];

for (;;) {
	const match = CONST_ENUM_RE.exec(dts);
	if (match === null) break;

	const name = match[1];
	const body = match[2];
	const entries: string[] = [];

	for (const line of body!.split("\n")) {
		const m = line.match(/^\s*(\w+)\s*=\s*'([^']*)'/) ?? line.match(/^\s*(\w+)\s*=\s*(\d+)/);
		if (m) {
			const value = m[2]!.match(/^\d+$/) ? m[2] : `'${m[2]}'`;
			entries.push(`  ${m[1]}: ${value},`);
		}
	}

	if (entries.length > 0) {
		enums.push(`module.exports.${name} = {\n${entries.join("\n")}\n};`);
	}
}

if (enums.length === 0) {
	console.error("No const enums found in index.d.ts — check napi build output");
	Deno.exit(1);
}

const MARKER_START = "// --- generated const enum exports (do not edit) ---";
const MARKER_END = "// --- end generated const enum exports ---";
const enumBlock = `${MARKER_START}\n${enums.join("\n")}\n${MARKER_END}\n`;

let js = await Deno.readTextFile(jsPath);

const startIdx = js.indexOf(MARKER_START);
const endIdx = js.indexOf(MARKER_END);

if (startIdx !== -1 && endIdx !== -1) {
	js = js.slice(0, startIdx) + enumBlock;
} else {
	js = `${js.trimEnd()}\n\n${enumBlock}`;
}

await Deno.writeTextFile(jsPath, js);

let dtsContent = await Deno.readTextFile(dtsPath);
const constEnumCount = (dtsContent.match(/export declare const enum/g) || []).length;
dtsContent = dtsContent.replaceAll("export const enum", "export declare enum");
dtsContent = dtsContent.replaceAll("export declare const enum", "export declare enum");
await Deno.writeTextFile(dtsPath, dtsContent);

console.log(`Generated ${enums.length} enum exports in index.js, fixed ${constEnumCount} const enums in index.d.ts`);
