import * as path from "node:path";

import { getActiveProfile, getAgentDir } from "@oh-my-pi/pi-utils/dirs";

export const PROMPT_GATE_CAPABILITY = "prompt-gate-v1";
export const PROMPT_GATE_PROTOCOL_VERSION = 1;
export const PROMPT_GATE_DIRECTORY_NAME = "prompt-gates";

export interface PromptGateCapabilityResponse {
	capabilities: [typeof PROMPT_GATE_CAPABILITY];
	profile: string;
	agent_dir: string;
	gate_dir: string;
	cwd: string;
}

export function getPromptGateDirectory(agentDir = getAgentDir()): string {
	return path.join(path.resolve(agentDir), PROMPT_GATE_DIRECTORY_NAME);
}

export function resolvePromptGateCapability(options?: {
	profile?: string;
	agentDir?: string;
	cwd?: string;
}): PromptGateCapabilityResponse {
	const agentDir = path.resolve(options?.agentDir ?? getAgentDir());
	return {
		capabilities: [PROMPT_GATE_CAPABILITY],
		profile: options?.profile ?? getActiveProfile() ?? "default",
		agent_dir: agentDir,
		gate_dir: getPromptGateDirectory(agentDir),
		cwd: path.resolve(options?.cwd ?? process.cwd()),
	};
}
