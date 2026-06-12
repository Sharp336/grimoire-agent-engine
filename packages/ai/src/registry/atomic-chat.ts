import type { OAuthController, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

const PROVIDER_ID = "atomic-chat";
export const DEFAULT_LOCAL_TOKEN = "atomic-chat-local";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:1337/v1";

export async function loginAtomicChat(options: OAuthController): Promise<string> {
	if (!options.onPrompt) {
		throw new Error(`${PROVIDER_ID} login requires onPrompt callback`);
	}

	const apiKey = await options.onPrompt({
		message: `Optional: Paste Atomic Chat API key (to customize endpoint URL, set ATOMIC_CHAT_BASE_URL env var; default: ${DEFAULT_LOCAL_BASE_URL})`,
		placeholder: DEFAULT_LOCAL_TOKEN,
		allowEmpty: true,
	});

	if (options.signal?.aborted) {
		throw new Error("Login cancelled");
	}

	const trimmed = apiKey.trim();
	return trimmed || DEFAULT_LOCAL_TOKEN;
}

export const atomicChatProvider = {
	id: "atomic-chat",
	name: "Atomic Chat (Local OpenAI-compatible)",
	login: (cb: OAuthLoginCallbacks) => loginAtomicChat(cb),
} as const satisfies ProviderDefinition;
