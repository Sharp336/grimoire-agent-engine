import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { MAX_ARTIFACT_RANGE_BYTES } from "../../session/artifacts";
import {
	createSessionHostManifest,
	MAX_SESSION_IDEMPOTENCY_KEYS,
	type SessionHostCapabilityDefinition,
	type SessionHostManifest,
} from "../../session/session-host";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES } from "./rpc-frame";

const MAX_RPC_V3_PENDING_OBSERVATIONS = 1_024;

export interface RpcV3CapabilityContext {
	features?: ReadonlySet<string>;
}

function capability(
	context: RpcV3CapabilityContext,
	id: string,
	feature: string,
	operations: readonly string[],
	events: readonly string[],
): SessionHostCapabilityDefinition {
	if (context.features?.has(feature)) {
		return { id, version: 1, supported: true, operations, events, platforms: ["all"] };
	}
	return {
		id,
		version: 1,
		supported: false,
		operations,
		events,
		platforms: ["all"],
		unsupportedReason: { code: "not_available", message: "Capability is not available in this host" },
	};
}

export function getRpcV3CapabilityManifest(context: RpcV3CapabilityContext = {}): SessionHostManifest {
	return createSessionHostManifest({
		ompVersion: VERSION,
		framingVersions: [1, 2],
		limits: {
			maxFrameBytes: MAX_RPC_FRAME_BYTES,
			maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
			maxArtifactReadBytes: MAX_ARTIFACT_RANGE_BYTES,
			maxPendingObservations: MAX_RPC_V3_PENDING_OBSERVATIONS,
			maxIdempotencyKeys: MAX_SESSION_IDEMPOTENCY_KEYS,
		},
		recovery: {
			transportReplay: "bounded",
			durableReplay: "session_journal",
			snapshotHandoff: "watermark",
			acknowledgement: "cumulative",
			gapRecovery: "resnapshot",
			duplicateHandling: "stable_event_id",
		},
		mutations: {
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
		},
		capabilities: [
			capability(
				context,
				"session.catalog",
				"session-catalog",
				["list", "metadata", "tree", "open", "resume", "selectLeaf", "fork", "reset", "branch", "close"],
				["catalogChanged", "sessionStateChanged"],
			),
			capability(
				context,
				"session.observe",
				"session-observe",
				["snapshot", "subscribe", "acknowledge"],
				["observation", "gap"],
			),
			capability(
				context,
				"session.execute",
				"session-execute",
				[
					"prompt",
					"queue",
					"goal",
					"todo",
					"child",
					"checkpoint",
					"rewind",
					"mode",
					"role",
					"compact",
					"retry",
					"toolPolicy",
					"reload",
				],
				["operationAccepted", "operationProgress", "operationSettled"],
			),
			capability(context, "context.projection", "context.projection", ["read"], []),
			capability(
				context,
				"interaction",
				"interaction",
				["respond", "cancel"],
				["select", "confirm", "input", "editor", "notification", "status", "progress", "ask"],
			),
			capability(
				context,
				"ui",
				"ui",
				[
					"open",
					"close",
					"input",
					"editor",
					"autocomplete",
					"presentation",
					"theme",
					"title",
					"toolsExpanded",
					"cancel",
				],
				[
					"channelSettled",
					"editorUpdated",
					"presentationUpdated",
					"presentationRemoved",
					"themeUpdated",
					"titleUpdated",
					"toolsExpandedUpdated",
				],
			),
			capability(context, "approval", "approval", ["respond", "cancel"], ["requested", "settled"]),
			capability(
				context,
				"semantic-rendering",
				"semantic-rendering",
				["render", "act", "cancel"],
				["content", "actionRequested", "actionSettled"],
			),
			capability(context, "artifact.read", "artifact", ["metadata", "readRange", "export"], []),
			capability(
				context,
				"resource.lifecycle",
				"resource-lifecycle",
				["list", "refresh", "reload", "cancel", "dispose"],
				[
					"discovered",
					"connecting",
					"connected",
					"disconnected",
					"authenticationRequired",
					"reconnecting",
					"failed",
					"disabled",
					"diagnostics",
				],
			),
			capability(
				context,
				"collaboration",
				"collaboration",
				["get", "host", "join", "leave", "revoke", "rotate", "acknowledge", "readMedia"],
				["state", "replicated", "gap", "stale"],
			),
			capability(
				context,
				"runtime-provenance",
				"runtime-provenance",
				["snapshot"],
				["usageLimit", "providerFallback", "modelFallback", "credentialRotation", "failure"],
			),
			capability(context, "session.shutdown", "session-shutdown", ["shutdown"], ["draining", "settled"]),
		],
	});
}
