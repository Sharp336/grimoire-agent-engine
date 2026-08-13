import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as statsAggregator from "@oh-my-pi/omp-stats/aggregator";
import { getSession } from "@oh-my-pi/omp-stats/query";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { InternalUrlRouter } from "../src/internal-urls/router";
import { StatsProtocolHandler } from "../src/internal-urls/stats-protocol";
import { parseInternalUrl } from "../src/internal-urls/parse";
import { installStatsTestIsolation } from "../../stats/test/helpers/temp-agent";

installStatsTestIsolation("@pi-coding-agent-stats-protocol-");

afterEach(() => {
	InternalUrlRouter.resetForTests();
});

function sessionHeader(id: string, cwd: string) {
	return {
		type: "session",
		version: 3,
		id,
		timestamp: "2026-08-13T10:00:00.000Z",
		cwd,
		title: id,
	};
}

async function createSession(project: string, id: string): Promise<void> {
	const slug = project.replace(/^\//, "--").replace(/\//g, "--");
	const dir = path.join(getSessionsDir(), slug);
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(path.join(dir, `2026-08-13_${id}.jsonl`), `${JSON.stringify(sessionHeader(id, project))}\n`);
}

async function seedSessions(fixtures: Array<[project: string, id: string]>): Promise<void> {
	await Promise.all(fixtures.map(([project, id]) => createSession(project, id)));
	await statsAggregator.syncAllSessions({ workers: 1 });
}

describe("stats:// protocol", () => {
	it("returns the same hard-redacted session DTO as the query API", async () => {
		await seedSessions([["/work/pi", "session-a"]]);
		const expected = await getSession("session-a");
		const resource = await new StatsProtocolHandler().resolve(
			parseInternalUrl("stats://sessions/session-a?format=json"),
			{ cwd: "/some/other/project" },
		);
		const actual = JSON.parse(resource.content);

		expect(resource.contentType).toBe("application/json");
		expect(actual).toEqual(expected);
		expect(actual.sessionId).toBe("session-a");
		expect(actual.executionId).toBe("session-a");
		expect(actual.outcome).toEqual({
			execution: "unknown",
			contract: "unknown",
			verification: "unknown",
			humanAcceptance: "unknown",
		});
		expect(actual).not.toHaveProperty("sessionFile");
	});

	it("scopes lists to context.cwd by default and widens only for project=*", async () => {
		await seedSessions([
			["/work/one", "one"],
			["/work/two", "two"],
		]);
		const handler = new StatsProtocolHandler();
		const scoped = await handler.resolve(parseInternalUrl("stats://sessions?format=json"), { cwd: "/work/one" });
		const all = await handler.resolve(parseInternalUrl("stats://sessions?format=json&project=*"), { cwd: "/work/one" });

		expect(JSON.parse(scoped.content).items.map((item: { sessionId: string }) => item.sessionId)).toEqual(["one"]);
		expect(JSON.parse(all.content).items.map((item: { sessionId: string }) => item.sessionId).sort()).toEqual([
			"one",
			"two",
		]);
	});

	it("resolves only through query functions without triggering ingestion or sync", async () => {
		const sync = spyOn(statsAggregator, "syncAllSessions");
		const ingest = spyOn(statsAggregator, "ingestSessionDetail");
		try {
			await new StatsProtocolHandler().resolve(parseInternalUrl("stats://sessions"), { cwd: "/work/pi" });
			expect(sync).not.toHaveBeenCalled();
			expect(ingest).not.toHaveBeenCalled();
		} finally {
			sync.mockRestore();
			ingest.mockRestore();
		}
	});

	it("rejects every reveal form", async () => {
		const handler = new StatsProtocolHandler();
		for (const input of [
			"stats://sessions/session-a/reveal",
			"stats://sessions/session-a?reveal=1",
			"stats://sessions/session-a?reveal=true",
		]) {
			await expect(handler.resolve(parseInternalUrl(input))).rejects.toThrow("does not support reveal");
		}
	});

	it("is registered, immutable, and uses the standard read-only write error", async () => {
		const router = InternalUrlRouter.instance();
		expect(router.canHandle("stats://sessions/x")).toBe(true);
		await expect(router.write("stats://sessions/x", "nope")).rejects.toThrow(
			"stats:// URLs are read-only for write; use the protocol-specific tool for mutations.",
		);
	});

	it("bounds completions at 50 entries", async () => {
		await seedSessions(Array.from({ length: 60 }, (_, index) => ["/work/pi", `session-${index}`]));
		const completions = await new StatsProtocolHandler().complete("", { cwd: "/work/pi" });
		expect(completions.length).toBeLessThanOrEqual(50);
	});
});
