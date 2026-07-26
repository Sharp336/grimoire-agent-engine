import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	SessionMaintenance,
	type SessionMaintenanceHost,
} from "@oh-my-pi/pi-coding-agent/session/session-maintenance";

function model(
	id: string,
	provider: string,
	contextWindow: number,
	remoteCompaction?: Model["remoteCompaction"],
): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 4096,
		remoteCompaction,
	});
}

function maintenance(settings: Settings): SessionMaintenance {
	return new SessionMaintenance({ settings } as SessionMaintenanceHost);
}

describe("native compaction provider isolation", () => {
	it("keeps implicit role and context fallbacks on the current native provider", () => {
		const settings = Settings.isolated();
		const current = model("native-current", "native-provider", 100_000, { enabled: true });
		const genericRole = model("generic-role", "generic-provider", 90_000);
		const nativeFallback = model("native-fallback", "native-provider", 80_000, { enabled: true });
		settings.setModelRole("smol", `${genericRole.provider}/${genericRole.id}`);

		const candidates = maintenance(settings).resolveCompactionModelCandidates(
			current,
			[current, genericRole, nativeFallback],
			undefined,
			true,
			true,
		);

		expect(candidates.map(candidate => `${candidate.provider}/${candidate.id}`)).toEqual([
			"native-provider/native-current",
			"native-provider/native-fallback",
		]);
	});

	it("retains generic implicit fallbacks when provider-native compaction is disabled", () => {
		const settings = Settings.isolated();
		const current = model("native-current", "native-provider", 100_000, { enabled: true });
		const genericRole = model("generic-role", "generic-provider", 90_000);
		settings.setModelRole("smol", `${genericRole.provider}/${genericRole.id}`);

		const candidates = maintenance(settings).resolveCompactionModelCandidates(
			current,
			[current, genericRole],
			undefined,
			false,
			true,
		);

		expect(candidates.map(candidate => `${candidate.provider}/${candidate.id}`)).toEqual([
			"native-provider/native-current",
			"generic-provider/generic-role",
		]);
	});

	it("recognizes V2-only native capability under the effective streaming setting", () => {
		const settings = Settings.isolated();
		const current = model("v2-current", "v2-provider", 100_000, { v2StreamingEnabled: true });
		const genericRole = model("generic-role", "generic-provider", 90_000);
		const nativeFallback = model("v2-fallback", "v2-provider", 80_000, { v2StreamingEnabled: true });
		settings.setModelRole("smol", `${genericRole.provider}/${genericRole.id}`);

		const candidates = maintenance(settings).resolveCompactionModelCandidates(
			current,
			[current, genericRole, nativeFallback],
			undefined,
			true,
			true,
		);

		expect(candidates.map(candidate => `${candidate.provider}/${candidate.id}`)).toEqual([
			"v2-provider/v2-current",
			"v2-provider/v2-fallback",
		]);
	});
});
