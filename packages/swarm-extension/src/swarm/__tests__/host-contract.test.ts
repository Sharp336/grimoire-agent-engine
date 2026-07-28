import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import swarmExtension from "../../extension";

describe("swarm extension host contract", () => {
	it("fails before partial registration when the executor registry API is absent", () => {
		let labels = 0;
		let commands = 0;
		const pi = {
			setLabel: () => {
				labels += 1;
			},
			registerCommand: () => {
				commands += 1;
			},
		} as unknown as ExtensionAPI;

		expect(() => swarmExtension(pi)).toThrow(
			"@oh-my-pi/swarm-extension requires @oh-my-pi/pi-coding-agent >=17.2.0 <18; this host does not expose ExtensionAPI.getSubagentExecutorRegistry",
		);
		expect(labels).toBe(0);
		expect(commands).toBe(0);
	});

	it("registers normally when the host exposes the executor registry API", () => {
		let label = "";
		let command = "";
		const pi = {
			getSubagentExecutorRegistry: () => ({}),
			setLabel: (value: string) => {
				label = value;
			},
			registerCommand: (name: string) => {
				command = name;
			},
		} as unknown as ExtensionAPI;

		swarmExtension(pi);

		expect(label).toBe("Swarm Orchestrator");
		expect(command).toBe("swarm");
	});
});
