import { createHash } from "node:crypto";
import type { ProviderCallApiFamily, ProviderCallUrlPlan } from "./types";

export type ProviderCallCredentialMechanism = "bearer-api-key" | "oauth-bearer";
export type ProviderCallAuthorityOwner = "dedicated-codex-backend" | "generic-omp-auth-gateway";

export interface ProviderCallOrigin {
	scheme: "https";
	host: string;
	port: 443;
	sni: string;
	hostHeader: string;
	path: { kind: "exact"; value: string };
	query: ReadonlyArray<readonly [name: string, value: string]>;
}

export interface ProviderCallCredentialInterface {
	mechanism: ProviderCallCredentialMechanism;
	environmentVariable: string;
	generationInterface: "providerCallContext.credentialGeneration";
	sourceReference?: string;
}

export interface ProviderCallOriginDescriptorPreimage {
	schema: "terminal-bench/provider-origin-descriptor/v1";
	origin_id: string;
	canonical_origin: string;
	dns_host: string;
	http_host: string;
	physical_api_family: ProviderCallApiFamily;
	port: 443;
	redirect_policy: "error";
	request_path_and_query: string;
	scheme: "https";
	tls_server_name: string;
}

export interface ProviderCallRouteBindingDescriptorPreimage {
	schema: "terminal-bench/provider-route-binding-descriptor/v1";
	canonical_origin: string;
	canonical_tuple_sha256: string;
	config_id: string;
	config_ordinal: number;
	model_selector: string;
	origin_descriptor_sha256: string;
	origin_id: string;
	physical_api_family: ProviderCallApiFamily;
	provider_family: string;
	request_path_and_query: string;
	route_ordinal: number;
	route_role: "primary" | "additional_director_model";
	semantic_api_family: ProviderCallApiFamily;
}

export interface ProviderCallCanonicalDescriptor<T extends object> {
	preimage: T;
	canonicalBytes: number;
	sha256: string;
}

export interface ProviderCallOriginStaticAssignment {
	config_id: string;
	canonical_tuple_sha256: string;
	config_ordinal: number;
	route_ordinal: number;
	route_role: "primary" | "additional_director_model";
	provider_family: string;
	semantic_api_family: ProviderCallApiFamily;
	physical_api_family: ProviderCallApiFamily;
	model_selector: string;
	origin_id: string;
	origin_descriptor_schema: "terminal-bench/provider-origin-descriptor/v1";
	origin_descriptor_canonical_bytes: number;
	origin_descriptor_sha256: string;
	binding_descriptor_schema: "terminal-bench/provider-route-binding-descriptor/v1";
	binding_descriptor_canonical_bytes: number;
	binding_descriptor_sha256: string;
	canonical_origin: string;
	scheme: "https";
	dns_host: string;
	port: 443;
	tls_server_name: string;
	http_host: string;
	request_path_and_query: string;
	redirect_policy: "error";
}

export interface ProviderCallOriginAssignment extends ProviderCallOriginStaticAssignment {
	capability_generation: string;
	credential_generation: string;
	source_release_digest: string;
	restricted_proxy_policy_sha256: string;
	origin_descriptor: ProviderCallOriginDescriptorPreimage;
	route_binding_descriptor: ProviderCallRouteBindingDescriptorPreimage;
}

export type ProviderCallExpectedDynamics = Pick<
	ProviderCallOriginAssignment,
	"capability_generation" | "credential_generation" | "source_release_digest" | "restricted_proxy_policy_sha256"
>;

export type ProviderCallExpectedDynamicsByConfig = Readonly<Record<string, ProviderCallExpectedDynamics>>;

export interface ProviderCallOriginBinding {
	configId: string;
	canonicalTupleSha256: string;
	configOrdinal: number;
	routeOrdinal: number;
	routeRole: "primary" | "additional_director_model";
	apiFamily: ProviderCallApiFamily;
	physicalApiFamily: ProviderCallApiFamily;
	provider: string;
	modelId: string;
	modelSelector: string;
	authorityOwner: ProviderCallAuthorityOwner;
	origin: ProviderCallOrigin;
	credential: ProviderCallCredentialInterface | null;
	originDescriptor: ProviderCallCanonicalDescriptor<ProviderCallOriginDescriptorPreimage>;
	bindingDescriptor: ProviderCallCanonicalDescriptor<ProviderCallRouteBindingDescriptorPreimage>;
	frozenStaticAssignment: ProviderCallOriginStaticAssignment;
}

export interface ProviderCallOriginManifest {
	schema: "terminal-bench/provider-call-origin-manifest/v2";
	status: "frozen-descriptor-projection";
	activation: "none";
	sourceManifestRawSha256: "94f1400f75e63c588f308c6ce716e2ab6b1c8461a17c63bcc095bad6abf69142";
	sourceManifestCanonicalSha256: "cf0c7836da1ae4d496dc72841a44c276adb60a94a64318725776bed2dab67072";
	origins: readonly ProviderCallCanonicalDescriptor<ProviderCallOriginDescriptorPreimage>[];
	routes: readonly ProviderCallOriginBinding[];
	entries: readonly ProviderCallOriginBinding[];
}

type FrozenIdentity = readonly [
	configId: string,
	provider: string,
	apiFamily: ProviderCallApiFamily,
	modelId: string,
	canonicalTupleSha256: string,
];

