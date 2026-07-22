import { type OAuthAccountSummary, PROVIDER_REGISTRY } from "@oh-my-pi/pi-ai";
import type { ExtensionFactory } from "./extensibility/extensions";

const AUTOMATIC = "Automatic (ranked / round-robin)";

function providerDisplayName(provider: string): string {
	const name = PROVIDER_REGISTRY.find(candidate => candidate.id === provider)?.name;
	return name && name !== provider ? `${name} (${provider})` : provider;
}

function accountDisplayName(account: OAuthAccountSummary): string {
	const identity = account.email ?? account.accountId ?? account.projectId ?? account.enterpriseUrl;
	return identity ? `${account.position + 1}. ${identity}` : `${account.position + 1}. Account`;
}

export const createProviderAccountSelectorExtension: ExtensionFactory = api => {
	api.registerCommand("provider", {
		description: "Pin this session and its subagents to an exact provider account",
		async handler(args, ctx): Promise<void> {
			const modelProviders = new Set(ctx.models.list().map(model => model.provider));
			const availableProviders = ctx.authStorage
				.listOAuthProviderIds()
				.filter(provider => modelProviders.has(provider));
			if (availableProviders.length === 0) {
				ctx.ui.notify("No selectable OAuth provider accounts are configured", "warning");
				return;
			}

			const [providerArg, accountArg] = args.trim().split(/\s+/, 2);
			let provider = providerArg || undefined;
			if (provider && !availableProviders.includes(provider)) {
				ctx.ui.notify(`Provider "${provider}" has no selectable OAuth accounts`, "error");
				return;
			}
			if (!provider) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Usage: /provider <provider-id> <account-number|auto>", "error");
					return;
				}
				if (availableProviders.length === 1) {
					provider = availableProviders[0];
				} else {
					const labels = availableProviders.map(providerDisplayName);
					const selected = await ctx.ui.select("Select provider", labels);
					if (!selected) return;
					provider = availableProviders[labels.indexOf(selected)];
				}
			}
			if (!provider) return;

			const accounts = ctx.authStorage.listOAuthAccounts(provider);
			let position: number | undefined;
			if (accountArg) {
				if (accountArg.toLowerCase() === "auto") {
					position = -1;
				} else {
					const parsed = Number(accountArg);
					if (!Number.isInteger(parsed) || parsed < 1 || parsed > accounts.length) {
						ctx.ui.notify(`Account must be a number from 1 to ${accounts.length}, or "auto"`, "error");
						return;
					}
					position = parsed - 1;
				}
			} else {
				if (!ctx.hasUI) {
					ctx.ui.notify(`Usage: /provider ${provider} <account-number|auto>`, "error");
					return;
				}
				const labels = accounts.map(accountDisplayName);
				const selected = await ctx.ui.select(`Select ${providerDisplayName(provider)} account`, [
					AUTOMATIC,
					...labels,
				]);
				if (!selected) return;
				position = selected === AUTOMATIC ? -1 : labels.indexOf(selected);
			}

			if (position === -1) {
				ctx.authStorage.clearSessionOAuthAccountPin(provider, ctx.providerSessionId);
				ctx.ui.setStatus("provider-account", undefined);
				ctx.ui.notify(`${providerDisplayName(provider)} account selection is automatic`, "info");
				return;
			}
			if (
				position === undefined ||
				!ctx.authStorage.pinSessionOAuthAccount(provider, ctx.providerSessionId, position)
			) {
				ctx.ui.notify("The selected account is no longer available", "error");
				return;
			}
			const label = accountDisplayName(accounts[position]);
			ctx.ui.setStatus("provider-account", `${provider}: ${label.replace(/^\d+\. /, "")}`);
			ctx.ui.notify(`${providerDisplayName(provider)} pinned to ${label}`, "info");
		},
	});
};
