import { describe, expect, test } from "bun:test";
import { validateRpcCommand } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-command-registry";
import { getRpcV3CapabilityManifest } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-v3";
import { VERSION } from "@oh-my-pi/pi-utils";

describe("RPC v3 semantic negotiation", () => {
	test("validates explicit semantic initialization independently from framing", () => {
		expect(
			validateRpcCommand({
				id: "init-1",
				type: "initialize",
				profile: { name: "omp.session", major: 3, minMinor: 0, maxMinor: 0 },
				framingVersion: 2,
				hostCapabilities: {
					interactions: ["select", "confirm", "input", "editor", "approval"],
					semanticContent: ["markdown", "text", "fields", "table", "tree", "diff", "form", "action"],
				},
				requestedCapabilities: ["session.observe", "artifact.read"],
			}),
		).toMatchObject({ ok: true, scheduling: "serial" });
	});

	test("advertises every capability family and explicit unsupported state", () => {
		const manifest = getRpcV3CapabilityManifest({
			features: new Set(["session-observe", "session-catalog"]),
		});

		expect(manifest.ompVersion).toBe(VERSION);
		expect(manifest.semanticProfiles).toEqual([{ name: "omp.session", major: 3, minMinor: 0, maxMinor: 0 }]);
		expect(manifest.framingVersions).toEqual([1, 2]);
		expect(manifest.limits).toEqual({
			maxFrameBytes: 1_048_576,
			maxReassembledFrameBytes: 67_108_864,
			maxArtifactReadBytes: 65_536,
			maxPendingObservations: 1_024,
			maxIdempotencyKeys: 1_024,
		});
		expect(manifest.recovery).toEqual({
			transportReplay: "bounded",
			durableReplay: "session_journal",
			snapshotHandoff: "watermark",
			acknowledgement: "cumulative",
			gapRecovery: "resnapshot",
			duplicateHandling: "stable_event_id",
		});
		expect(manifest.mutations).toEqual({
			correlation: "request_id",
			concurrency: "expected_revision",
			cancellation: "cooperative",
			terminalOutcomes: ["completed", "cancelled", "failed", "unknown"],
			idempotency: {
				scope: "authority_lifetime",
				retention: "bounded",
				conflict: "reject",
				overflow: "reject",
			},
		});
		expect(manifest.capabilities.map(capability => capability.id)).toEqual([
			"session.catalog",
			"session.observe",
			"session.execute",
			"context.projection",
			"interaction",
			"approval",
			"semantic-rendering",
			"artifact.read",
			"resource.lifecycle",
			"collaboration",
			"runtime-provenance",
			"session.shutdown",
		]);
		expect(manifest.capabilities.find(capability => capability.id === "session.observe")).toMatchObject({
			supported: true,
			operations: ["snapshot", "subscribe", "acknowledge"],
		});
		expect(manifest.capabilities.find(capability => capability.id === "collaboration")).toEqual(
			expect.objectContaining({
				supported: false,
				unsupportedReason: { code: "not_available", message: "Capability is not available in this host" },
			}),
		);
	});

	test("rejects malformed host capability declarations before dispatch", () => {
		expect(
			validateRpcCommand({
				type: "initialize",
				profile: { name: "omp.session", major: 3 },
				framingVersion: 2,
				hostCapabilities: { interactions: ["confirm", 42], semanticContent: [] },
				requestedCapabilities: [],
			}),
		).toMatchObject({ ok: false, code: "invalid_request" });
	});
});
