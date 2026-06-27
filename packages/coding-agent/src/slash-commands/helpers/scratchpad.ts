import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	ensureLocalScratchpad,
	LOCAL_SCRATCHPAD_DIRECTORIES,
	LocalProtocolHandler,
	type LocalProtocolOptions,
	parseInternalUrl,
	resolveLocalUrlToPath,
} from "../../internal-urls";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./parse";

const SCRATCHPAD_HELP = `Usage: /scratchpad [list|path|save <local-path> <content>]

Commands:
  /scratchpad list                  Show the session scratchpad root and files
  /scratchpad path                  Show the on-disk scratchpad root
  /scratchpad save reports/x.md ... Write content to local://reports/x.md

Standard directories: plans, reports, results, thoughts`;

function getLocalProtocolOptions(runtime: SlashCommandRuntime): LocalProtocolOptions {
	return {
		getArtifactsDir: () => runtime.sessionManager.getArtifactsDir(),
		getSessionId: () => runtime.sessionManager.getSessionId(),
	};
}

async function listFiles(root: string, dir = root): Promise<string[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		const relative = path.relative(root, fullPath).replace(/\\/g, "/");
		if (entry.isDirectory()) {
			files.push(...(await listFiles(root, fullPath)));
		} else if (entry.isFile()) {
			files.push(relative);
		}
	}
	return files.sort();
}

function parseSaveArgs(rest: string): { target: string; content: string } | { error: string } {
	const trimmed = rest.trim();
	if (!trimmed) return { error: "Usage: /scratchpad save <local-path> <content>" };
	const splitAt = trimmed.search(/\s/);
	if (splitAt === -1) return { error: "Usage: /scratchpad save <local-path> <content>" };
	const target = trimmed.slice(0, splitAt).trim();
	const content = trimmed.slice(splitAt).trimStart();
	if (!target) return { error: "Scratchpad path is required." };
	if (!content) return { error: "Scratchpad content is required." };
	return { target, content };
}

function toLocalUrl(target: string): string {
	if (target.startsWith("local://")) return target;
	return `local://${target.replace(/^\/+/, "")}`;
}

async function handleList(runtime: SlashCommandRuntime, options: LocalProtocolOptions): Promise<SlashCommandResult> {
	const root = await ensureLocalScratchpad(options);
	const files = await listFiles(root);
	const lines = [
		`Scratchpad: local:// (${root})`,
		"Standard directories:",
		...LOCAL_SCRATCHPAD_DIRECTORIES.map(dir => `  - local://${dir}/`),
		"",
		files.length === 0 ? "No scratchpad files yet." : "Files:",
		...(files.length === 0 ? [] : files.map(file => `  - local://${file}`)),
	];
	await runtime.output(lines.join("\n"));
	return commandConsumed();
}

async function handleSave(
	runtime: SlashCommandRuntime,
	options: LocalProtocolOptions,
	rest: string,
): Promise<SlashCommandResult> {
	const parsed = parseSaveArgs(rest);
	if ("error" in parsed) return usage(parsed.error, runtime);
	const url = toLocalUrl(parsed.target);
	const handler = new LocalProtocolHandler();
	try {
		await handler.write(parseInternalUrl(url), parsed.content, {
			cwd: runtime.cwd,
			localProtocolOptions: options,
		});
	} catch (err) {
		return usage(`Failed to write scratchpad file: ${errorMessage(err)}`, runtime);
	}
	await runtime.output(`Saved scratchpad note: ${url}`);
	return commandConsumed();
}

export async function handleScratchpadAcp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { verb, rest } = parseSubcommand(command.args);
	const options = getLocalProtocolOptions(runtime);
	if (!verb || verb === "list") return handleList(runtime, options);
	if (verb === "help" || verb === "?") return usage(SCRATCHPAD_HELP, runtime);
	if (verb === "path") {
		await runtime.output(resolveLocalUrlToPath("local://", options));
		return commandConsumed();
	}
	if (verb === "save") return handleSave(runtime, options, rest);
	return usage(SCRATCHPAD_HELP, runtime);
}
