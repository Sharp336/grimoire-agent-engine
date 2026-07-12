import { type AcquiredAuthCredential, type AuthCredential, acquireAuthCredential } from "@oh-my-pi/pi-ai";
import type { AuthGatewayAdminClient, AuthGatewayCredentialSummary } from "@oh-my-pi/pi-ai/auth-gateway";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type {
	OAuthAuthInfo,
	OAuthController,
	OAuthPrompt,
	OAuthProviderId,
	OAuthProviderInfo,
} from "@oh-my-pi/pi-ai/oauth/types";

export interface AuthGatewayAccountLoginResult {
	ok: boolean;
	message: string;
	credentials: AuthGatewayCredentialSummary[];
}

export interface AuthGatewayAccountLoginOptions {
	provider: OAuthProviderId;
	client: AuthGatewayAdminClient;
	controller?: OAuthController;
	acquire?: (controller: OAuthController) => Promise<AcquiredAuthCredential | null>;
	upload?: (
		provider: string,
		credential: AuthCredential,
		signal?: AbortSignal,
	) => Promise<AuthGatewayCredentialSummary[]>;
}

export interface AuthGatewayAccountLoginPromptState {
	message: string;
	placeholder: string | null;
	value: string;
	masked: boolean;
}

export interface AuthGatewayAccountLoginState {
	authUrl: string | null;
	instructions: string | null;
	progress: string[];
	prompt: AuthGatewayAccountLoginPromptState | null;
}

export interface AuthGatewayAccountLoginControllerOptions {
	openInBrowser(url: string): void;
	requestRender(): void;
}

export class AuthGatewayAccountLoginController {
	readonly oauthController: OAuthController;
	readonly #openInBrowser: (url: string) => void;
	readonly #requestRender: () => void;
	readonly #abort = new AbortController();
	#state: AuthGatewayAccountLoginState = { authUrl: null, instructions: null, progress: [], prompt: null };
	#pendingPrompt: PromiseWithResolvers<string> | null = null;
	#closed = false;

	constructor(options: AuthGatewayAccountLoginControllerOptions) {
		this.#openInBrowser = options.openInBrowser;
		this.#requestRender = options.requestRender;
		this.oauthController = {
			signal: this.#abort.signal,
			onAuth: info => this.#handleAuth(info),
			onProgress: message => this.#handleProgress(message),
			onPrompt: prompt => this.#requestPrompt(prompt, true),
			onManualCodeInput: () =>
				this.#requestPrompt({ message: "Paste the authorization code (or full redirect URL):" }, false),
		};
	}

	get state(): AuthGatewayAccountLoginState {
		return this.#state;
	}

	abort(): void {
		this.#closed = true;
		this.#abort.abort();
		this.#pendingPrompt?.resolve("");
		this.#pendingPrompt = null;
		this.#state.prompt = null;
		this.#state.progress = [];
	}

	handleInput(data: string): boolean {
		if (this.#closed) return false;
		const prompt = this.#state.prompt;
		if (!prompt) return false;
		if (data === "\x1b" || data === "\x03") {
			this.abort();
			this.#requestRender();
			return true;
		}
		if (data === "\n" || data === "\r") {
			const value = prompt.value;
			prompt.value = "";
			this.#state.prompt = null;
			this.#pendingPrompt?.resolve(value);
			this.#pendingPrompt = null;
			this.#requestRender();
			return true;
		}
		if (data === "\x7f" || data === "\b") {
			prompt.value = prompt.value.slice(0, -1);
			this.#requestRender();
			return true;
		}
		if (data === "\x15") {
			prompt.value = "";
			this.#requestRender();
			return true;
		}
		const printable = printablePromptInput(data);
		if (!printable) return true;
		prompt.value += printable;
		this.#requestRender();
		return true;
	}

	#handleAuth(info: OAuthAuthInfo): void {
		if (this.#closed) return;
		const url = info.launchUrl ?? info.url;
		this.#state.authUrl = url;
		this.#state.instructions = info.instructions ?? null;
		this.#openInBrowser(url);
		this.#requestRender();
	}

	#handleProgress(message: string): void {
		if (this.#closed) return;
		this.#state.progress = [...this.#state.progress, message].slice(-4);
		this.#requestRender();
	}

	#requestPrompt(prompt: OAuthPrompt, masked: boolean): Promise<string> {
		if (this.#closed) return Promise.resolve("");
		this.#pendingPrompt?.resolve("");
		const pending = Promise.withResolvers<string>();
		this.#pendingPrompt = pending;
		this.#state.prompt = {
			message: prompt.message,
			placeholder: prompt.placeholder ?? null,
			value: "",
			masked,
		};
		this.#requestRender();
		return pending.promise;
	}
}

function printablePromptInput(data: string): string {
	const withoutPasteEnvelope = data.replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", "");
	if (withoutPasteEnvelope.includes("\x1b")) return "";
	return Array.from(withoutPasteEnvelope)
		.filter(ch => {
			const code = ch.codePointAt(0);
			return code !== undefined && code >= 32 && code !== 0x7f;
		})
		.join("");
}

export function listAuthGatewayLoginProviders(): OAuthProviderInfo[] {
	return getOAuthProviders();
}

export async function uploadAcquiredAuthGatewayCredential(
	options: AuthGatewayAccountLoginOptions,
): Promise<AuthGatewayAccountLoginResult> {
	let acquired: AcquiredAuthCredential | null = null;
	const controller = options.controller ?? emptyOAuthController();
	try {
		acquired = options.acquire
			? await options.acquire(controller)
			: await acquireAuthCredential(options.provider, controller);
		if (controller.signal?.aborted) return { ok: false, message: "Account login cancelled", credentials: [] };
		if (!acquired) return { ok: false, message: "Account login cancelled", credentials: [] };
		const upload =
			options.upload ??
			((provider, credential, signal) => options.client.uploadCredential(provider, credential, signal));
		const credentials = await upload(acquired.provider, acquired.credential, controller.signal);
		return { ok: true, message: "Credential uploaded", credentials };
	} catch {
		return { ok: false, message: "Credential upload failed; run account login again", credentials: [] };
	} finally {
		acquired = null;
	}
}

function emptyOAuthController(): OAuthController {
	const controller = new AbortController();
	return {
		signal: controller.signal,
		onAuth: () => {},
		onPrompt: async () => "",
		onManualCodeInput: async () => "",
	};
}