const FROZEN_IDENTITIES: readonly FrozenIdentity[] = [
	[
		"sol-max-director-gemini37-flash-high-fast-vibe",
		"gpt-proxy",
		"openai-completions",
		"gpt-5.6-sol",
		"sha256:230e3ebfc98d7458d5a1175a358d8d153e9336c4f1cebfcaf2eabf05b17ce39a",
	],
	[
		"gemini37-max-workflowz",
		"google-antigravity",
		"google-gemini-cli",
		"gemini-3.7-flash",
		"sha256:cff42cbdbba55966b70d9acc825a2ec2ba2b9522ca22e00c0b9ad378206a57e4",
	],
	[
		"gemini37-max-compaction-256k",
		"google-antigravity",
		"google-gemini-cli",
		"gemini-3.7-flash",
		"sha256:20d3370290cd40e86cca22b7eeedf3093a033dc64c5d78e4278ce1549b15489c",
	],
	[
		"gemini37-max-compaction-512k",
		"google-antigravity",
		"google-gemini-cli",
		"gemini-3.7-flash",
		"sha256:ced1a76654dc3f9cb13ea996d2b7ea851342cae02a636a29cc557a7d9f792635",
	],
	[
		"gemini37-max-compaction-724k",
		"google-antigravity",
		"google-gemini-cli",
		"gemini-3.7-flash",
		"sha256:766c0a75638cc25d959a9e96c466006aea1e1f9da62b1c828cecc9bce995c8cb",
	],
	[
		"gemini37-max-compaction-full",
		"google-antigravity",
		"google-gemini-cli",
		"gemini-3.7-flash",
		"sha256:5a20eaa9e55905c85c4b688abd4aa23d3a5fa1fa14ba0dc5c40c6bacf86694ce",
	],
	[
		"glm53-max-official-subscription",
		"zhipu-coding-plan",
		"openai-completions",
		"glm-5.3",
		"sha256:b8a14b0ba758d85acecfd9fbdce993d8b0d6ea2d1f1757e1f832bb0f70b0dd6e",
	],
	[
		"deepseek-v4-pro-0813-max-r3",
		"deepseek",
		"openai-completions",
		"deepseek-v4-pro",
		"sha256:e046c29912a178b00c660abd2568b4087baa766781d5c3fc3ffe5c675ed865f9",
	],
	[
		"sol-low",
		"gpt-proxy",
		"openai-completions",
		"gpt-5.6-sol",
		"sha256:8652feb0d2951c93b892599f329a6009f75c6bb0934bbb3e370c6532cc61d1b8",
	],
	[
		"sol-medium",
		"gpt-proxy",
		"openai-completions",
		"gpt-5.6-sol",
		"sha256:a55f6919fbc228abfc99f069098edec80ddb4f304a63c69348a7d61500c0df6f",
	],
	[
		"sol-high",
		"gpt-proxy",
		"openai-completions",
		"gpt-5.6-sol",
		"sha256:31bfd07314272e67799b09062c9640b7763ddf51b8b2f779f42ea9fc0f4ac03f",
	],
	[
		"sol-xhigh",
		"gpt-proxy",
		"openai-completions",
		"gpt-5.6-sol",
		"sha256:490ba0c4579bb43ff84a4745049089bc352d33f573b3758d4012dc4312d4b16e",
	],
	[
		"sol-high-t1",
		"gpt-proxy",
		"openai-completions",
		"gpt-5.6-sol",
		"sha256:06a1f11f41a30111cf2b0b6365ddf0fcd8f084cd45a192b6dfec6197416724f0",
	],
	[
		"sol-high-t2",
		"gpt-proxy",
		"openai-completions",
		"gpt-5.6-sol",
		"sha256:041d7687bdf9658e8092ea4e6ef5587aae42fff6fefeea4818dd0d8347858dcf",
	],
	[
		"sol-high-t3",
		"gpt-proxy",
		"openai-completions",
		"gpt-5.6-sol",
		"sha256:b5378c9e9f7a40a0d95848552068b6fd89b3fadfc52a0c620459dd6bddab1eb5",
	],
	[
		"sol-high-t4",
		"gpt-proxy",
		"openai-completions",
		"gpt-5.6-sol",
		"sha256:13e0ee10b60c88943e394dd2e9239b790cd83df57bd4f13ec948d80137290aff",
	],
	[
		"sol-high-t5",
		"gpt-proxy",
		"openai-completions",
		"gpt-5.6-sol",
		"sha256:e04dcbc5e5000f7bc17efb4039ffe58335e547513f906b846e7fd92d74157d4c",
	],
	[
		"sol-xhigh-t1",
		"gpt-proxy",
		"openai-completions",
		"gpt-5.6-sol",
		"sha256:c8102cb0e0cc334204fe714289949370920cffbe1f5418b731520ff60024c9e7",
	],
	[
		"sol-xhigh-t2",
		"gpt-proxy",
		"openai-completions",
		"gpt-5.6-sol",
		"sha256:4e14a85c9af7d0ec51e1b59bd4c45a98b563efe41e820f9255d339a6f2750ebe",
	],
	[
		"sol-xhigh-t3",
		"gpt-proxy",
		"openai-completions",
		"gpt-5.6-sol",
		"sha256:0eb623afa8003301b0104b987cdfc10d7e4bab838840945c3e2d78b68a8d856e",
	],
	[
		"sol-xhigh-t4",
		"gpt-proxy",
		"openai-completions",
		"gpt-5.6-sol",
		"sha256:aceb75d41d245aea12419bbb5b252454d252d4f2c428a94e772a1f0adab74b55",
	],
	[
		"sol-xhigh-t5",
		"gpt-proxy",
		"openai-completions",
		"gpt-5.6-sol",
		"sha256:4dda355da59d4fc81f2309107456ef1c82cc4bdc8ea99160ecdf1acb80c0be2e",
	],
	[
		"sol-max-t1",
		"gpt-proxy",
		"openai-completions",
		"gpt-5.6-sol",
		"sha256:639fb6f6f3ed76020eb8e89dd74cfc0effdba288441e682b9b5fa314ab4d8048",
	],
	[
		"sol-max-t2",
		"gpt-proxy",
		"openai-completions",
		"gpt-5.6-sol",
		"sha256:0575ac927f0741c729f7b5564044fccfdeea47d7e24e56e3868846f0d7425c77",
	],
	[
		"sol-max-t3",
		"gpt-proxy",
		"openai-completions",
		"gpt-5.6-sol",
		"sha256:4e47c226bc6a5e4e2f29ec5bb1267c5624ebed0c9cf1628b19a83e8798030df3",
	],
	[
		"sol-max-t4",
		"gpt-proxy",
		"openai-completions",
		"gpt-5.6-sol",
		"sha256:cfd02995b8d747d3bdc7ea3f15f0a610c91d68d970f54e373c11b3b876cef9ab",
	],
	[
		"sol-max-t5",
		"gpt-proxy",
		"openai-completions",
		"gpt-5.6-sol",
		"sha256:97b2dd9883a6c330be48f80ae76625dd563a83b7a545611a490c73656428bc66",
	],
	[
		"qwen3.8-max-official-subscription",
		"dashscope",
		"openai-completions",
		"qwen3.8-max",
		"sha256:fd881f9dc4bac9c90424e8d1c0cc66079e31ed518ae25771d0bde3d96a4494cb",
	],
	[
		"grok-4.6-max-official-subscription",
		"xai-oauth",
		"openai-responses",
		"grok-4.6",
		"sha256:090ef7e1c731f0f8ffb3a297995902b0b9ff4f6009ece3eaa768c80e7bfd4718",
	],
	[
		"kimi-k3-high",
		"kimi-code",
		"openai-completions",
		"k3",
		"sha256:f76839c989b96e46b4262277ab0ebf926620190fc2fe8cf834a8a4781c2d4f78",
	],
];

interface ProviderCredentialProjection {
	credential: ProviderCallCredentialInterface | null;
}

