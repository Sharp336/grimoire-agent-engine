import { bedrockControlPlaneBaseUrl, createBedrockControlPlaneFetch } from "../providers/bedrock-control-plane";
import { resolveAwsProfile, resolveAwsRegion } from "../utils/aws-profile";
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
	// allowSkipAuth keeps the provider listed when AWS_BEDROCK_SKIP_AUTH is set
	// without readable shared AWS config (#8267).
	envKeys: () => resolveAwsRegistryApiKey({ allowSkipAuth: true }),
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
		// Honor explicit discovery region/profile when ModelRegistry (or tests)
		// threads them; otherwise fall back to ambient AWS env/shared-config.
		const profile = config.profile || resolveAwsProfile();
		const region = resolveAwsRegion(config.region, profile);
		if (!bearerToken && !hasAwsCredentialSource()) {
			return { ...config, apiKey: undefined, authenticated: false, region, profile };
		}
		return {
			authenticated: true,
			region,
			profile,
			baseUrl: bedrockControlPlaneBaseUrl(region),
			fetch: createBedrockControlPlaneFetch({
				region,
				profile,
				fetch: config.fetch,
				apiKey: config.apiKey,
				bearerToken,
			}),
		};
	},
} as const satisfies ProviderDefinition;
