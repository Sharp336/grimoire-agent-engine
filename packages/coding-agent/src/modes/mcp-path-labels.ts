import * as os from "node:os";
import { getMCPConfigPath, getProjectDir } from "@oh-my-pi/pi-utils";

function shortenPath(filePath: string): string {
	const home = os.homedir();
	if (home && filePath.startsWith(home)) {
		return `~${filePath.slice(home.length)}`;
	}
	return filePath;
}

export interface MCPScopePathLabels {
	user: string;
	project: string;
}

export function getMCPScopePathLabels(cwd: string = getProjectDir()): MCPScopePathLabels {
	return {
		user: shortenPath(getMCPConfigPath("user", cwd)),
		project: shortenPath(getMCPConfigPath("project", cwd)),
	};
}
