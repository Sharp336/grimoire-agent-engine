import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ingestSessionDetail, syncAllSessions } from "@oh-my-pi/omp-stats/aggregator";
import { initDb } from "@oh-my-pi/omp-stats/db";
import { hardRedact, listSessions, listTimeline, reveal, toJsonSafe } from "@oh-my-pi/omp-stats/query";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { handleApi } from "../src/server";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-observability-query-");

const PEM = "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----";

function header(id: string, cwd = "/tmp/project") {
	return { type: "session", version: 3, id, timestamp: "2026-08-13T10:00:00.000Z", cwd, title: id };
}
function custom(id: string, kind: string, data: Record<string, unknown> = {}) {
	return { type: "custom", id, parentId: null, timestamp: "2026-08-13T10:01:00.000Z", customType: "observability", data: { v: 1, kind, ...data } };
}
async function createSession(folder: string, id: string, entries: unknown[]): Promise<string> {
	const dir = path.join(getSessionsDir(), folder);
	await fs.mkdir(dir, { recursive: true });
	const file = path.join(dir, `2026-08-13_${id}.jsonl`);
	await Bun.write(file, `${[header(id), ...entries].map(JSON.stringify).join("\n")}\n`);
	return file;
}

async function api(pathname: string, init?: RequestInit): Promise<Response> {
	return handleApi(new Request(`http://localhost${pathname}`, init));
}

describe("observability query redaction", () => {
	it("hard-redacts nested credential names and credential-shaped strings", () => {
		const value = { nested: { Authorization: "Bearer super-secret", pem: PEM }, completion: { api_key: "key" } };
		const result = hardRedact(value);
		expect(JSON.stringify(result)).not.toContain("super-secret");
		expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
		expect(result).toEqual({
			nested: { Authorization: { redacted: "hard", reason: "credential" }, pem: { redacted: "hard", reason: "credential" } },
			completion: { api_key: { redacted: "hard", reason: "credential" } },
		});
		expect(toJsonSafe(new Error(`Authorization: Bearer hidden ${PEM}`))).toEqual({ redacted: "hard", reason: "credential" });
	});

	it("omits soft bodies, reveals selected fields, keeps credentials hard, and leaves outcomes unknown", async () => {
		await createSession("--project-a", "session-a", [
			custom("assign", "run_assignment", { runId: "run_a" }),
			custom("tool", "segment", { prompt: "say hello", args: { query: "private" }, headers: { authorization: "Bearer abc" }, pem: PEM }),
			{ type: "custom", id: "exit", parentId: null, timestamp: "2026-08-13T10:02:00.000Z", customType: "session_exit", data: { kind: "normal", reason: "quit", recordedAt: "2026-08-13T10:02:00.000Z" } },
		]);
		await syncAllSessions({ workers: 1 });
		const sessions = await listSessions();
		expect(sessions.items[0].softAvailable).toEqual(expect.arrayContaining(["prompt", "args"]));
		expect(sessions.items[0].outcome).toEqual({ execution: "unknown", contract: "unknown", verification: "unknown", humanAcceptance: "unknown" });
		const timeline = await listTimeline({ sessionId: "session-a" });
		expect(JSON.stringify(timeline)).not.toContain("say hello");
		expect(JSON.stringify(timeline)).not.toContain("Bearer abc");
		expect(JSON.stringify(timeline)).toContain('"redacted":"hard"');
		const revealed = await reveal("session", "session-a", ["prompt"]);
		expect(JSON.stringify(revealed)).toContain("say hello");
		expect(JSON.stringify(revealed)).not.toContain("Bearer abc");
	});

	it("uses safe methods, validates limits and cursors, and lists cross-project by default", async () => {
		await createSession("--project-a", "one", []);
		await createSession("--project-b", "two", []);
		expect((await api("/api/sync")).status).toBe(405);
		expect((await api("/api/sync", { method: "POST" })).status).toBe(200);
		for (const query of ["?limit=0", "?limit=101", "?after=x&before=y"]) expect((await api(`/api/sessions${query}`)).status).toBe(400);
		const response = await api("/api/sessions");
		const body = await response.json() as { items: Array<{ sessionId: string }> };
		expect(body.items.map(item => item.sessionId).sort()).toEqual(["one", "two"]);
	});

	it("returns a truncated empty page for a stale generation cursor", async () => {
		const file = await createSession("--project-a", "stale", [custom("one", "segment")]);
		await syncAllSessions({ workers: 1 });
		const first = await listTimeline({ sessionId: "stale", limit: 1 });
		const cursor = Buffer.from(JSON.stringify({ v: 1, kind: "timeline", id: "stale", generation: first!.generation - 1, lastEntryId: "one", lastTimestamp: Date.parse("2026-08-13T10:01:00.000Z"), indexedThrough: first!.indexedThrough })).toString("base64url");
		await fs.appendFile(file, `${JSON.stringify(custom("two", "verification"))}\n`);
		await ingestSessionDetail("stale");
		const page = await listTimeline({ sessionId: "stale", after: cursor });
		expect(page?.truncated).toBe(true);
		expect(page?.items).toEqual([]);
	});

	it("keeps numeric request shim compact and unknown ids private", async () => {
		await initDb();
		expect((await api("/api/request/nope")).status).toBe(404);
		for (const pathName of ["/api/sessions/missing", "/api/runs/missing", "/api/decisions/missing"]) {
			const response = await api(pathName);
			expect(response.status).toBe(404);
			expect(await response.text()).not.toContain("session-a");
		}
	});

	it("looks up decisions by decisionId and timeline exposes only the reference", async () => {
		await createSession("--project-a", "decision-session", [custom("event", "model_request", { decisionId: "decision-1", prompt: "hidden" })]);
		await syncAllSessions({ workers: 1 });
		const database = await initDb();
		database.prepare("INSERT INTO obs_routing_audit (decision_id, kind, timestamp, payload_json) VALUES (?, ?, ?, ?)").run("decision-1", "route", 1, JSON.stringify({ authorization: "Bearer audit", route: "safe" }));
		const decision = await (await api("/api/decisions/decision-1")).json();
		expect(JSON.stringify(decision)).not.toContain("Bearer audit");
		const timeline = await (await api("/api/sessions/decision-session/timeline")).json() as { items: Array<Record<string, unknown>> };
		expect(timeline.items[0].decisionId).toBe("decision-1");
		expect(timeline.items[0]).not.toHaveProperty("decision");
	});
});