type OriginTuple = readonly [
	originId: string,
	canonicalOrigin: string,
	dnsHost: string,
	httpHost: string,
	physicalApiFamily: ProviderCallApiFamily,
	port: 443,
	redirectPolicy: "error",
	requestPathAndQuery: string,
	scheme: "https",
	tlsServerName: string,
	canonicalBytes: number,
	sha256: string,
	authorityOwner: ProviderCallAuthorityOwner,
	provider: string,
];

type RouteTuple = readonly [
	configId: string,
	routeOrdinal: number,
	routeRole: "primary" | "additional_director_model",
	modelSelector: string,
	originId: string,
	canonicalBytes: number,
	sha256: string,
	providerOverride?: string,
	apiFamilyOverride?: ProviderCallApiFamily,
	modelIdOverride?: string,
];

export const PROVIDER_CALL_ORIGIN_STATIC_FIELDS = [
	"config_id",
	"canonical_tuple_sha256",
	"config_ordinal",
	"route_ordinal",
	"route_role",
	"provider_family",
	"semantic_api_family",
	"physical_api_family",
	"model_selector",
	"origin_id",
	"origin_descriptor_schema",
	"origin_descriptor_canonical_bytes",
	"origin_descriptor_sha256",
	"binding_descriptor_schema",
	"binding_descriptor_canonical_bytes",
	"binding_descriptor_sha256",
	"canonical_origin",
	"scheme",
	"dns_host",
	"port",
	"tls_server_name",
	"http_host",
	"request_path_and_query",
	"redirect_policy",
] as const satisfies readonly (keyof ProviderCallOriginStaticAssignment)[];

export const PROVIDER_CALL_ORIGIN_DYNAMIC_FIELDS = [
	"capability_generation",
	"credential_generation",
	"source_release_digest",
	"restricted_proxy_policy_sha256",
] as const satisfies readonly (keyof ProviderCallExpectedDynamics)[];

export const PROVIDER_CALL_ORIGIN_ASSIGNMENT_FIELDS = [
	...PROVIDER_CALL_ORIGIN_STATIC_FIELDS,
	...PROVIDER_CALL_ORIGIN_DYNAMIC_FIELDS,
] as const satisfies readonly (keyof ProviderCallOriginAssignment)[];

const ORIGIN_DESCRIPTOR_FIELDS = [
	"schema",
	"origin_id",
	"canonical_origin",
	"dns_host",
	"http_host",
	"physical_api_family",
	"port",
	"redirect_policy",
	"request_path_and_query",
	"scheme",
	"tls_server_name",
] as const satisfies readonly (keyof ProviderCallOriginDescriptorPreimage)[];

const ROUTE_BINDING_DESCRIPTOR_FIELDS = [
	"schema",
	"canonical_origin",
	"canonical_tuple_sha256",
	"config_id",
	"config_ordinal",
	"model_selector",
	"origin_descriptor_sha256",
	"origin_id",
	"physical_api_family",
	"provider_family",
	"request_path_and_query",
	"route_ordinal",
	"route_role",
	"semantic_api_family",
] as const satisfies readonly (keyof ProviderCallRouteBindingDescriptorPreimage)[];

const ORIGIN_ASSIGNMENT_OBJECT_FIELDS = [
	...PROVIDER_CALL_ORIGIN_ASSIGNMENT_FIELDS,
	"origin_descriptor",
	"route_binding_descriptor",
] as const;

const GENERATION_INTERFACE = "providerCallContext.credentialGeneration" as const;
const CREDENTIALS: Readonly<Record<string, ProviderCredentialProjection>> = {
	"gpt-proxy": { credential: null },
	"google-antigravity": {
		credential: {
			mechanism: "oauth-bearer",
			environmentVariable: "GEMINI_OAUTH_JSON",
			generationInterface: GENERATION_INTERFACE,
		},
	},
	"zhipu-coding-plan": {
		credential: {
			mechanism: "bearer-api-key",
			environmentVariable: "ZHIPU_API_KEY",
			generationInterface: GENERATION_INTERFACE,
		},
	},
	deepseek: {
		credential: {
			mechanism: "bearer-api-key",
			environmentVariable: "DEEPSEEK_API_KEY",
			generationInterface: GENERATION_INTERFACE,
		},
	},
	dashscope: {
		credential: {
			mechanism: "bearer-api-key",
			environmentVariable: "DASHSCOPE_API_KEY",
			generationInterface: GENERATION_INTERFACE,
		},
	},
	"xai-oauth": {
		credential: {
			mechanism: "oauth-bearer",
			environmentVariable: "XAI_OAUTH_TOKEN",
			generationInterface: GENERATION_INTERFACE,
		},
	},
	"kimi-code": {
		credential: {
			mechanism: "bearer-api-key",
			environmentVariable: "KIMI_API_KEY",
			generationInterface: GENERATION_INTERFACE,
			sourceReference: "secretref://v1/keychain/omp-provider/kimi_api_key",
		},
	},
};

