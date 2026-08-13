import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import {
	getBehaviorDashboardStats,
	getCostDashboardStats,
	getDashboardStats,
	getModelDashboardStats,
	getOverviewStats,
	getProviderDashboardStats,
	getRecentErrors,
	getRecentRequests,
	getToolDashboardStats,
	getTotalMessageCount,
	ingestSessionDetail,
	syncAllSessions,
} from "./aggregator";
import { decodeEmbeddedClientArchive } from "./embedded-client";
import embeddedClientArchiveTxt from "./embedded-client.generated.txt";
import { getGainDashboardStats } from "./gain-aggregator";
import {
	prepareStatsPort,
	recoverStatsPort,
	STATS_DASHBOARD_HEADER,
	STATS_DASHBOARD_HOSTNAME,
	STATS_DASHBOARD_SECURITY_VERSION,
} from "./port-conflict";
import {
	getDecision,
	getRequest,
	getRequestBySqliteId,
	getResourceUsage,
	getRun,
	getSession,
	hardRedact,
	listEvents,
	listLogs,
	listResourceRequests,
	listResourceTools,
	listRuns,
	listSessions,
	listTimeline,
	ObservabilityQueryError,
	reveal,
	toJsonSafe,
} from "./query";

const EMBEDDED_CLIENT_ARCHIVE = decodeEmbeddedClientArchive(embeddedClientArchiveTxt);

const CLIENT_DIR = path.join(import.meta.dir, "client");
const STATIC_DIR = path.join(import.meta.dir, "..", "dist", "client");
const IS_BUN_COMPILED =
	Boolean(process.env.PI_COMPILED || Bun.env.PI_COMPILED) ||
	import.meta.url.includes("$bunfs") ||
	import.meta.url.includes("~BUN") ||
	import.meta.url.includes("%7EBUN");
// The prepacked npm bundle (coding-agent dist/cli.js) constant-folds
// process.env.PI_BUNDLED at build time. Like compiled binaries, it ships no
// dashboard sources or prebuilt dist/client next to the bundle, so the
// embedded archive is the only viable asset source.
const IS_PREBUILT = IS_BUN_COMPILED || Boolean(process.env.PI_BUNDLED || Bun.env.PI_BUNDLED);
const USE_EMBEDDED_CLIENT = EMBEDDED_CLIENT_ARCHIVE !== null || IS_PREBUILT;

const EMBEDDED_CLIENT_DIR_ROOT = path.join(os.tmpdir(), "omp-stats-client");
let embeddedClientDirPromise: Promise<string> | null = null;

