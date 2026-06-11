import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

describe("ExtensionAPI.setLabel", () => {
	test("sets extension labels during registration and routes entry labels through runtime", async () => {
		const runtime = new ExtensionRuntime();
		let capturedApi: ExtensionAPI | undefined;

		const extension = await loadExtensionFromFactory(
			api => {
				capturedApi = api;
				api.setLabel("Localized Extension");
			},
			process.cwd(),
			new EventBus(),
			runtime,
		);

		expect(extension.label).toBe("Localized Extension");

		const updates: Array<[string, string | undefined]> = [];
		runtime.setLabel = (targetId, label) => {
			updates.push([targetId, label]);
		};

		capturedApi?.setLabel("entry-1", "Localized Entry");
		capturedApi?.setLabel("entry-1", undefined);

		expect(updates).toEqual([
			["entry-1", "Localized Entry"],
			["entry-1", undefined],
		]);
	});
});