const ORIGIN_TUPLES: readonly OriginTuple[] = [
	[
		"api-deepseek-com-443",
		"https://api.deepseek.com:443",
		"api.deepseek.com",
		"api.deepseek.com",
		"openai-completions",
		443,
		"error",
		"/chat/completions",
		"https",
		"api.deepseek.com",
		382,
		"25d82aecf13618fb4a1c0648fa6d2a430b51ae6b1386d0c72265fcc8e2fefbd5",
		"generic-omp-auth-gateway",
		"deepseek",
	],
	[
		"api-kimi-com-443",
		"https://api.kimi.com:443",
		"api.kimi.com",
		"api.kimi.com",
		"openai-completions",
		443,
		"error",
		"/coding/v1/chat/completions",
		"https",
		"api.kimi.com",
		372,
		"32d4b2a28341e27d1a664922475cc0eae68efc894c7f8a71d7dc2d91114f11ca",
		"generic-omp-auth-gateway",
		"kimi-code",
	],
	[
		"api-x-ai-443",
		"https://api.x.ai:443",
		"api.x.ai",
		"api.x.ai",
		"openai-responses",
		443,
		"error",
		"/v1/responses",
		"https",
		"api.x.ai",
		336,
		"c9aa01765bc9a7577bc2e844a00874a20d7ce7f9cc7f3fa2d1c0e7befbc4bb7c",
		"generic-omp-auth-gateway",
		"xai-oauth",
	],
	[
		"chatgpt-com-443",
		"https://chatgpt.com:443",
		"chatgpt.com",
		"chatgpt.com",
		"openai-responses",
		443,
		"error",
		"/backend-api/codex/responses",
		"https",
		"chatgpt.com",
		366,
		"84c83a337af71e78289af41bb4e92c9d550cc1c34d2877fb23fcda241a0064ef",
		"dedicated-codex-backend",
		"gpt-proxy",
	],
	[
		"daily-cloudcode-pa-googleapis-com-443",
		"https://daily-cloudcode-pa.googleapis.com:443",
		"daily-cloudcode-pa.googleapis.com",
		"daily-cloudcode-pa.googleapis.com",
		"google-gemini-cli",
		443,
		"error",
		"/v1internal:streamGenerateContent?alt=sse",
		"https",
		"daily-cloudcode-pa.googleapis.com",
		490,
		"27417159dea77c41963779f56e9ca079bfd2007b8f84bba279ed125dc0152c62",
		"generic-omp-auth-gateway",
		"google-antigravity",
	],
	[
		"daily-cloudcode-pa-sandbox-googleapis-com-443",
		"https://daily-cloudcode-pa.sandbox.googleapis.com:443",
		"daily-cloudcode-pa.sandbox.googleapis.com",
		"daily-cloudcode-pa.sandbox.googleapis.com",
		"google-gemini-cli",
		443,
		"error",
		"/v1internal:streamGenerateContent?alt=sse",
		"https",
		"daily-cloudcode-pa.sandbox.googleapis.com",
		530,
		"5270726f6ea83cf89c6c521f88f702fce7344586c53667cadf4d6cf006e753af",
		"generic-omp-auth-gateway",
		"google-antigravity",
	],
	[
		"dashscope-intl-aliyuncs-com-443",
		"https://dashscope-intl.aliyuncs.com:443",
		"dashscope-intl.aliyuncs.com",
		"dashscope-intl.aliyuncs.com",
		"openai-completions",
		443,
		"error",
		"/compatible-mode/v1/chat/completions",
		"https",
		"dashscope-intl.aliyuncs.com",
		456,
		"f6769ce44f61b019f91b44da55745bcc42fdaa96a67239a05a21fce6df05413d",
		"generic-omp-auth-gateway",
		"dashscope",
	],
	[
		"open-bigmodel-cn-443",
		"https://open.bigmodel.cn:443",
		"open.bigmodel.cn",
		"open.bigmodel.cn",
		"openai-completions",
		443,
		"error",
		"/api/coding/paas/v4/chat/completions",
		"https",
		"open.bigmodel.cn",
		401,
		"f97eb025716d67ce25d636255425a4e561633e82441ef33aa8c0680dc32317c1",
		"generic-omp-auth-gateway",
		"zhipu-coding-plan",
	],
];

