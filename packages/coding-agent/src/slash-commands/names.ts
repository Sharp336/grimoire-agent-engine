export const COMMAND_SLASH_PREFIX = "cmd:";

export function toCommandSlashName(name: string): string {
	return `${COMMAND_SLASH_PREFIX}${name}`;
}

export function stripCommandSlashName(name: string): string {
	return name.startsWith(COMMAND_SLASH_PREFIX) ? name.slice(COMMAND_SLASH_PREFIX.length) : name;
}

export function stripCommandSlashInvocation(text: string): string {
	return text.startsWith(`/${COMMAND_SLASH_PREFIX}`) ? `/${text.slice(COMMAND_SLASH_PREFIX.length + 1)}` : text;
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
		...(rawName.startsWith(COMMAND_SLASH_PREFIX) && { legacyName: rawName }),
	};
}
