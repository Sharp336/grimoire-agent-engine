import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ServiceTierByFamily } from "@oh-my-pi/pi-ai";
import { Flag } from "@oh-my-pi/pi-ai/error";
import {
	type RpcProvenanceFrame,
	RpcProvenanceManager,
	type RpcProvenanceSource,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-provenance";
import type {
	AgentSessionEvent,
	AgentSessionEventListener,
} from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { TurnRecoverySnapshot } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";

class FakeProvenanceSource implements RpcProvenanceSource {
	model = { provider: "anthropic", id: "claude-sonnet", api: "anthropic-messages" };
	serviceTierByFamily = { openai: "priority", anthropic: undefined, google: undefined } satisfies ServiceTierByFamily;
	messages: AgentMessage[] = [];
	readonly #listeners = new Set<AgentSessionEventListener>();

	getActiveRole(): string {
		return "reviewer";
	}

	getRecoverySnapshot(): TurnRecoverySnapshot {
		return {
			retrying: true,
			attempt: 2,
			fallbackModel: "openai/gpt-5",
			fallback: { role: "reviewer", from: "anthropic/claude-sonnet", to: "openai/gpt-5", pinned: true },
			pendingRecoveredErrors: 1,
			emptyStopRetries: 0,
			unexpectedStopRetries: 0,
			acceptingTerminalEmptyStop: false,
		};
	}

	async fetchUsageReports() {
		return [
			{
				provider: "anthropic" as const,
				fetchedAt: 123,
				limits: [
					{
						id: "five-hour",
						label: "Five hour",
						scope: {
							provider: "anthropic" as const,
							accountId: "acct-secret",
							orgId: "org-secret",
							modelId: "claude-sonnet",
						},
						window: { id: "5h", label: "5 Hour", resetsAt: 456 },
						amount: { usedFraction: 0.75, remainingFraction: 0.25, unit: "percent" as const },
						status: "warning" as const,
						notes: ["Bearer secret-token"],
					},
				],
				metadata: { apiKey: "secret-token" },
				raw: { access_token: "secret-token" },
			},
		];
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of this.#listeners) listener(event);
	}
}

function assistantFailure(errorId: number): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorId,
		errorMessage: "Bearer secret-token failed",
		timestamp: 1,
	};
}

describe("RPC provenance", () => {
	test("projects active role, tier, fallback, and secret-safe usage limits", async () => {
		const source = new FakeProvenanceSource();
		const manager = new RpcProvenanceManager(source, () => {});

		const snapshot = await manager.refresh();
		expect(snapshot).toMatchObject({
			model: {
				active: { provider: "anthropic", id: "claude-sonnet", api: "anthropic-messages" },
				role: "reviewer",
				serviceTiers: { openai: "priority" },
			},
			fallback: { role: "reviewer", from: "anthropic/claude-sonnet", to: "openai/gpt-5", pinned: true },
			usage: {
				available: true,
				reports: [
					{
						provider: "anthropic",
						fetchedAt: 123,
						limits: [
							{
								id: "five-hour",
								modelId: "claude-sonnet",
								amount: { usedFraction: 0.75, remainingFraction: 0.25, unit: "percent" },
							},
						],
					},
				],
			},
		});
		const serialized = JSON.stringify(snapshot);
		expect(serialized).not.toContain("acct-secret");
		expect(serialized).not.toContain("org-secret");
		expect(serialized).not.toContain("secret-token");
	});

	test("reports credential rotation and classifies failures without provider error text", async () => {
		const source = new FakeProvenanceSource();
		source.messages = [assistantFailure(Flag.AuthFailed)];
		const frames: RpcProvenanceFrame[] = [];
		const manager = new RpcProvenanceManager(source, frame => frames.push(frame));

		expect(manager.snapshot()).toMatchObject({
			failure: { category: "authentication", nextAction: "authenticate_provider" },
		});
		source.emit({
			type: "credential_rotated",
			provider: "anthropic",
			model: "claude-sonnet",
			reason: "usage_limit",
		});

		expect(manager.snapshot().credentialRotation).toEqual({
			provider: "anthropic",
			model: "claude-sonnet",
			reason: "usage_limit",
		});
		expect(frames.at(-1)).toMatchObject({
			type: "provenance_update",
			provenance: { credentialRotation: { provider: "anthropic" } },
		});
		expect(JSON.stringify(manager.snapshot())).not.toContain("secret-token");
		manager.dispose();
	});
});