const ROUTE_TUPLES: readonly RouteTuple[] = [
	[
		"sol-max-director-gemini37-flash-high-fast-vibe",
		0,
		"primary",
		"gpt-proxy/gpt-5.6-sol:max",
		"chatgpt-com-443",
		668,
		"3f37d1a27def1842aeb4c5b295580f77299600783d78d93ce62ae885b8224871",
	],
	[
		"sol-max-director-gemini37-flash-high-fast-vibe",
		1,
		"additional_director_model",
		"google-antigravity/gemini-3.7-flash:high",
		"daily-cloudcode-pa-sandbox-googleapis-com-443",
		783,
		"2f2fd6e5418657408d8fb02aad70c499e768257acee38a56b4961d35e754e900",
		"google-antigravity",
		"google-gemini-cli",
		"gemini-3.7-flash",
	],
	[
		"gemini37-max-workflowz",
		0,
		"primary",
		"google-antigravity/gemini-3.7-flash:max",
		"daily-cloudcode-pa-googleapis-com-443",
		724,
		"ad980b45f330e77cc6c3f0a5e263a435fd211adae09e36add36af5ad2c0fd700",
	],
	[
		"gemini37-max-compaction-256k",
		0,
		"primary",
		"google-antigravity/gemini-3.7-flash:max",
		"daily-cloudcode-pa-googleapis-com-443",
		730,
		"3ef1967efcf45b4df1d2e93d2de248272d224a4efc198da2a5296934a05c2e74",
	],
	[
		"gemini37-max-compaction-512k",
		0,
		"primary",
		"google-antigravity/gemini-3.7-flash:max",
		"daily-cloudcode-pa-googleapis-com-443",
		730,
		"93f475970af9acf56f4a4304f54a9d9c3e5f688ff974077710964ac8f771c3be",
	],
	[
		"gemini37-max-compaction-724k",
		0,
		"primary",
		"google-antigravity/gemini-3.7-flash:max",
		"daily-cloudcode-pa-googleapis-com-443",
		730,
		"26e6f02bce1dde1a23627b01f818be041cbc393da96058a7e71a3f36ad850a3f",
	],
	[
		"gemini37-max-compaction-full",
		0,
		"primary",
		"google-antigravity/gemini-3.7-flash:max",
		"daily-cloudcode-pa-googleapis-com-443",
		730,
		"6af23ebf3bcf3722926de7ae63b97695913813070069d30226bf10463757dbbe",
	],
	[
		"glm53-max-official-subscription",
		0,
		"primary",
		"zhipu-coding-plan/glm-5.3:max",
		"open-bigmodel-cn-443",
		685,
		"0634c643052d3d542ba59ba6256eb68f35dcb4fe98784045a17e10161e674eb7",
	],
	[
		"deepseek-v4-pro-0813-max-r3",
		0,
		"primary",
		"deepseek/deepseek-v4-pro:max",
		"api-deepseek-com-443",
		652,
		"cfe1baa9fe83a534d200ee200157de67bde9b3f05a372c5d14b4b51f920a82c1",
	],
	[
		"sol-low",
		0,
		"primary",
		"gpt-proxy/gpt-5.6-sol:low",
		"chatgpt-com-443",
		629,
		"49c559a2d97a000c1af2ea69adfdaff3308b243f3662ee0f4f005ac461895de3",
	],
	[
		"sol-medium",
		0,
		"primary",
		"gpt-proxy/gpt-5.6-sol:medium",
		"chatgpt-com-443",
		636,
		"52ed5df7fe344a830274851f12bb89641ef4b1ce4f426d124c3d203041dc9e55",
	],
	[
		"sol-high",
		0,
		"primary",
		"gpt-proxy/gpt-5.6-sol:high",
		"chatgpt-com-443",
		632,
		"8d8c1681d45f23dd3127a41ba95f4b0b1e6b571b0702031283f56ec12a70e08f",
	],
	[
		"sol-xhigh",
		0,
		"primary",
		"gpt-proxy/gpt-5.6-sol:xhigh",
		"chatgpt-com-443",
		634,
		"2910954267c00737dc731493594b5918b2238f05bd177002a071c59f3b338022",
	],
	[
		"sol-high-t1",
		0,
		"primary",
		"gpt-proxy/gpt-5.6-sol:high",
		"chatgpt-com-443",
		635,
		"3e634e35340da2d6b91024be60db5b9fd6df5f0a34d550c6d26ba47d1eac1b14",
	],
	[
		"sol-high-t2",
		0,
		"primary",
		"gpt-proxy/gpt-5.6-sol:high",
		"chatgpt-com-443",
		635,
		"e1f534437c8ac5761d11ece0d16e119127aeca3f83857784d2a5c4ef8dbaada4",
	],
	[
		"sol-high-t3",
		0,
		"primary",
		"gpt-proxy/gpt-5.6-sol:high",
		"chatgpt-com-443",
		635,
		"59be616c3c7d79967d5fe3de15c9861b513d9f58755538c323e991569e706bea",
	],
	[
		"sol-high-t4",
		0,
		"primary",
		"gpt-proxy/gpt-5.6-sol:high",
		"chatgpt-com-443",
		635,
		"49e27d5de19fd37e6ad445fc3ac29b32ab265575251b3f6e7794c8caf9a00a1e",
	],
	[
		"sol-high-t5",
		0,
		"primary",
		"gpt-proxy/gpt-5.6-sol:high",
		"chatgpt-com-443",
		635,
		"dd0d85023f591d3a024d517ae20b777ec4dbde7d50fd3b3cd85b4f182ed81cbc",
	],
	[
		"sol-xhigh-t1",
		0,
		"primary",
		"gpt-proxy/gpt-5.6-sol:xhigh",
		"chatgpt-com-443",
		637,
		"450d19e8ec7c71e6543406598afc740efb5213b248f066edbe5998222bdf46fd",
	],
	[
		"sol-xhigh-t2",
		0,
		"primary",
		"gpt-proxy/gpt-5.6-sol:xhigh",
		"chatgpt-com-443",
		637,
		"6c1d147873681f3453385c5e22cf3350ccb3fc8f652bb85b0c57a5d5c99bd4b9",
	],
	[
		"sol-xhigh-t3",
		0,
		"primary",
		"gpt-proxy/gpt-5.6-sol:xhigh",
		"chatgpt-com-443",
		637,
		"b67776da2c9e9d1f6e22309fec5fb57fbdda17fc0d081e22af18160f6c25474b",
	],
	[
		"sol-xhigh-t4",
		0,
		"primary",
		"gpt-proxy/gpt-5.6-sol:xhigh",
		"chatgpt-com-443",
		637,
		"22649e5e71daaad5bab26de0e86df0c459e3cf7d353a5f4dad3233ca84e0f497",
	],
	[
		"sol-xhigh-t5",
		0,
		"primary",
		"gpt-proxy/gpt-5.6-sol:xhigh",
		"chatgpt-com-443",
		637,
		"78010a54600e1775d820ac5280b591748ba033ebb3ba2d5f9369001b7a5cc2d2",
	],
	[
		"sol-max-t1",
		0,
		"primary",
		"gpt-proxy/gpt-5.6-sol:max",
		"chatgpt-com-443",
		633,
		"1672654bbb6e53e1bd2c3eee29bec5c7289804a7f86b94d746b56224cc017d1d",
	],
	[
		"sol-max-t2",
		0,
		"primary",
		"gpt-proxy/gpt-5.6-sol:max",
		"chatgpt-com-443",
		633,
		"85da4d8fb6e8acd5e9f9d23004e8074eb8b9c68bcf56eb80266febb01e33b663",
	],
	[
		"sol-max-t3",
		0,
		"primary",
		"gpt-proxy/gpt-5.6-sol:max",
		"chatgpt-com-443",
		633,
		"00dadb69179c569af9e28ea441453121a7fbd4dbb477f0915e1744f2eecb90c6",
	],
	[
		"sol-max-t4",
		0,
		"primary",
		"gpt-proxy/gpt-5.6-sol:max",
		"chatgpt-com-443",
		633,
		"d49b2bd25ff95f7d0148d08ccb1f4cafac547b506cb4bb1f4913e392c06cc3e3",
	],
	[
		"sol-max-t5",
		0,
		"primary",
		"gpt-proxy/gpt-5.6-sol:max",
		"chatgpt-com-443",
		633,
		"195df527c89a1edfdfb23aa3ea2694a9f3e95673420cf91e4566d6d5bd34fd7c",
	],
	[
		"qwen3.8-max-official-subscription",
		0,
		"primary",
		"dashscope/qwen3.8-max:max",
		"dashscope-intl-aliyuncs-com-443",
		698,
		"2b3cde61442003543f52b033f3460efc9232d2f662d170203555e67e24a57dde",
	],
	[
		"grok-4.6-max-official-subscription",
		0,
		"primary",
		"xai-oauth/grok-4.6:max",
		"api-x-ai-443",
		631,
		"c786df753c7fd6910aa285aa83d13b2e73bd09400efc12e9d0ffa54ef94c2779",
	],
	[
		"kimi-k3-high",
		0,
		"primary",
		"kimi-code/kimi-k3:high",
		"api-kimi-com-443",
		635,
		"6f7c8d248b522c7b10daa90861befed665e38bf8d92d3deeb42bd8c389bd6eb4",
	],
];

function canonicalize(value: unknown, seen = new Set<object>()): unknown {
	if (value === null || typeof value !== "object") {
		if (
			typeof value === "number" &&
			(!Number.isFinite(value) || !Number.isSafeInteger(value) || Object.is(value, -0))
		) {
			throw new Error("Provider-call descriptor contains a noncanonical number");
		}
		if (
			typeof value === "bigint" ||
			typeof value === "function" ||
			typeof value === "symbol" ||
			value === undefined
		) {
			throw new Error("Provider-call descriptor is not JSON-safe");
		}
		return value;
	}
	if (seen.has(value)) throw new Error("Provider-call descriptor must be acyclic");
	seen.add(value);
	const canonical = Array.isArray(value)
		? value.map(child => canonicalize(child, seen))
		: Object.fromEntries(
				Object.entries(value as Record<string, unknown>)
					.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
					.map(([key, child]) => [key, canonicalize(child, seen)]),
			);
	seen.delete(value);
	return canonical;
}

export function canonicalProviderCallDescriptorBytes(value: object): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(canonicalize(value)));
}

