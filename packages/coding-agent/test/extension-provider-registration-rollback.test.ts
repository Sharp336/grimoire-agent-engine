import { describe, expect, test } from "bun:test";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { ProviderConfig } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

const testProviderConfig: ProviderConfig = {
	baseUrl: "https://example.invalid/v1",
	apiKey: "TEST_PROVIDER_API_KEY",
	api: "openai-completions",
	models: [
		{
			id: "test-model",
			name: "Test Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 16_384,
			maxTokens: 4_096,
		},
	],
};

describe("extension provider registration rollback", () => {
	test("removes provider registrations when inline extension initialization fails", async () => {
		const runtime = new ExtensionRuntime();
		const events = new EventBus();

		await expect(
			loadExtensionFromFactory(
				pi => {
					pi.registerProvider("should-not-survive", testProviderConfig);
					throw new Error("intentional initialization failure");
				},
				process.cwd(),
				events,
				runtime,
				"broken-inline-extension",
			),
		).rejects.toThrow("intentional initialization failure");

		expect(runtime.pendingProviderRegistrations).toEqual([]);
	});

	test("preserves provider registrations from earlier successful extensions", async () => {
		const runtime = new ExtensionRuntime();
		const events = new EventBus();

		await loadExtensionFromFactory(
			pi => {
				pi.registerProvider("working-provider", testProviderConfig);
			},
			process.cwd(),
			events,
			runtime,
			"working-extension",
		);

		await expect(
			loadExtensionFromFactory(
				pi => {
					pi.registerProvider("broken-provider", testProviderConfig);
					throw new Error("second extension failed");
				},
				process.cwd(),
				events,
				runtime,
				"broken-extension",
			),
		).rejects.toThrow("second extension failed");

		expect(runtime.pendingProviderRegistrations.map(r => r.name)).toEqual(["working-provider"]);
	});

	test("keeps provider registrations when extension initialization succeeds", async () => {
		const runtime = new ExtensionRuntime();
		const events = new EventBus();

		await loadExtensionFromFactory(
			pi => {
				pi.registerProvider("provider-one", {
					baseUrl: "https://one.example.invalid/v1",
				});
				pi.registerProvider("provider-two", {
					baseUrl: "https://two.example.invalid/v1",
				});
			},
			process.cwd(),
			events,
			runtime,
			"working-extension",
		);

		expect(runtime.pendingProviderRegistrations.map(r => r.name)).toEqual(["provider-one", "provider-two"]);
	});

	test("rolls back every provider added by the failed extension", async () => {
		const runtime = new ExtensionRuntime();
		const events = new EventBus();

		await expect(
			loadExtensionFromFactory(
				pi => {
					pi.registerProvider("broken-provider-one", testProviderConfig);
					pi.registerProvider("broken-provider-two", testProviderConfig);
					throw new Error("failed after multiple registrations");
				},
				process.cwd(),
				events,
				runtime,
				"broken-multi-provider-extension",
			),
		).rejects.toThrow("failed after multiple registrations");

		expect(runtime.pendingProviderRegistrations).toEqual([]);
	});
});
