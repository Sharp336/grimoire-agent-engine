import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executeHashlineSingle } from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "hashline-smoke-"));
const file = path.join(cwd, "view.rs");
const content =
	[
		"pub struct Panel {",
		"    pub title: String,",
		"}",
		"",
		"pub fn reload() {",
		'    println!("reload");',
		"}",
		"",
		"fn helper() {}",
		"",
		"fn tail_a() {}",
		"fn tail_b() {}",
	].join("\n") + "\n";
await Bun.write(file, content);

const session = {
	cwd,
	hasUI: false,
	getSessionFile: () => path.join(cwd, "session.jsonl"),
	getSessionSpawns: () => "*",
	getArtifactsDir: () => path.join(cwd, "artifacts"),
	allocateOutputArtifact: async () => ({ id: "a1", path: path.join(cwd, "a1.log") }),
	settings: Settings.isolated(),
	enableLsp: false,
} as ToolSession;

await Settings.init({ inMemory: true });
const read = await new ReadTool(session).execute("r1", { path: file });
const readText = read.content.map(b => (b.type === "text" ? b.text : "")).join("\n");
const tag = /\[([^#\r\n]+)#([0-9A-F]{4})\]/m.exec(readText)?.[2];
if (!tag) throw new Error("no tag minted");

// Two interacting hunks: grow reload() by 2 lines, shrink the helper/blank
// pair by 1 line — net +1 across two non-zero deltas.
const input = [
	`[view.rs#${tag}]`,
	"PUT 5.=7:",
	"+pub fn reload() {",
	"+    if true {",
	'+        println!("reload");',
	"+    }",
	"+}",
	"PUT 10.=11:",
	"+fn helper_impl() {}",
].join("\n");

const result = await executeHashlineSingle({
	session,
	input,
	writethrough: async (p, c) => {
		await Bun.write(p, c);
	},
	beginDeferredDiagnosticsForPath: () => ({
		onDeferredDiagnostics: () => {},
		signal: new AbortController().signal,
		finalize: () => {},
	}),
});

console.log(result.content.map(b => (b.type === "text" ? b.text : "")).join("\n"));
await fs.rm(cwd, { recursive: true, force: true });
