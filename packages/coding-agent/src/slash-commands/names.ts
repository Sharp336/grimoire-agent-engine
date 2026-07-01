export const BUILTIN_SLASH_PREFIX = "cmd:";
export const EXTENSION_SLASH_PREFIX = "ext:";
export const MCP_SLASH_PREFIX = "mcp:";
export const PROMPT_SLASH_PREFIX = "prompt:";

export function toBuiltinSlashName(name: string): string {
	return `${BUILTIN_SLASH_PREFIX}${name}`;
}

export function toExtensionSlashName(name: string): string {
	return `${EXTENSION_SLASH_PREFIX}${name}`;
}

export function toMcpSlashName(name: string): string {
	return `${MCP_SLASH_PREFIX}${name}`;
}

export function toPromptSlashName(name: string): string {
	return `${PROMPT_SLASH_PREFIX}${name}`;
}

export function stripCommandSlashName(name: string): string {
	const colonPos = name.indexOf(":");
	if (colonPos !== -1) {
		const prefix = name.slice(0, colonPos + 1);
		if (
			prefix === BUILTIN_SLASH_PREFIX ||
			prefix === EXTENSION_SLASH_PREFIX ||
			prefix === MCP_SLASH_PREFIX ||
			prefix === PROMPT_SLASH_PREFIX
		) {
			return name.slice(prefix.length);
		}
	}
	return name;
}

export function stripCommandSlashInvocation(text: string): string {
	if (!text.startsWith("/")) return text;
	const colonPos = text.indexOf(":");
	if (colonPos !== -1) {
		const prefix = text.slice(1, colonPos + 1);
		if (
			prefix === BUILTIN_SLASH_PREFIX ||
			prefix === EXTENSION_SLASH_PREFIX ||
			prefix === MCP_SLASH_PREFIX ||
			prefix === PROMPT_SLASH_PREFIX
		) {
			return `/${text.slice(1 + prefix.length)}`;
		}
	}
	return text;
}

export interface ParsedSlashToken {
	name: string;
	args: string;
	legacyName?: string;
}

export function parseSlashToken(text: string): ParsedSlashToken | null {
	if (!text.startsWith("/")) return null;
	const spaceIndex = text.indexOf(" ");
	const rawName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const rawArgs = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);
	return {
		name: stripCommandSlashName(rawName),
		args: rawArgs,
		...((rawName.startsWith(BUILTIN_SLASH_PREFIX) ||
			rawName.startsWith(EXTENSION_SLASH_PREFIX) ||
			rawName.startsWith(MCP_SLASH_PREFIX) ||
			rawName.startsWith(PROMPT_SLASH_PREFIX)) && { legacyName: rawName }),
	};
}