function descriptorSha256(value: object): string {
	return createHash("sha256").update(canonicalProviderCallDescriptorBytes(value)).digest("hex");
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

function splitPathAndQuery(pathAndQuery: string): {
	path: { kind: "exact"; value: string };
	query: ReadonlyArray<readonly [string, string]>;
} {
	const parsed = new URL(pathAndQuery, "https://origin.invalid");
	return {
		path: { kind: "exact", value: parsed.pathname },
		query: [...parsed.searchParams.entries()],
	};
}

const ORIGIN_RECORDS = ORIGIN_TUPLES.map(
	([
		originId,
		canonicalOrigin,
		dnsHost,
		httpHost,
		physicalApiFamily,
		port,
		redirectPolicy,
		requestPathAndQuery,
		scheme,
		tlsServerName,
		canonicalBytes,
		sha256,
		authorityOwner,
		provider,
	]) => {
		const preimage: ProviderCallOriginDescriptorPreimage = {
			schema: "terminal-bench/provider-origin-descriptor/v1",
			origin_id: originId,
			canonical_origin: canonicalOrigin,
			dns_host: dnsHost,
			http_host: httpHost,
			physical_api_family: physicalApiFamily,
			port,
			redirect_policy: redirectPolicy,
			request_path_and_query: requestPathAndQuery,
			scheme,
			tls_server_name: tlsServerName,
		};
		const split = splitPathAndQuery(requestPathAndQuery);
		return deepFreeze({
			descriptor: { preimage, canonicalBytes, sha256 },
			authorityOwner,
			provider,
			origin: {
				scheme,
				host: dnsHost,
				port,
				sni: tlsServerName,
				hostHeader: httpHost,
				...split,
			} satisfies ProviderCallOrigin,
		});
	},
);

const ORIGIN_BY_ID = new Map(ORIGIN_RECORDS.map(record => [record.descriptor.preimage.origin_id, record]));
const IDENTITY_BY_CONFIG = new Map(FROZEN_IDENTITIES.map((identity, index) => [identity[0], { identity, index }]));

const ROUTES = ROUTE_TUPLES.map(
	([
		configId,
		routeOrdinal,
		routeRole,
		modelSelector,
		originId,
		canonicalBytes,
		sha256,
		providerOverride,
		apiFamilyOverride,
		modelIdOverride,
	]) => {
		const frozen = IDENTITY_BY_CONFIG.get(configId);
		if (!frozen) throw new Error(`Provider-call route has unknown config ${configId}`);
		const [, frozenProvider, frozenApiFamily, frozenModelId, canonicalTupleSha256] = frozen.identity;
		const provider = providerOverride ?? frozenProvider;
		const apiFamily = apiFamilyOverride ?? frozenApiFamily;
		const modelId = modelIdOverride ?? frozenModelId;
		const originRecord = ORIGIN_BY_ID.get(originId);
		if (!originRecord) throw new Error(`Provider-call route has unknown origin ${originId}`);
		const originDescriptor = originRecord.descriptor;
		const originPreimage = originDescriptor.preimage;
		const bindingPreimage: ProviderCallRouteBindingDescriptorPreimage = {
			schema: "terminal-bench/provider-route-binding-descriptor/v1",
			canonical_origin: originPreimage.canonical_origin,
			canonical_tuple_sha256: canonicalTupleSha256,
			config_id: configId,
			config_ordinal: frozen.index + 1,
			model_selector: modelSelector,
			origin_descriptor_sha256: originDescriptor.sha256,
			origin_id: originId,
			physical_api_family: originPreimage.physical_api_family,
			provider_family: provider,
			request_path_and_query: originPreimage.request_path_and_query,
			route_ordinal: routeOrdinal,
			route_role: routeRole,
			semantic_api_family: apiFamily,
		};
		const bindingDescriptor = { preimage: bindingPreimage, canonicalBytes, sha256 };
		const frozenStaticAssignment: ProviderCallOriginStaticAssignment = {
			config_id: configId,
			canonical_tuple_sha256: canonicalTupleSha256,
			config_ordinal: frozen.index + 1,
			route_ordinal: routeOrdinal,
			route_role: routeRole,
			provider_family: provider,
			semantic_api_family: apiFamily,
			physical_api_family: originPreimage.physical_api_family,
			model_selector: modelSelector,
			origin_id: originId,
			origin_descriptor_schema: originPreimage.schema,
			origin_descriptor_canonical_bytes: originDescriptor.canonicalBytes,
			origin_descriptor_sha256: originDescriptor.sha256,
			binding_descriptor_schema: bindingPreimage.schema,
			binding_descriptor_canonical_bytes: bindingDescriptor.canonicalBytes,
			binding_descriptor_sha256: bindingDescriptor.sha256,
			canonical_origin: originPreimage.canonical_origin,
			scheme: originPreimage.scheme,
			dns_host: originPreimage.dns_host,
			port: originPreimage.port,
			tls_server_name: originPreimage.tls_server_name,
			http_host: originPreimage.http_host,
			request_path_and_query: originPreimage.request_path_and_query,
			redirect_policy: originPreimage.redirect_policy,
		};
		return deepFreeze({
			configId,
			canonicalTupleSha256,
			configOrdinal: frozen.index + 1,
			routeOrdinal,
			routeRole,
			apiFamily,
			physicalApiFamily: originPreimage.physical_api_family,
			provider,
			modelId,
			modelSelector,
			authorityOwner: originRecord.authorityOwner,
			origin: originRecord.origin,
			credential: CREDENTIALS[provider]?.credential ?? null,
			originDescriptor,
			bindingDescriptor,
			frozenStaticAssignment,
		} satisfies ProviderCallOriginBinding);
	},
);
export const PROVIDER_CALL_ORIGIN_SOURCE_PINS = {
	rawSha256: "94f1400f75e63c588f308c6ce716e2ab6b1c8461a17c63bcc095bad6abf69142",
	canonicalSha256: "cf0c7836da1ae4d496dc72841a44c276adb60a94a64318725776bed2dab67072",
} as const;

export const PROVIDER_CALL_ORIGIN_MANIFEST: ProviderCallOriginManifest = deepFreeze({
	schema: "terminal-bench/provider-call-origin-manifest/v2",
	status: "frozen-descriptor-projection",
	activation: "none",
	sourceManifestRawSha256: PROVIDER_CALL_ORIGIN_SOURCE_PINS.rawSha256,
	sourceManifestCanonicalSha256: PROVIDER_CALL_ORIGIN_SOURCE_PINS.canonicalSha256,
	origins: ORIGIN_RECORDS.map(record => record.descriptor),
	routes: ROUTES,
	entries: ROUTES.filter(route => route.routeOrdinal === 0),
});

export function canonicalProviderCallOriginManifestBytes(manifest: ProviderCallOriginManifest): Uint8Array {
	return canonicalProviderCallDescriptorBytes(manifest);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	const allowed = new Set(keys);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new Error(`${label} contains unknown field: ${key}`);
	}
	for (const key of keys) {
		if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing field: ${key}`);
	}
	if (Object.keys(value).length !== keys.length) throw new Error(`${label} field count mismatch`);
}

function equalCanonical(left: object, right: object): boolean {
	return Buffer.from(canonicalProviderCallDescriptorBytes(left)).equals(canonicalProviderCallDescriptorBytes(right));
}

function validateDescriptor(
	value: unknown,
	keys: readonly string[],
	expected: ProviderCallCanonicalDescriptor<object>,
	label: string,
): void {
	const record = asRecord(value, label);
	assertExactKeys(record, keys, label);
	if (!equalCanonical(record, expected.preimage)) throw new Error(`${label} mismatch against frozen descriptor`);
	if (canonicalProviderCallDescriptorBytes(record).byteLength !== expected.canonicalBytes) {
		throw new Error(`${label} canonical byte count mismatch`);
	}
	if (descriptorSha256(record) !== expected.sha256) throw new Error(`${label} hash mismatch`);
}

export function resolveProviderCallOriginBinding(configId: string, routeOrdinal = 0): ProviderCallOriginBinding {
	const route = PROVIDER_CALL_ORIGIN_MANIFEST.routes.find(
		candidate => candidate.configId === configId && candidate.routeOrdinal === routeOrdinal,
	);
	if (!route) throw new Error(`Provider-call origin manifest has unknown config/route: ${configId}/${routeOrdinal}`);
	return route;
}

export function resolveProviderCallOrigin(configId: string): ProviderCallOriginBinding {
	return resolveProviderCallOriginBinding(configId, 0);
}

export function validateProviderCallOriginAssignment(value: unknown): ProviderCallOriginAssignment {
	const record = asRecord(value, "Provider-call origin assignment");
	assertExactKeys(record, ORIGIN_ASSIGNMENT_OBJECT_FIELDS, "Provider-call origin assignment");
	if (typeof record.config_id !== "string") throw new Error("Provider-call origin assignment config_id type mismatch");
	if (!Number.isSafeInteger(record.route_ordinal) || Object.is(record.route_ordinal, -0)) {
		throw new Error("Provider-call origin assignment route_ordinal is noncanonical");
	}
	const binding = resolveProviderCallOriginBinding(record.config_id, record.route_ordinal as number);
	for (const field of PROVIDER_CALL_ORIGIN_STATIC_FIELDS) {
		if (!Object.is(record[field], binding.frozenStaticAssignment[field])) {
			throw new Error(`Provider-call origin assignment frozen field mismatch: ${field}`);
		}
	}
	if (
		typeof record.capability_generation !== "string" ||
		!/^[a-z0-9][a-z0-9._-]*$/.test(record.capability_generation) ||
		typeof record.credential_generation !== "string" ||
		!/^[a-z0-9][a-z0-9._-]*$/.test(record.credential_generation)
	) {
		throw new Error("Provider-call origin assignment generation format is noncanonical");
	}
	if (
		typeof record.source_release_digest !== "string" ||
		!/^sha256:[0-9a-f]{64}$/.test(record.source_release_digest) ||
		typeof record.restricted_proxy_policy_sha256 !== "string" ||
		!/^sha256:[0-9a-f]{64}$/.test(record.restricted_proxy_policy_sha256)
	) {
		throw new Error("Provider-call origin assignment SHA format is noncanonical");
	}
	validateDescriptor(
		record.origin_descriptor,
		ORIGIN_DESCRIPTOR_FIELDS,
		binding.originDescriptor,
		"Provider-call origin descriptor",
	);
	validateDescriptor(
		record.route_binding_descriptor,
		ROUTE_BINDING_DESCRIPTOR_FIELDS,
		binding.bindingDescriptor,
		"Provider-call route binding descriptor",
	);
	return deepFreeze(value as ProviderCallOriginAssignment);
}

export function assertProviderCallExpectedDynamics(
	assignmentValue: unknown,
	expectedValue: unknown,
): asserts expectedValue is ProviderCallExpectedDynamics {
	const assignment = validateProviderCallOriginAssignment(assignmentValue);
	const expected = asRecord(expectedValue, `Expected provider-call dynamics for ${assignment.config_id}`);
	assertExactKeys(
		expected,
		PROVIDER_CALL_ORIGIN_DYNAMIC_FIELDS,
		`Expected provider-call dynamics for ${assignment.config_id}`,
	);
	for (const field of PROVIDER_CALL_ORIGIN_DYNAMIC_FIELDS) {
		if (!Object.is(expected[field], assignment[field])) {
			throw new Error(`Provider-call backend-owned dynamic mismatch: ${field}`);
		}
	}
}

function assertNoDuplicateJsonKeys(source: string): void {
	if (source.includes("\ufeff") || source.includes("\r") || source.includes("\0")) {
		throw new Error("Provider-call origin assignment contains forbidden bytes");
	}
	let offset = 0;
	const skipWhitespace = (): void => {
		while (/[ \t\n]/.test(source[offset] ?? "")) offset++;
	};
	const parseString = (): string => {
		const start = offset;
		if (source[offset++] !== '"') throw new Error("Expected JSON string");
		while (offset < source.length) {
			const character = source[offset++];
			if (character === "\\") {
				offset++;
				continue;
			}
			if (character === '"') return JSON.parse(source.slice(start, offset)) as string;
		}
		throw new Error("Unterminated JSON string");
	};
	const parseValue = (): void => {
		skipWhitespace();
		const character = source[offset];
		if (character === "{") {
			offset++;
			skipWhitespace();
			const keys = new Set<string>();
			if (source[offset] === "}") {
				offset++;
				return;
			}
			while (true) {
				skipWhitespace();
				const key = parseString();
				if (keys.has(key)) throw new Error(`Duplicate JSON field: ${key}`);
				keys.add(key);
				skipWhitespace();
				if (source[offset++] !== ":") throw new Error("Expected JSON colon");
				parseValue();
				skipWhitespace();
				const delimiter = source[offset++];
				if (delimiter === "}") return;
				if (delimiter !== ",") throw new Error("Expected JSON object delimiter");
			}
		}
		if (character === "[") {
			offset++;
			skipWhitespace();
			if (source[offset] === "]") {
				offset++;
				return;
			}
			while (true) {
				parseValue();
				skipWhitespace();
				const delimiter = source[offset++];
				if (delimiter === "]") return;
				if (delimiter !== ",") throw new Error("Expected JSON array delimiter");
			}
		}
		if (character === '"') {
			parseString();
			return;
		}
		const start = offset;
		while (offset < source.length && !/[ \t\n,\]}]/.test(source[offset] ?? "")) offset++;
		const scalar = source.slice(start, offset);
		if (!/^(?:true|false|null|0|[1-9][0-9]*)$/.test(scalar)) throw new Error("Noncanonical JSON scalar");
	};
	parseValue();
	skipWhitespace();
	if (offset !== source.length) throw new Error("Trailing JSON data");
}

export function parseProviderCallOriginAssignment(source: string): ProviderCallOriginAssignment {
	assertNoDuplicateJsonKeys(source);
	return validateProviderCallOriginAssignment(JSON.parse(source) as unknown);
}

export function providerCallOriginAssignmentsEqual(
	left: ProviderCallOriginAssignment,
	right: ProviderCallOriginAssignment,
): boolean {
	validateProviderCallOriginAssignment(left);
	validateProviderCallOriginAssignment(right);
	return equalCanonical(left, right);
}

function rawProviderPathAndQuery(url: string): { parsed: URL; value: string } {
	const match = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*(\/[^#]*)?$/.exec(url);
	if (!match) throw new Error("Provider-call catalog URL must be an absolute fragment-free URL");
	const value = match[1] ?? "/";
	const parsed = new URL(url);
	if (
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.hash !== "" ||
		value !== `${parsed.pathname}${parsed.search}`
	) {
		throw new Error("Provider-call catalog URL contains non-canonical authority, path, query, or fragment syntax");
	}
	return { parsed, value };
}

export function planProviderCallAssignedUrl(
	assignment: ProviderCallOriginAssignment,
	catalogUrl: string,
	apiFamily: ProviderCallUrlPlan["apiFamily"],
): ProviderCallUrlPlan {
	const validated = validateProviderCallOriginAssignment(assignment);
	const catalog = rawProviderPathAndQuery(catalogUrl);
	if (catalog.value !== validated.request_path_and_query) {
		throw new Error(`Provider-call path/query mismatch for ${validated.config_id}`);
	}
	const url = `${validated.canonical_origin}${catalog.value}`;
	assertProviderCallOrigin(validated, new URL(url), new Headers());
	return { apiFamily, requestPathAndQuery: catalog.value, url };
}

export function planOpenAIProviderCallUrl(
	apiFamily: ProviderCallUrlPlan["apiFamily"],
	catalogBaseUrl: string | undefined,
	assignment: ProviderCallOriginAssignment,
): ProviderCallUrlPlan {
	const baseUrl = (catalogBaseUrl ?? "https://api.openai.com/v1").trim().replace(/\/+$/, "");
	const endpoint = apiFamily === "openai-completions" ? "/chat/completions" : "/responses";
	return planProviderCallAssignedUrl(assignment, `${baseUrl}${endpoint}`, apiFamily);
}

export function applyProviderCallAssignedOrigin(assignment: ProviderCallOriginAssignment, catalogUrl: string): string {
	return planProviderCallAssignedUrl(
		assignment,
		catalogUrl,
		assignment.semantic_api_family as ProviderCallUrlPlan["apiFamily"],
	).url;
}

export function assertProviderCallOrigin(
	assignment: ProviderCallOriginAssignment,
	url: URL,
	headers: Headers,
): ProviderCallOriginBinding {
	const validated = validateProviderCallOriginAssignment(assignment);
	const binding = resolveProviderCallOriginBinding(validated.config_id, validated.route_ordinal);
	const origin = binding.origin;
	const port = url.port ? Number(url.port) : 443;
	if (
		url.protocol !== `${origin.scheme}:` ||
		url.hostname.toLowerCase() !== origin.host ||
		port !== origin.port ||
		url.username !== "" ||
		url.password !== ""
	) {
		throw new Error(`Provider-call origin mismatch for ${binding.configId}`);
	}
	const hostHeader = headers.get("host");
	if (hostHeader !== null && hostHeader.toLowerCase() !== origin.hostHeader) {
		throw new Error(`Provider-call Host header mismatch for ${binding.configId}`);
	}
	const actualPathAndQuery = `${url.pathname}${url.search}`;
	if (actualPathAndQuery !== validated.request_path_and_query || url.hash !== "") {
		throw new Error(`Provider-call path/query mismatch for ${binding.configId}`);
	}
	return binding;
}

export function validateProviderCallOriginManifest(manifest: ProviderCallOriginManifest): {
	configCount: number;
	originCount: number;
	providerCount: number;
	routeCount: number;
} {
	if (
		manifest.schema !== "terminal-bench/provider-call-origin-manifest/v2" ||
		manifest.status !== "frozen-descriptor-projection" ||
		manifest.activation !== "none" ||
		manifest.sourceManifestRawSha256 !== PROVIDER_CALL_ORIGIN_SOURCE_PINS.rawSha256 ||
		manifest.sourceManifestCanonicalSha256 !== PROVIDER_CALL_ORIGIN_SOURCE_PINS.canonicalSha256
	) {
		throw new Error("Provider-call origin manifest metadata mismatch");
	}
	if (manifest.origins.length !== 8 || manifest.routes.length !== 31 || manifest.entries.length !== 30) {
		throw new Error("Provider-call origin manifest cardinality mismatch");
	}
	for (const descriptor of manifest.origins) {
		validateDescriptor(descriptor.preimage, ORIGIN_DESCRIPTOR_FIELDS, descriptor, "Provider-call origin descriptor");
	}
	const seenRoutes = new Set<string>();
	for (const route of manifest.routes) {
		const key = `${route.configId}\0${route.routeOrdinal}`;
		if (seenRoutes.has(key)) throw new Error(`Provider-call origin manifest duplicate route ${key}`);
		seenRoutes.add(key);
		validateDescriptor(
			route.bindingDescriptor.preimage,
			ROUTE_BINDING_DESCRIPTOR_FIELDS,
			route.bindingDescriptor,
			"Provider-call route binding descriptor",
		);
		if (
			route.origin.host !== route.origin.sni ||
			route.origin.host !== route.origin.hostHeader ||
			route.origin.scheme !== "https" ||
			route.origin.port !== 443 ||
			(route.authorityOwner === "dedicated-codex-backend") !== (route.provider === "gpt-proxy") ||
			(route.provider === "gpt-proxy" ? route.credential !== null : route.credential === null)
		) {
			throw new Error(`Provider-call origin route authority mismatch for ${route.configId}`);
		}
	}
	const providerCount = new Set(manifest.routes.map(route => route.provider)).size;
	const configCount = new Set(manifest.routes.map(route => route.configId)).size;
	if (providerCount !== 7 || configCount !== 30)
		throw new Error("Provider-call origin manifest identity count mismatch");
	return { configCount, originCount: manifest.origins.length, providerCount, routeCount: manifest.routes.length };
}

validateProviderCallOriginManifest(PROVIDER_CALL_ORIGIN_MANIFEST);
