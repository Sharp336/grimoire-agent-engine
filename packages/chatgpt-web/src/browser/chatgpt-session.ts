import type { BrowserPage } from "../runtime/host";
import { BrowserContractError } from "../runtime/host";

export const CHATGPT_TEMPORARY_CHAT_TARGET = Object.freeze({ kind: "temporary-chat" } as const);
export type ChatGptWebEffort = "low" | "medium" | "high" | "xhigh" | "max";

const effortLabels: Readonly<Record<ChatGptWebEffort, string>> = Object.freeze({
	low: "Instant",
	medium: "Medium",
	high: "High",
	xhigh: "Extra High",
	max: "Pro",
});

export async function assertAuthenticatedChatGptPage(page: BrowserPage): Promise<void> {
	const health = await page.readHealthSnapshot();
	if (!health.ready) {
		throw new BrowserContractError(health.errorClass ?? "login_required", "browser_not_authenticated");
	}
	const composer = await page.readComposerSnapshot();
	if (!composer.ready) throw new BrowserContractError("login_required", "composer_not_ready");
}

export async function assertTemporaryChatPage(page: BrowserPage): Promise<void> {
	const [state, health] = await Promise.all([page.state(), page.readHealthSnapshot()]);
	if (state !== "temporary-chat" || !health.temporaryChat) {
		throw new BrowserContractError("selector_drift", "temporary_chat_required");
	}
}

export async function selectChatGptEffort(page: BrowserPage, effort: ChatGptWebEffort): Promise<void> {
	const label = effortLabels[effort];
	if (!label) throw new BrowserContractError("unsupported_context", "unsupported_effort");
	const choice = page.locator("reasoning").filter({ key: "reasoning", hasText: label });
	const count = await choice.count();
	if (count !== 1 || !(await choice.isVisible()) || !(await choice.isEnabled())) {
		throw new BrowserContractError("selector_drift", "effort_choice_unavailable");
	}
	await choice.click();
	await page.locator("composer").press("Escape");
}

export function effortForModelKey(modelKey: string): ChatGptWebEffort {
	switch (modelKey) {
		case "light":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		case "extra-high":
			return "xhigh";
		case "pro":
			return "max";
		default:
			throw new BrowserContractError("unsupported_context", "unknown_model_key");
	}
}
