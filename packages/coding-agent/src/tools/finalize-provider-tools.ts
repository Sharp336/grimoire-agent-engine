import type { Tool } from "@oh-my-pi/pi-ai";
import type { SecretObfuscator } from "../secrets/obfuscator";
import { obfuscateProviderTools } from "../secrets/obfuscator";
import { type CompactProviderToolDefinitionsMode, compactProviderTools } from "./compact-provider-tools";

/** Provider-visible tool definitions (obfuscation + optional compaction). Session tools stay unchanged. */
export function finalizeProviderToolDefinitions(
	tools: Tool[] | undefined,
	opts: {
		obfuscator: SecretObfuscator | undefined;
		compactMode: CompactProviderToolDefinitionsMode;
	},
): Tool[] | undefined {
	const obfuscated = obfuscateProviderTools(opts.obfuscator, tools);
	return compactProviderTools(obfuscated, opts.compactMode);
}
