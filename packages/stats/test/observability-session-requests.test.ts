import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { handleApi } from "../src/server";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-session-requests-");

const USAGE = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
};

function header(id: string) {
	return { type: "session", version: 3, id, timestamp: "2026-08-13T10:00:00.000Z", cwd: "/tmp/project", title: "Request session" };
}

async function createSession(id: string, entries: unknown[]): Promise<void> {
	const dir = path.join(getSessionsDir(), "--tmp--requests");
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, `2026-08-13_${id}.jsonl`);
	await Bun.write(file, `${[header(id), ...entries].map(entry => JSON.stringify(entry)).join("\n")}\n`);
}

async function api(pathname: string): Promise<Response> {
	return handleApi(new Request(`http://localhost${pathname}`));
}

describe("session indexed requests", () => {
	it("lists LLM requests, failures, tools, and usage without sessionFile or bodies", async () => {
		await createSession("session-requests", [
			{
				type: "message",
				id: "ok-1",
				timestamp: "2026-08-13T10:01:00.000Z",
				message: {
					role: "assistant",
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-fable-5",
					content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } }],
					usage: USAGE,
					stopReason: "toolUse",
					timestamp: Date.parse("2026-08-13T10:01:00.000Z"),
				},
			},
			{
				type: "message",
				id: "fail-1",
				timestamp: "2026-08-13T10:02:00.000Z",
				message: {
					role: "assistant",
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-fable-5",
					content: [],
					usage: USAGE,
					stopReason: "error",
					errorMessage: "boom",
					timestamp: Date.parse("2026-08-13T10:02:00.000Z"),
				},
			},
		]);
		await syncAllSessions({ workers: 1 });

		const detail = await (await api("/api/sessions/session-requests")).json() as {
			usage: { requests: number; errors: number; tools: number; totalTokens: number; cost: number };
		};
		expect(detail.usage.requests).toBe(2);
		expect(detail.usage.errors).toBe(1);
		expect(detail.usage.tools).toBe(1);
		expect(detail.usage.totalTokens).toBe(60);

		const requests = await (await api("/api/sessions/session-requests/requests")).json() as {
			items: Array<Record<string, unknown>>;
		};
		expect(requests.items).toHaveLength(2);
		expect(JSON.stringify(requests)).not.toContain("sessionFile");
		expect(JSON.stringify(requests)).not.toContain("command");
		expect(requests.items.some(item => item.model === "claude-fable-5")).toBe(true);
		expect(requests.items[0]).toHaveProperty("id");

		const failures = await (await api("/api/sessions/session-requests/requests?errors=true")).json() as {
			items: Array<{ entryId: string }>;
		};
		expect(failures.items.map(item => item.entryId)).toEqual(["fail-1"]);

		const tools = await (await api("/api/sessions/session-requests/tools")).json() as {
			items: Array<{ tool: string; calls: number }>;
		};
		expect(tools.items[0]).toMatchObject({ tool: "bash", calls: 1 });

		const usage = await (await api("/api/sessions/session-requests/usage")).json() as {
			requests: number;
			byModel: Array<{ model: string; requests: number }>;
		};
		expect(usage.requests).toBe(2);
		expect(usage.byModel[0]).toMatchObject({ model: "claude-fable-5", requests: 2 });
	});
});
