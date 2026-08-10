import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $env } from "@oh-my-pi/pi-utils";
import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

function commandCodeAuthFileName(): string {
	if ($env.COMMANDCODE_API_ENV === "local") return "auth.local.json";
	if ($env.COMMANDCODE_API_ENV === "staging") return "auth.staging.json";
	return "auth.json";
}

/** Read `apiKey` from an existing command-code CLI auth file, if present. */
function readCommandCodeAuthFileKey(): string | undefined {
	try {
		const authPath = path.join(os.homedir(), ".commandcode", commandCodeAuthFileName());
		const raw = fs.readFileSync(authPath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"apiKey" in parsed &&
			typeof (parsed as { apiKey?: unknown }).apiKey === "string"
		) {
			const apiKey = (parsed as { apiKey: string }).apiKey.trim();
			return apiKey.length > 0 ? apiKey : undefined;
		}
	} catch {
		// Missing file / bad JSON / absent key → treat as unresolved.
	}
	return undefined;
}

export const commandCodeProvider = {
	id: "command-code",
	name: "Command Code",
	envKeys: () => $env.COMMAND_CODE_API_KEY ?? readCommandCodeAuthFileKey(),
	// Lazy import: keep the login flow out of the eager registry graph.
	login: async (cb: OAuthLoginCallbacks) => (await import("./oauth/command-code")).loginCommandCode(cb),
	// Matches CALLBACK_PORT in ./oauth/command-code.
	callbackPort: 5959,
} as const satisfies ProviderDefinition;
