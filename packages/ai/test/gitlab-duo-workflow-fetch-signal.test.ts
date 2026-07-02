import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { streamGitLabDuoWorkflow } from "../src/providers/gitlab-duo-workflow";
import type { Context, FetchImpl, Model } from "../src/types";

const model: Model<"gitlab-duo-agent"> = buildModel({
	id: "claude_sonnet_4_6_vertex",
	name: "Claude Sonnet 4.6 - Vertex",
	api: "gitlab-duo-agent",
	provider: "gitlab-duo-agent",
	baseUrl: "https://gitlab.example.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
	supportsTools: true,
});

const context: Context = {
	messages: [{ role: "user", content: "Test setup.", timestamp: Date.now() }],
};

describe("GitLab Duo Workflow fetch signal timeout and abort", () => {
	it("rejects a never-resolving fetch after the timeout", async () => {
		const originalTimeout = AbortSignal.timeout;
		let capturedMs: number | undefined;

		AbortSignal.timeout = ms => {
			capturedMs = ms;
			// Return a signal that aborts after 50ms instead of 90,000ms
			return originalTimeout(50);
		};

		try {
			const fetchImpl: FetchImpl = async (input, init) => {
				const url = String(input);
				if (url.includes("/api/v4/groups")) {
					return new Response(JSON.stringify([{ id: "gid://gitlab/Group/1", full_path: "group-path" }]), {
						status: 200,
					});
				}
				if (url.includes("/api/v4/ai/duo_workflows/direct_access")) {
					const { promise, reject } = Promise.withResolvers<Response>();
					if (init?.signal) {
						if (init.signal.aborted) {
							reject(new DOMException("The operation was aborted.", "AbortError"));
						} else {
							init.signal.addEventListener("abort", () => {
								reject(new DOMException("The operation was aborted.", "AbortError"));
							});
						}
					}
					return promise;
				}
				return new Response("{}", { status: 404 });
			};

			const stream = streamGitLabDuoWorkflow(model, context, {
				apiKey: "pat-token",
				rootNamespaceId: "gid://gitlab/Group/1",
				projectId: "123",
				fetch: fetchImpl,
			});

			const result = await stream.result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("The operation was aborted");
			expect(capturedMs).toBe(90000);
		} finally {
			AbortSignal.timeout = originalTimeout;
		}
	});

	it("propagates a caller abort", async () => {
		const caller = new AbortController();
		const fetchImpl: FetchImpl = async (input, init) => {
			const url = String(input);
			if (url.includes("/api/v4/groups")) {
				return new Response(JSON.stringify([{ id: "gid://gitlab/Group/1", full_path: "group-path" }]), {
					status: 200,
				});
			}
			if (url.includes("/api/v4/ai/duo_workflows/direct_access")) {
				// Abort the caller's signal immediately when the fetch is initiated
				caller.abort();

				const { promise, reject } = Promise.withResolvers<Response>();
				if (init?.signal) {
					if (init.signal.aborted) {
						reject(new DOMException("The operation was aborted.", "AbortError"));
					} else {
						init.signal.addEventListener("abort", () => {
							reject(new DOMException("The operation was aborted.", "AbortError"));
						});
					}
				}
				return promise;
			}
			return new Response("{}", { status: 404 });
		};

		const stream = streamGitLabDuoWorkflow(model, context, {
			apiKey: "pat-token",
			rootNamespaceId: "gid://gitlab/Group/1",
			projectId: "123",
			fetch: fetchImpl,
			signal: caller.signal,
		});

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("The operation was aborted");
	});
});
