import * as os from "node:os";
import * as path from "node:path";
import { getMCPConfigPath, getProjectDir } from "@oh-my-pi/pi-utils";

function shortenPath(filePath: string): string {
	const home = os.homedir();
	if (!home) {
		return filePath;
	}

	const normalizedHome = path.normalize(home);
	const normalizedFile = path.normalize(filePath);
	const homeForCompare = process.platform === "win32" ? normalizedHome.toLowerCase() : normalizedHome;
	const fileForCompare = process.platform === "win32" ? normalizedFile.toLowerCase() : normalizedFile;

	if (fileForCompare === homeForCompare) {
		return "~";
	}

	const homeWithSeparator = homeForCompare.endsWith(path.sep) ? homeForCompare : `${homeForCompare}${path.sep}`;
	if (!fileForCompare.startsWith(homeWithSeparator)) {
		return filePath;
	}

	const relativePath = path.relative(home, filePath);
	if (!relativePath || relativePath === ".") {
		return "~";
	}

	return path.join("~", relativePath);
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
