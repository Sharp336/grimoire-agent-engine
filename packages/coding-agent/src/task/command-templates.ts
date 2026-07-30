import { prompt } from "@oh-my-pi/pi-utils";
import initMd from "../prompts/agents/init.md" with { type: "text" };

export const EMBEDDED_COMMAND_TEMPLATES: ReadonlyArray<{ name: string; content: string }> = [
	{ name: "init.md", content: prompt.render(initMd) },
];
