export type ChatGptWebEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ChatGptWebModelRoute {
	readonly key: string;
	readonly slug: `chatgpt-web/${string}`;
	readonly name: string;
	readonly effort: ChatGptWebEffort;
	readonly requiresPro: boolean;
}

export interface ChatGptWebProviderModel {
	readonly id: string;
	readonly name: string;
	readonly reasoning: true;
	readonly thinking: {
		readonly mode: "effort";
		readonly efforts: readonly [ChatGptWebEffort];
		readonly defaultLevel: ChatGptWebEffort;
	};
	readonly contextWindow: 256_000;
	readonly maxTokens: 64_000;
	readonly cost: {
		readonly input: 0;
		readonly output: 0;
		readonly cacheRead: 0;
		readonly cacheWrite: 0;
	};
	readonly input: readonly ["text", "image"];
	readonly supportsTools: boolean;
}

export const CHATGPT_WEB_MODEL_ROUTES = [
	{
		key: "light",
		slug: "chatgpt-web/light",
		name: "ChatGPT Web — Instant",
		effort: "low",
		requiresPro: false,
	},
	{
		key: "medium",
		slug: "chatgpt-web/medium",
		name: "ChatGPT Web — Medium",
		effort: "medium",
		requiresPro: false,
	},
	{
		key: "high",
		slug: "chatgpt-web/high",
		name: "ChatGPT Web — High",
		effort: "high",
		requiresPro: false,
	},
	{
		key: "extra-high",
		slug: "chatgpt-web/extra-high",
		name: "ChatGPT Web — Extra High",
		effort: "xhigh",
		requiresPro: false,
	},
	{
		key: "pro",
		slug: "chatgpt-web/pro",
		name: "ChatGPT Web — Pro",
		effort: "max",
		requiresPro: true,
	},
] as const satisfies readonly ChatGptWebModelRoute[];

const ROUTES_BY_SELECTOR = new Map<string, ChatGptWebModelRoute>(
	CHATGPT_WEB_MODEL_ROUTES.flatMap(route => [
		[route.key, route],
		[route.slug, route],
	]),
);

export function availableChatGptWebModelRoutes(proAvailable: boolean): readonly ChatGptWebModelRoute[] {
	return proAvailable ? CHATGPT_WEB_MODEL_ROUTES : CHATGPT_WEB_MODEL_ROUTES.filter(route => !route.requiresPro);
}

export function requireChatGptWebModelRoute(selector: string, proAvailable: boolean): ChatGptWebModelRoute {
	const route = ROUTES_BY_SELECTOR.get(selector);
	if (!route || (route.requiresPro && !proAvailable)) {
		throw new Error("The requested ChatGPT Web model is unavailable");
	}
	return route;
}

export function createChatGptWebProviderModels(
	proAvailable: boolean,
	fullMode: boolean,
): readonly ChatGptWebProviderModel[] {
	return availableChatGptWebModelRoutes(proAvailable).map(route => ({
		id: route.key,
		name: route.name,
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: [route.effort],
			defaultLevel: route.effort,
		},
		contextWindow: 256_000,
		maxTokens: 64_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		input: ["text", "image"],
		supportsTools: fullMode && !route.requiresPro,
	}));
}