function sanitizeArchivePath(archivePath: string): string | null {
	const normalized = archivePath.replaceAll("\\", "/").replace(/^\.\//, "");
	if (!normalized || normalized === ".") return null;
	if (normalized.includes("..") || path.isAbsolute(normalized)) return null;
	return normalized;
}

async function extractEmbeddedClientArchive(archiveBytes: Buffer, outputDir: string): Promise<void> {
	const archive = new Bun.Archive(archiveBytes);
	const files = await archive.files();
	const extractRoot = path.resolve(outputDir);

	for (const [archivePath, file] of files) {
		const sanitizedPath = sanitizeArchivePath(archivePath);
		if (!sanitizedPath) continue;
		const destinationPath = path.resolve(extractRoot, sanitizedPath);
		if (!destinationPath.startsWith(extractRoot + path.sep)) {
			throw new Error(`Archive entry escapes extraction directory: ${archivePath}`);
		}
		await Bun.write(destinationPath, file);
	}
}

async function getEmbeddedClientDir(): Promise<string> {
	if (!USE_EMBEDDED_CLIENT) return STATIC_DIR;
	if (embeddedClientDirPromise) return embeddedClientDirPromise;

	if (!EMBEDDED_CLIENT_ARCHIVE) {
		throw new Error(
			"Embedded stats client bundle missing. Rebuild the omp binary or npm bundle with embedded stats assets.",
		);
	}

	embeddedClientDirPromise = (async () => {
		const bundleHash = Bun.hash(EMBEDDED_CLIENT_ARCHIVE).toString(16);
		const outputDir = path.join(EMBEDDED_CLIENT_DIR_ROOT, bundleHash);
		const markerPath = path.join(outputDir, "index.html");
		try {
			const marker = await fs.stat(markerPath);
			if (marker.isFile()) return outputDir;
		} catch {}

		await fs.rm(outputDir, { recursive: true, force: true });
		await fs.mkdir(outputDir, { recursive: true });
		await extractEmbeddedClientArchive(EMBEDDED_CLIENT_ARCHIVE, outputDir);
		return outputDir;
	})();

	return embeddedClientDirPromise;
}

async function getLatestMtime(dir: string): Promise<number> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (err) {
		// Tolerate missing source trees (e.g. installs without the dashboard
		// sources); the caller falls back to prebuilt assets or a clear build
		// failure instead of crashing on the scan.
		if (isEnoent(err)) return 0;
		throw err;
	}

	const promises = [];
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			promises.push(getLatestMtime(fullPath));
		} else if (entry.isFile()) {
			promises.push(fs.stat(fullPath).then(stats => stats.mtimeMs));
		}
	}

	let latest = 0;
	await Promise.allSettled(promises).then(results => {
		for (const result of results) {
			if (result.status === "fulfilled") {
				latest = Math.max(latest, result.value);
			}
		}
	});
	return latest;
}

