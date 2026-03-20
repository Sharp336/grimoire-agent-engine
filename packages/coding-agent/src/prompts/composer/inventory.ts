/**
 * Builds a structured environment inventory from the data already collected
 * by buildSystemPromptInternal. This is the "machine the harness runs on"
 * description that the compiler uses to understand available capabilities.
 */

export interface InventoryInput {
	/** Tool names and descriptions available this session */
	tools: Array<{ name: string; label: string; description: string }>;
	/** Active edit mode: hashline, patch, or replace */
	editMode: string;
	/** MCP server instructions (name + instruction text) */
	mcpServerInstructions: Array<{ name: string; instructions: string }>;
	/** Installed skills with names and descriptions */
	skills: Array<{ name: string; description: string }>;
	/** Workstation environment (OS, terminal, arch, etc.) */
	environment: Array<{ label: string; value: string }>;
	/** Current working directory */
	cwd: string;
}

export function buildInventory(input: InventoryInput): string {
	const sections: string[] = [];

	// Workstation
	sections.push("## Workstation");
	for (const { label, value } of input.environment) {
		sections.push(`- ${label}: ${value}`);
	}
	sections.push(`- Working directory: ${input.cwd}`);

	// Edit mode
	sections.push(`\n## Edit Mode\n\nActive: **${input.editMode}**`);

	// Tools — grouped by type
	const mcpToolNames = new Set<string>();
	for (const { name } of input.mcpServerInstructions) {
		mcpToolNames.add(name);
	}

	const builtinTools: typeof input.tools = [];
	const mcpTools: typeof input.tools = [];
	for (const tool of input.tools) {
		// MCP tools have slash-namespaced names or are prefixed with the server name
		if (tool.name.includes("/") || tool.name.startsWith("mcp_")) {
			mcpTools.push(tool);
		} else {
			builtinTools.push(tool);
		}
	}

	sections.push("\n## Built-in Tools");
	for (const { name, label, description } of builtinTools) {
		const desc = description ? ` — ${truncate(description, 120)}` : "";
		sections.push(`- **${label || name}**${desc}`);
	}

	if (mcpTools.length > 0) {
		sections.push("\n## MCP Tools (from connected servers)");
		for (const { name, label, description } of mcpTools) {
			const desc = description ? ` — ${truncate(description, 120)}` : "";
			sections.push(`- **${label || name}**${desc}`);
		}
	}

	// MCP servers
	if (input.mcpServerInstructions.length > 0) {
		sections.push("\n## Connected MCP Servers");
		for (const { name, instructions } of input.mcpServerInstructions) {
			sections.push(`\n### ${name}`);
			if (instructions) {
				sections.push(instructions.trim());
			}
		}
	}

	// Skills
	if (input.skills.length > 0) {
		sections.push("\n## Installed Skills");
		for (const { name, description } of input.skills) {
			const desc = description ? ` — ${truncate(description, 100)}` : "";
			sections.push(`- **${name}**${desc}`);
		}
	}

	return sections.join("\n");
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, maxLen - 3)}...`;
}
