import path from "node:path";
import {
	getDecision,
	getRequest,
	getRun,
	getSession,
	listRuns,
	listSessions,
	listTimeline,
} from "@oh-my-pi/omp-stats/query";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

const MAX_COMPLETIONS = 50;
const MAX_BYTES = 50 * 1024;
const MAX_LINES = 3000;

function partsFrom(url: InternalUrl): string[] {
	const host = url.rawHost || url.hostname;
	const pathname = (url.rawPathname ?? url.pathname).replace(/^\/+/, "");
	return [host, ...pathname.split("/")].filter(Boolean).map(segment => {
		try {
			return decodeURIComponent(segment);
		} catch {
			return segment;
		}
	});
}

function wantsJson(url: InternalUrl, parts: string[]): { json: boolean; parts: string[] } {
	if (url.searchParams.get("format") === "json") return { json: true, parts };
	if (parts.at(-1) === "json") return { json: true, parts: parts.slice(0, -1) };
	return { json: false, parts };
}

function projectFromSearch(searchParams: URLSearchParams, context?: ResolveContext): string | undefined {
	if (searchParams.get("project") === "*") return undefined;
	const explicit = searchParams.get("project");
	if (explicit) return explicit;
	const cwd = context?.cwd;
	if (!cwd) return undefined;
	return path.resolve(cwd);
}

function projectFromContext(url: InternalUrl, context?: ResolveContext): string | undefined {
	return projectFromSearch(url.searchParams, context);
}

function markdown(title: string, lines: string[]): string {
	return [`# ${title}`, "", ...lines, ""].join("\n");
}

function boundContent(content: string): { content: string; notes?: string[] } {
	const lines = content.split("\n");
	let next = content;
	const notes: string[] = [];
	if (lines.length > MAX_LINES) {
		next = `${lines.slice(0, MAX_LINES).join("\n")}\n`;
		notes.push(`Truncated to ${MAX_LINES} lines.`);
	}
	if (Buffer.byteLength(next, "utf8") > MAX_BYTES) {
		next = Buffer.from(next, "utf8").subarray(0, MAX_BYTES).toString("utf8");
		notes.push(`Truncated to ${MAX_BYTES} bytes.`);
	}
	return notes.length > 0 ? { content: next, notes } : { content: next };
}

function resource(url: string, content: string, contentType: InternalResource["contentType"], isDirectory = false): InternalResource {
	const bounded = boundContent(content);
	return {
		url,
		content: bounded.content,
		contentType,
		size: Buffer.byteLength(bounded.content, "utf8"),
		...(bounded.notes ? { notes: bounded.notes } : {}),
		...(isDirectory ? { isDirectory: true } : {}),
	};
}

function asJson(url: string, value: unknown): InternalResource {
	return resource(url, `${JSON.stringify(value, null, 2)}\n`, "application/json");
}

export class StatsProtocolHandler implements ProtocolHandler {
	readonly scheme = "stats";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		if (url.searchParams.has("reveal")) {
			throw new Error("stats:// does not support reveal");
		}
		const parsed = wantsJson(url, partsFrom(url));
		const parts = parsed.parts;
		if (parts.includes("reveal")) {
			throw new Error("stats:// does not support reveal");
		}
		const project = projectFromContext(url, context);
		const href = url.href;

		if (parts.length === 0 || (parts.length === 1 && parts[0] === "sessions")) {
			const page = await listSessions({ project });
			if (parsed.json) return asJson(href, page);
			return resource(
				href,
				markdown(
					"Sessions",
					page.items.map(item => `- \`${item.sessionId}\` ${item.status} ${item.title ?? ""}`.trimEnd()),
				),
				"text/markdown",
				true,
			);
		}

		if (parts[0] === "sessions" && parts[1]) {
			const sessionId = parts[1];
			if (parts[2] === "timeline") {
				const page = await listTimeline({ sessionId });
				if (!page) throw new Error(`Unknown session: ${sessionId}`);
				if (parsed.json) return asJson(href, page);
				return resource(
					href,
					markdown(
						`Session ${sessionId} timeline`,
						page.items.map(item => `- ${item.kind} \`${item.entryId}\``),
					),
					"text/markdown",
				);
			}
			if (parts.length > 2) throw new Error(`Unknown stats resource: stats://${parts.join("/")}`);
			const session = await getSession(sessionId);
			if (!session) throw new Error(`Unknown session: ${sessionId}`);
			if (parsed.json) return asJson(href, session);
			return resource(
				href,
				markdown(`Session ${session.sessionId}`, [
					`- executionId: \`${session.executionId}\``,
					`- status: **${session.status}**`,
					`- outcome: ${session.outcome.execution}/${session.outcome.contract}/${session.outcome.verification}/${session.outcome.humanAcceptance}`,
				]),
				"text/markdown",
			);
		}

		if (parts[0] === "runs" && parts.length === 1) {
			const page = await listRuns({ project });
			if (parsed.json) return asJson(href, page);
			return resource(
				href,
				markdown(
					"Runs",
					page.items.map(item => `- \`${item.runId}\` ${item.status}`),
				),
				"text/markdown",
				true,
			);
		}

		if (parts[0] === "runs" && parts[1]) {
			const run = await getRun(parts[1]);
			if (!run) throw new Error(`Unknown run: ${parts[1]}`);
			if (parts[2] === "timeline") {
				const page = await listTimeline({ runId: parts[1] });
				if (!page) throw new Error(`Unknown run: ${parts[1]}`);
				if (parsed.json) return asJson(href, page);
				return resource(href, markdown(`Run ${parts[1]} timeline`, page.items.map(item => `- ${item.kind}`)), "text/markdown");
			}
			if (parts.length > 2) throw new Error(`Unknown stats resource: stats://${parts.join("/")}`);
			if (parsed.json) return asJson(href, run);
			return resource(href, markdown(`Run ${run.runId}`, [`- sessions: ${run.sessionIds.join(", ") || "none"}`]), "text/markdown");
		}

		if (parts[0] === "requests" && parts[1] && parts.length === 2) {
			const request = await getRequest(parts[1]);
			if (!request) throw new Error(`Unknown request: ${parts[1]}`);
			if (parsed.json) return asJson(href, request);
			return resource(href, markdown(`Request ${request.requestId}`, [`- ${request.model} ${request.provider}`]), "text/markdown");
		}

		if (parts[0] === "decisions" && parts[1] && parts.length === 2) {
			const decision = await getDecision(parts[1]);
			if (!decision) throw new Error(`Unknown decision: ${parts[1]}`);
			if (parsed.json) return asJson(href, decision);
			return resource(href, markdown(`Decision ${decision.decisionId}`, [`- ${decision.kind}`]), "text/markdown");
		}

		throw new Error(`Unknown stats resource: stats://${parts.join("/")}`);
	}

	async complete(query = "", context?: ResolveContext): Promise<UrlCompletion[]> {
		const params = new URLSearchParams(query.includes("?") ? query.slice(query.indexOf("?") + 1) : "");
		if (query.includes("project=*")) params.set("project", "*");
		const project = projectFromSearch(params, context);
		const [sessions, runs] = await Promise.all([listSessions({ project, limit: MAX_COMPLETIONS }), listRuns({ project, limit: MAX_COMPLETIONS })]);
		const values = [
			"sessions",
			"runs",
			...sessions.items.map(item => `sessions/${item.sessionId}`),
			...runs.items.map(item => `runs/${item.runId}`),
		];
		return values.slice(0, MAX_COMPLETIONS).map(value => ({ value }));
	}
}
