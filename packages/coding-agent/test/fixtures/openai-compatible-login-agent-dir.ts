import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const originalAgentDir = getAgentDir();
export const openAICompatibleLoginAgentDir = TempDir.createSync("@openai-compatible-login-agent-");
setAgentDir(openAICompatibleLoginAgentDir.path());

export function restoreOpenAICompatibleLoginAgentDir(): void {
	setAgentDir(originalAgentDir);
}
