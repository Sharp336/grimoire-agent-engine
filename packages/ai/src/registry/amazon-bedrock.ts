import { bedrockControlPlaneBaseUrl, createBedrockControlPlaneFetch } from "../providers/bedrock-control-plane";
import { resolveAwsRegion } from "../utils/aws-profile";
import {
	type AwsBedrockProviderOptions,
	hasAwsCredentialSource,
	resolveAwsBearerToken,
	resolveAwsRegistryApiKey,
} from "./aws";
import type { ProviderDefinition } from "./types";

export const amazonBedrockProvider = {
	id: "amazon-bedrock",
	name: "Amazon Bedrock",
	// Amazon Bedrock accepts bearer tokens, IAM keys, profiles, ECS/IRSA credential chains.
	envKeys: resolveAwsRegistryApiKey,
	// IAM/profile auth does not produce a string API key; discovery still runs when
	// `hasAwsCredentialSource()` is true (AUTHENTICATED_SENTINEL from envKeys).
	allowsMissingApiKey: true,
	mapSimpleOptions: options => {
		const awsOptions = options.providerOptions as AwsBedrockProviderOptions | undefined;
		return {
			region: awsOptions?.region,
			profile: awsOptions?.profile,
			bearerToken: awsOptions?.bearerToken,
		};
	},
	prepareModelDiscovery: config => {
		const bearerToken = resolveAwsBearerToken(config.apiKey);
		if (!bearerToken && !hasAwsCredentialSource()) {
			return { ...config, apiKey: undefined, authenticated: false };
		}
		const region = resolveAwsRegion();
		return {
			authenticated: true,
			baseUrl: bedrockControlPlaneBaseUrl(region),
			fetch: createBedrockControlPlaneFetch({
				region,
				fetch: config.fetch,
				apiKey: config.apiKey,
				bearerToken,
			}),
		};
	},
} as const satisfies ProviderDefinition;
