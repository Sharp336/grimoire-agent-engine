import { expect, test } from "bun:test";
import {
	kiroModelManagerOptions,
	PROVIDER_DESCRIPTORS,
	resolveModelCacheProviderId,
} from "@oh-my-pi/pi-catalog/provider-models";

test("lightweight cache resolver matches every descriptor default", () => {
	for (const descriptor of PROVIDER_DESCRIPTORS) {
		const options = descriptor.createModelManagerOptions({});
		expect(resolveModelCacheProviderId(descriptor.providerId)).toBe(options.cacheProviderId ?? descriptor.providerId);
	}
});

test("lightweight cache resolver matches scoped descriptor inputs", () => {
	const cases = [
		{ providerId: "litellm", baseUrl: "http://litellm.example:4100/v1" },
		{ providerId: "opencode-go", baseUrl: "https://opencode.example/go" },
		{ providerId: "opencode-zen", baseUrl: "https://opencode.example/zen/v1/" },
		{ providerId: "vllm", baseUrl: "http://vllm.example:8000/v1" },
	] as const;
	for (const { providerId, baseUrl } of cases) {
		const descriptor = PROVIDER_DESCRIPTORS.find(candidate => candidate.providerId === providerId);
		if (!descriptor) throw new Error(`Missing descriptor for ${providerId}`);
		const config = { apiKey: "cache-test-key", baseUrl };
		const options = descriptor.createModelManagerOptions(config);
		expect(resolveModelCacheProviderId(providerId, config)).toBe(options.cacheProviderId ?? providerId);
	}
});

test("Kiro cache ids follow account identity and the effective management endpoint", () => {
	const profileArn = "arn:aws:codewhisperer:us-east-1:123:profile/account-a";
	const firstCredential = JSON.stringify({ accessToken: "first-token", profileArn });
	const rotatedCredential = JSON.stringify({ accessToken: "rotated-token", profileArn });
	const differentAccount = JSON.stringify({
		accessToken: "other-token",
		profileArn: "arn:aws:codewhisperer:us-east-1:456:profile/account-b",
	});
	const first = resolveModelCacheProviderId("kiro", { apiKey: firstCredential });

	expect(resolveModelCacheProviderId("kiro", { apiKey: rotatedCredential })).toBe(first);
	expect(resolveModelCacheProviderId("kiro", { apiKey: differentAccount })).not.toBe(first);
	expect(resolveModelCacheProviderId("kiro", { apiKey: firstCredential, region: "eu-west-1" })).not.toBe(first);
	expect(
		resolveModelCacheProviderId("kiro", {
			apiKey: firstCredential,
			baseUrl: "https://management.internal.example",
		}),
	).not.toBe(first);
	expect(kiroModelManagerOptions({ apiKey: firstCredential }).cacheProviderId).toBe(first);
});
