#!/usr/bin/env bun
/**
 * 从源码中提取 i18n 翻译 key，生成英文模板和中文翻译文件
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const LAN_DIR = path.join(os.homedir(), ".omp", "lang");

// eslint-disable-next-line @typescript-eslint/consistent-indexed-object-style
type TranslationData = {
	[key: string]: string | TranslationData;
};

function extractMatches(regex: RegExp, text: string): RegExpExecArray[] {
	const results: RegExpExecArray[] = [];
	for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
		results.push(match);
	}
	return results;
}

function extractSettingsTranslations(): TranslationData {
	const schemaPath = path.join(REPO_ROOT, "packages/coding-agent/src/config/settings-schema.ts");
	const content = fs.readFileSync(schemaPath, "utf-8");
	const translations: TranslationData = {};

	const tabMetadataMatch = content.match(/export const TAB_METADATA[^{]*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/s);
	if (tabMetadataMatch) {
		const tabBlock = tabMetadataMatch[1];
		const tabRegex = /(\w+):\s*\{[^}]*label:\s*"([^"]+)"/g;
		for (const match of extractMatches(tabRegex, tabBlock)) {
			translations[`tabs.${match[1]}.label`] = match[2];
		}
	}

	const tabGroupsMatch = content.match(/export const TAB_GROUPS[^{]*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/s);
	if (tabGroupsMatch) {
		const groupsBlock = tabGroupsMatch[1];
		const groupRegex = /(\w+):\s*\[([^\]]+)\]/g;
		for (const match of extractMatches(groupRegex, groupsBlock)) {
			const tabName = match[1];
			const groups = match[2].match(/"([^"]+)"/g);
			if (groups) {
				for (let idx = 0; idx < groups.length; idx++) {
					const groupName = groups[idx].replace(/"/g, "");
					translations[`tabs.${tabName}.groups.${idx}`] = groupName;
				}
			}
		}
	}

	const settingsRegex = /ui:\s*\{[^}]*path:\s*"([^"]+)"[^}]*label:\s*"([^"]+)"[^}]*description:\s*"([^"]+)"/gs;
	for (const match of extractMatches(settingsRegex, content)) {
		translations[`settings.${match[1]}.label`] = match[2];
		translations[`settings.${match[1]}.description`] = match[3];
	}

	return translations;
}

function extractCommandClassDesc(content: string, commandName: string): Record<string, string> {
	const result: Record<string, string> = {};
	// Match static description on the command class
	const descRe = /static\s+description\s*=\s*"([^"]+)"/s;
	const descMatch = content.match(descRe);
	if (descMatch) {
		result[`commands.${commandName}.description`] = descMatch[1];
	}
	return result;
}

function extractArgsAndFlagsScoped(content: string, commandName: string): Record<string, string> {
	const result: Record<string, string> = {};

	// Extract arg descriptions: name: Args.string({ description: "..." })
	// Support multiline by matching the full Args call
	const argRe = /(?:("|')?)([\w-]+)\1:\s*Args\.\w+\(\{[^}]*?description:\s*"([^"]+)"/gs;
	for (const match of extractMatches(argRe, content)) {
		const key = `${commandName}.args.${match[2]}.description`;
		if (!result[key]) result[key] = match[3];
	}

	// Extract flag descriptions: name: Flags.string({ description: "..." })
	const flagRe = /(?:("|')?)([\w-]+)\1:\s*Flags\.\w+\(\{[^}]*?description:\s*"([^"]+)"/gs;
	for (const match of extractMatches(flagRe, content)) {
		const key = `${commandName}.flags.${match[2]}.description`;
		if (!result[key]) result[key] = match[3];
	}

	return result;
}

function buildFileNameToPublicNameMap(): Record<string, string> {
	const registryPath = path.join(REPO_ROOT, "packages/coding-agent/src/cli-commands.ts");
	const content = fs.readFileSync(registryPath, "utf-8");
	const map: Record<string, string> = {};
	// Match lines like: { name: "search", load: () => import("./commands/web-search").then(m => m.default), aliases: ["q"] },
	const regex = /name:\s*"([^"]+)",\s*load:\s*\(\)\s*=>\s*import\("\.\/commands\/([^"]+)"\)/g;
	for (let match = regex.exec(content); match !== null; match = regex.exec(content)) {
		const publicName = match[1];
		const fileName = match[2];
		map[fileName] = publicName;
	}
	return map;
}

function extractCommandsTranslations(): TranslationData {
	const commandsDir = path.join(REPO_ROOT, "packages/coding-agent/src/commands");
	const fileNameToPublicName = buildFileNameToPublicNameMap();
	const translations: TranslationData = {};
	const files = fs.readdirSync(commandsDir).filter(f => f.endsWith(".ts"));

	for (const file of files) {
		const content = fs.readFileSync(path.join(commandsDir, file), "utf-8");
		const fileName = file.replace(".ts", "");
		const commandName = fileNameToPublicName[fileName] ?? fileName;

		// Command class description
		Object.assign(translations, extractCommandClassDesc(content, commandName));

		// Scoped args/flags descriptions (per command)
		Object.assign(translations, extractArgsAndFlagsScoped(content, commandName));
	}

	return translations;
}

function extractCliTranslations(): TranslationData {
	return {
		"cli.usage": "USAGE",
		"cli.commands": "COMMANDS",
		"cli.arguments": "ARGUMENTS",
		"cli.flags": "FLAGS",
		"cli.examples": "EXAMPLES",
	};
}

function generateTranslationFiles() {
	console.log("Extracting translations from source code...");

	const allTranslations = {
		...extractCliTranslations(),
		...extractSettingsTranslations(),
		...extractCommandsTranslations(),
	};

	console.log(`Found ${Object.keys(allTranslations).length} translation keys`);

	if (!fs.existsSync(LAN_DIR)) {
		fs.mkdirSync(LAN_DIR, { recursive: true });
	}

	const enFile = path.join(LAN_DIR, "en-commands.json");
	fs.writeFileSync(enFile, JSON.stringify(allTranslations, null, 2));
	console.log(`Generated: ${enFile}`);

	const zhFile = path.join(LAN_DIR, "zh-commands.json");

	// Read existing translations to preserve non-empty values
	let existingZh: Record<string, string> = {};
	try {
		existingZh = JSON.parse(fs.readFileSync(zhFile, "utf-8"));
	} catch {
		/* file doesn't exist yet */
	}

	// Merge: preserve existing non-empty values, use empty for new keys
	const zhTranslations: Record<string, string> = {};
	for (const key of Object.keys(allTranslations)) {
		zhTranslations[key] = existingZh[key] || "";
	}

	fs.writeFileSync(zhFile, JSON.stringify(zhTranslations, null, 2));
	console.log(`Generated: ${zhFile}`);

	console.log("\nDone! Fill in zh-commands.json with Chinese translations.");
}

try {
	generateTranslationFiles();
} catch (error) {
	console.error("Error generating translations:", error);
	process.exit(1);
}
