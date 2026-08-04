import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, getConfigRootDir, refreshDirsFromEnv } from "./dirs";
import {
	isMacosMallocStackLoggingEnvName,
	isSafeEnvName,
	isSafeEnvValue,
	markProjectEnvLoaded,
	parseEnvFile,
} from "./env-core";

export * from "./env-core";

// Eagerly parse the user's $HOME/.env and the current project's .env (from cwd)
const homeEnv = parseEnvFile(path.join(os.homedir(), ".env"));
const piEnv = parseEnvFile(path.join(getConfigRootDir(), ".env"));
const agentEnv = parseEnvFile(path.join(getAgentDir(), ".env"));
const projectEnv = parseEnvFile(path.join(process.cwd(), ".env"));

for (const key of Object.keys(Bun.env)) {
	const value = Bun.env[key];
	if (!isSafeEnvName(key) || isMacosMallocStackLoggingEnvName(key) || value === undefined || !isSafeEnvValue(value)) {
		delete Bun.env[key];
	}
}

for (const file of [projectEnv, agentEnv, piEnv, homeEnv]) {
	for (const key in file) {
		if (!isMacosMallocStackLoggingEnvName(key) && !Bun.env[key]) {
			Bun.env[key] = file[key];
			if (file === projectEnv) markProjectEnvLoaded(key);
		}
	}
}

// Directory-affecting keys (XDG_*_HOME, and in default mode PI_CODING_AGENT_DIR)
// may have just arrived from the profile/agent `.env` applied above. The dirs
// resolver cached its paths at module load — before this file ran — so rebuild
// it now from the updated env. `getAgentDir()` already located the `.env` from
// the profile name + home, so this re-reads only the directory vars.
refreshDirsFromEnv();
