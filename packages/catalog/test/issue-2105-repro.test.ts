import { describe, expect, test } from "bun:test";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";

describe("AIML API built-in provider (issue #2105)", () => {
	test("registers built-in runtime descriptor with AIMLAPI_API_KEY discovery", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "aimlapi");

		expect(descriptor).toBeDefined();
		expect(descriptor?.catalogDiscovery?.envVars).toContain("AIMLAPI_API_KEY");
		expect(DEFAULT_MODEL_PER_PROVIDER.aimlapi).toBeDefined();
	});

	test("resolves AIMLAPI_API_KEY via env", () => {
		const previous = Bun.env.AIMLAPI_API_KEY;
		Bun.env.AIMLAPI_API_KEY = "aiml-test-key";
		try {
			expect(getEnvApiKey("aimlapi")).toBe("aiml-test-key");
		} finally {
			if (previous === undefined) {
				delete Bun.env.AIMLAPI_API_KEY;
			} else {
				Bun.env.AIMLAPI_API_KEY = previous;
			}
		}
	});
});