const ensureClientBuild = async () => {
	if (USE_EMBEDDED_CLIENT) return;
	const indexPath = path.join(STATIC_DIR, "index.html");
	const cssPath = path.join(STATIC_DIR, "styles.css");
	const clientSourceMtime = await getLatestMtime(CLIENT_DIR);
	const tailwindConfigPath = path.join(import.meta.dir, "..", "tailwind.config.js");
	let tailwindConfigMtime = 0;
	try {
		const tailwindConfigStats = await fs.stat(tailwindConfigPath);
		tailwindConfigMtime = tailwindConfigStats.mtimeMs;
	} catch {}
	const sourceMtime = Math.max(clientSourceMtime, tailwindConfigMtime);
	let shouldBuild = true;
	try {
		const [indexStats, cssStats] = await Promise.all([fs.stat(indexPath), fs.stat(cssPath)]);
		if (
			indexStats.isFile() &&
			cssStats.isFile() &&
			indexStats.mtimeMs >= sourceMtime &&
			cssStats.mtimeMs >= sourceMtime
		) {
			shouldBuild = false;
		}
	} catch {
		shouldBuild = true;
	}

	if (!shouldBuild) return;

	await fs.rm(STATIC_DIR, { recursive: true, force: true });

	console.log("Building stats client...");
	const packageRoot = path.join(import.meta.dir, "..");
	const buildResult = await $`bun run build.ts`.cwd(packageRoot).quiet().nothrow();
	if (buildResult.exitCode !== 0) {
		const output = buildResult.text().trim();
		const details = output ? `\n${output}` : "";
		throw new Error(`Failed to build stats client (exit ${buildResult.exitCode})${details}`);
	}

	const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Usage Statistics</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <div id="root"></div>
    <script src="index.js" type="module"></script>
</body>
</html>`;

	await Bun.write(path.join(STATIC_DIR, "index.html"), indexHtml);
};

function methodNotAllowed(allow: "GET" | "POST"): Response {
	return Response.json({ error: "Method Not Allowed" }, { status: 405, headers: { Allow: allow } });
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
	return Response.json(toJsonSafe(value), init);
}

function parseLimit(url: URL): number | undefined {
	const raw = url.searchParams.get("limit");
	if (raw === null) return undefined;
	if (!/^-?\d+$/.test(raw)) throw new ObservabilityQueryError("limit must be an integer");
	return Number(raw);
}

function pageOptions(url: URL) {
	return {
		limit: parseLimit(url),
		after: url.searchParams.get("after") ?? undefined,
		before: url.searchParams.get("before") ?? undefined,
	};
}

async function requestFields(req: Request): Promise<string[]> {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		throw new ObservabilityQueryError("Invalid JSON body");
	}
	if (!body || typeof body !== "object" || !("fields" in body) || !Array.isArray(body.fields)) {
		throw new ObservabilityQueryError("fields must be an array");
	}
	return body.fields as unknown as string[];
}

/**
 * Handle API requests.
 */
async function handleApiRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;


	if (path.startsWith("/api/stats/") || path === "/api/stats") {
		if (req.method !== "GET") return methodNotAllowed("GET");
	}

	if (path === "/api/sync") {
		if (req.method !== "POST") return methodNotAllowed("POST");
		const result = await syncAllSessions();
		const count = await getTotalMessageCount();
		return jsonResponse({ ...result, totalMessages: count });
	}

	if (path === "/api/sessions") {
		if (req.method !== "GET") return methodNotAllowed("GET");
		return jsonResponse(
			await listSessions({
				...pageOptions(url),
				range: url.searchParams.get("range"),
				status: url.searchParams.get("status"),
				project: url.searchParams.get("project"),
				failure: url.searchParams.get("failure") === "true",
				q: url.searchParams.get("q"),
			}),
		);
	}

	if (path === "/api/runs") {
		if (req.method !== "GET") return methodNotAllowed("GET");
		return jsonResponse(
			await listRuns({
				...pageOptions(url),
				range: url.searchParams.get("range"),
				status: url.searchParams.get("status"),
				project: url.searchParams.get("project"),
				failure: url.searchParams.get("failure") === "true",
				q: url.searchParams.get("q"),
			}),
		);
	}

	const sessionMatch = /^\/api\/sessions\/([^/]+)(?:\/(timeline|events|logs|reveal|requests|tools|usage))?$/.exec(path);
	if (sessionMatch) {
		const sessionId = decodeURIComponent(sessionMatch[1]);
		const child = sessionMatch[2];
		if (child === "reveal") {
			if (req.method !== "POST") return methodNotAllowed("POST");
			const result = await reveal("session", sessionId, await requestFields(req));
			return result ? jsonResponse(result, { headers: { "Cache-Control": "no-store" } }) : new Response("Not Found", { status: 404 });
		}
		if (req.method !== "GET") return methodNotAllowed("GET");
		// Requests/tools/usage read the already-indexed messages table. Ingest
		// stays on timeline/events/logs so a 40MB transcript is not re-parsed
		// just to open the default Requests tab.
		if (child === "timeline" || child === "events" || child === "logs") {
			const ingest = await ingestSessionDetail(sessionId);
			if (!ingest.ok && ingest.reason === "not_found") return new Response("Not Found", { status: 404 });
			if (!ingest.ok && !ingest.snapshot) return new Response("Not Found", { status: 404 });
		}
		if (child === "requests") {
			const result = await listResourceRequests("sessions", sessionId, { ...pageOptions(url), errorsOnly: url.searchParams.get("errors") === "true" });
			return result ? jsonResponse(result) : new Response("Not Found", { status: 404 });
		}
		if (child === "tools") {
			const result = await listResourceTools("sessions", sessionId);
			return result ? jsonResponse(result) : new Response("Not Found", { status: 404 });
		}
		if (child === "usage") {
			const result = await getResourceUsage("sessions", sessionId);
			return result ? jsonResponse(result) : new Response("Not Found", { status: 404 });
		}
		const options = { ...pageOptions(url), sessionId };
		const result = child === "timeline" ? await listTimeline(options) : child === "events" ? await listEvents(options) : child === "logs" ? await listLogs(options) : await getSession(sessionId);
		return result ? jsonResponse(result) : new Response("Not Found", { status: 404 });
	}

	const runMatch = /^\/api\/runs\/([^/]+)(?:\/(timeline|events|logs|reveal|requests|tools|usage))?$/.exec(path);
	if (runMatch) {
		const runId = decodeURIComponent(runMatch[1]);
		const child = runMatch[2];
		if (child === "reveal") {
			if (req.method !== "POST") return methodNotAllowed("POST");
			const result = await reveal("run", runId, await requestFields(req));
			return result ? jsonResponse(result, { headers: { "Cache-Control": "no-store" } }) : new Response("Not Found", { status: 404 });
		}
		if (req.method !== "GET") return methodNotAllowed("GET");
		const before = await getRun(runId);
		if (!before) return new Response("Not Found", { status: 404 });
		if (child === "timeline" || child === "events" || child === "logs") {
			for (const sessionId of before.sessionIds) await ingestSessionDetail(sessionId);
		}
		if (child === "requests") {
			const result = await listResourceRequests("runs", runId, { ...pageOptions(url), errorsOnly: url.searchParams.get("errors") === "true" });
			return result ? jsonResponse(result) : new Response("Not Found", { status: 404 });
		}
		if (child === "tools") {
			const result = await listResourceTools("runs", runId);
			return result ? jsonResponse(result) : new Response("Not Found", { status: 404 });
		}
		if (child === "usage") {
			const result = await getResourceUsage("runs", runId);
			return result ? jsonResponse(result) : new Response("Not Found", { status: 404 });
		}
		const options = { ...pageOptions(url), runId };
		const result = child === "timeline" ? await listTimeline(options) : child === "events" ? await listEvents(options) : child === "logs" ? await listLogs(options) : await getRun(runId);
		return result ? jsonResponse(result) : new Response("Not Found", { status: 404 });
	}

	const requestMatch = /^\/api\/requests\/([^/]+)$/.exec(path);
	if (requestMatch) {
		if (req.method !== "GET") return methodNotAllowed("GET");
		const result = await getRequest(decodeURIComponent(requestMatch[1]));
		return result ? jsonResponse(result) : new Response("Not Found", { status: 404 });
	}

	const decisionMatch = /^\/api\/decisions\/([^/]+)$/.exec(path);
	if (decisionMatch) {
		if (req.method !== "GET") return methodNotAllowed("GET");
		const result = await getDecision(decodeURIComponent(decisionMatch[1]));
		return result ? jsonResponse(result) : new Response("Not Found", { status: 404 });
	}
	// Stats reads are DB-only; explicit /api/sync does the expensive session scan.
	const range = url.searchParams.get("range");

	if (path === "/api/stats") {
		const stats = await getDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/overview") {
		const stats = await getOverviewStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/model-dashboard") {
		const stats = await getModelDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/costs") {
		const stats = await getCostDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/behavior") {
		const stats = await getBehaviorDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/tools") {
		const stats = await getToolDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/providers") {
		const stats = await getProviderDashboardStats(range);
		return Response.json(stats);
	}

	if (path === "/api/stats/recent") {
		const limit = url.searchParams.get("limit");
		const stats = await getRecentRequests(limit ? parseInt(limit, 10) : undefined);
		return Response.json(stats);
	}

	if (path === "/api/stats/errors") {
		const limit = url.searchParams.get("limit");
		const stats = await getRecentErrors(range, limit ? parseInt(limit, 10) : undefined);
		return Response.json(stats);
	}

	if (path === "/api/stats/models") {
		const stats = await getDashboardStats(range);
		return Response.json(stats.byModel);
	}

	if (path === "/api/stats/folders") {
		const stats = await getDashboardStats(range);
		return Response.json(stats.byFolder);
	}

	if (path === "/api/stats/timeseries") {
		const stats = await getDashboardStats(range);
		return Response.json(stats.timeSeries);
	}

	if (path.startsWith("/api/request/")) {
		if (req.method !== "GET") return methodNotAllowed("GET");
		const id = path.slice("/api/request/".length);
		if (!/^[1-9]\d*$/.test(id)) return new Response("Not Found", { status: 404 });
		const details = await getRequestBySqliteId(Number(id));
		if (!details) return new Response("Not Found", { status: 404 });
		return jsonResponse(details);
	}

	

	if (path === "/api/stats/gain") {
		const project = url.searchParams.get("project");
		const stats = await getGainDashboardStats(range, project);
		return Response.json(stats);
	}

	return new Response("Not Found", { status: 404 });
}

export async function handleApi(req: Request): Promise<Response> {
	try {
		return await handleApiRequest(req);
	} catch (error) {
		if (error instanceof ObservabilityQueryError) return jsonResponse({ error: error.message }, { status: error.status });
		throw error;
	}
}

/**
 * Handle static file requests.
 */
async function handleStatic(requestPath: string): Promise<Response> {
	const staticDir = await getEmbeddedClientDir();
	const filePath = requestPath === "/" ? "/index.html" : requestPath;
	const fullPath = path.join(staticDir, filePath);

	const file = Bun.file(fullPath);
	if (await file.exists()) {
		return new Response(file);
	}

	// SPA fallback
	const index = Bun.file(path.join(staticDir, "index.html"));
	if (await index.exists()) {
		return new Response(index);
	}

	return new Response("Not Found", { status: 404 });
}

function createDashboardServer(port: number) {
	const server = Bun.serve({
		port,
		hostname: STATS_DASHBOARD_HOSTNAME,
		async fetch(req) {
			const url = new URL(req.url);
			const path = url.pathname;

			// The identity header lets another omp session's reuse probe positively
			// recognize this dashboard without allowing cross-origin API reads.
			const dashboardHeaders: Record<string, string> = {
				[STATS_DASHBOARD_HEADER]: STATS_DASHBOARD_SECURITY_VERSION,
			};

			if (req.method === "OPTIONS") {
				return new Response(null, { headers: dashboardHeaders });
			}

			try {
				let response: Response;

				if (path.startsWith("/api/")) {
					response = await handleApi(req);
				} else {
					response = await handleStatic(path);
				}

				// Add the dashboard identity header to all responses.
				const headers = new Headers(response.headers);
				for (const key in dashboardHeaders) {
					headers.set(key, dashboardHeaders[key]);
				}

				return new Response(response.body, {
					status: response.status,
					headers,
				});
			} catch (error) {
				console.error("Server error:", error);
				const redacted = hardRedact(error instanceof Error ? error.message : error);
				return jsonResponse(
					{ error: typeof redacted === "string" ? "Internal error" : redacted },
					{ status: 500, headers: dashboardHeaders },
				);
			}
		},
	});
	return server;
}

/**
 * Start the HTTP server, reusing a live dashboard or reclaiming a stale omp listener.
 */
export async function startServer(port = 3847): Promise<{ hostname: string; port: number; stop: () => void }> {
	await ensureClientBuild();
	const preparation = await prepareStatsPort(port);
	if (preparation === "reuse") {
		return { hostname: STATS_DASHBOARD_HOSTNAME, port, stop: () => {} };
	}

	try {
		const server = createDashboardServer(port);
		return {
			hostname: STATS_DASHBOARD_HOSTNAME,
			port: server.port ?? port,
			stop: () => server.stop(),
		};
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;

		const recovery = await recoverStatsPort(port);
		if (recovery === "reuse") {
			return { hostname: STATS_DASHBOARD_HOSTNAME, port, stop: () => {} };
		}

		try {
			const server = createDashboardServer(port);
			return {
				hostname: STATS_DASHBOARD_HOSTNAME,
				port: server.port ?? port,
				stop: () => server.stop(),
			};
		} catch (retryError) {
			throw new Error(`Failed to start stats dashboard on port ${port} after reclaiming it.`, {
				cause: retryError,
			});
		}
	}
}
