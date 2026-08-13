import { type Component, Container, Text } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { type CouncilRunStats, loadCouncilAdjudications, summarizeCouncilRun } from "../../council/stats";
import { CouncilStorage, CouncilStorageError, councilArtifactUrl } from "../../council/storage";
import type { CustomMessage } from "../../session/messages";
import type { ToolSession } from "../../tools";
import { replaceTabs, shortenEmbeddedPaths } from "../../tools/render-utils";
import { theme } from "../theme/theme";
import { renderCouncilStatsHeader } from "./council-stats";

/**
 * Durable council run-lifecycle event.
 *
 * One immutable message per event, keyed `{ runId, eventKind, round? }` by the coordinator. The
 * session journal is append-only (`SessionManager` has no update counterpart to
 * `appendCustomMessageEntry`), so a run's story is a sequence of small cards rather than one card
 * that grows. Persisted content is plain, width-independent text plus a JSON `details` payload;
 * nothing ANSI-styled or width-baked reaches the session file or Main's context.
 *
 * Every field is `unknown`: this decodes a persisted payload written by some earlier build, so it
 * is validated at use, never trusted. The producer-side shape lives in `council/events.ts`.
 */
export interface CouncilRunEventDetails {
	runId?: unknown;
	eventKind?: unknown;
	round?: unknown;
	manifestUrl?: unknown;
	/** `summarizeCouncilRun` projection, persisted only on the `terminal` event. */
	stats?: unknown;
}

const MAX_IMMEDIATE_CHARS = 600;
const MAX_ERROR_CHARS = 180;

/**
 * Re-derive the terminal projection from the durable manifest.
 *
 * The persisted `details.stats` is a point-in-time snapshot; a run that is later resumed and
 * re-settled would leave it stale, so the live transcript re-reads the manifest and recomputes.
 */
export type CouncilRunStatsLoader = (
	details: CouncilRunEventDetails | undefined,
	signal: AbortSignal,
) => Promise<CouncilRunStats>;

type HydrationState =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "ready"; stats: CouncilRunStats }
	| { kind: "error"; message: string };

class CouncilRunEventLoadError extends Error {
	constructor(readonly kind: "metadata" | "foreign") {
		super(kind);
	}
}

function bounded(value: string, max: number): string {
	const sanitized = shortenEmbeddedPaths(replaceTabs(sanitizeText(value)));
	if (sanitized.length <= max) return sanitized;
	return `${sanitized.slice(0, Math.max(0, max - 1))}…`;
}

function displayContent(message: CustomMessage<CouncilRunEventDetails>): string {
	if (typeof message.content === "string") return bounded(message.content, MAX_IMMEDIATE_CHARS);
	const text = message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map(part => part.text)
		.join("");
	return bounded(text, MAX_IMMEDIATE_CHARS);
}

function hydrationError(error: unknown): string {
	if (error instanceof CouncilRunEventLoadError) {
		return error.kind === "foreign"
			? "Council run manifest link is foreign."
			: "Council run event metadata is malformed.";
	}
	if (error instanceof CouncilStorageError) {
		if (error.code === "COUNCIL_RUN_NOT_FOUND") return "Council manifest is missing.";
		if (error.message.includes("does not match active session")) {
			return "Council manifest belongs to a different session.";
		}
	}
	return "Council run details are unavailable.";
}

/** The persisted projection, accepted only when it still looks like a `CouncilRunStats`. */
function persistedStats(details: CouncilRunEventDetails | undefined): CouncilRunStats | undefined {
	const candidate = details?.stats;
	if (!candidate || typeof candidate !== "object") return undefined;
	const stats = candidate as Partial<CouncilRunStats>;
	if (typeof stats.runId !== "string" || typeof stats.state !== "string") return undefined;
	if (!Array.isArray(stats.roles) || !Array.isArray(stats.warnings)) return undefined;
	return candidate as CouncilRunStats;
}

/** Build a stats loader pinned to the session that rendered the message. */
export function createCouncilRunStatsLoader(
	session: Pick<ToolSession, "localProtocolOptions" | "sessionManager">,
): CouncilRunStatsLoader {
	return async (details, signal) => {
		if (signal.aborted) throw signal.reason;
		const runId = typeof details?.runId === "string" && details.runId.length > 0 ? details.runId : undefined;
		const manifestUrl =
			typeof details?.manifestUrl === "string" && details.manifestUrl.length > 0 ? details.manifestUrl : undefined;
		if (!runId || !manifestUrl) throw new CouncilRunEventLoadError("metadata");
		let expectedUrl: string;
		try {
			expectedUrl = councilArtifactUrl(runId, "manifest.json");
		} catch (error) {
			if (error instanceof CouncilStorageError && error.code === "COUNCIL_ARTIFACT_INVALID") {
				throw new CouncilRunEventLoadError("metadata");
			}
			throw error;
		}
		if (manifestUrl !== expectedUrl) throw new CouncilRunEventLoadError("foreign");
		const storage = new CouncilStorage(session);
		const manifest = await storage.load(runId);
		if (signal.aborted) throw signal.reason;
		const load = await loadCouncilAdjudications(storage, manifest);
		if (signal.aborted) throw signal.reason;
		return summarizeCouncilRun(manifest, load.adjudications, { adjudicationsUnreadable: load.unreadable });
	};
}

/**
 * Width-aware stats block.
 *
 * The projection is data, not rows: `renderCouncilStatsHeader` runs at render time against the live
 * frame width, so a resized terminal re-lays the table instead of replaying columns that were baked
 * when the run settled.
 */
class CouncilRunStatsRows implements Component {
	#stats: CouncilRunStats;
	#width = -1;
	#rows: readonly string[] = [];

	constructor(stats: CouncilRunStats) {
		this.#stats = stats;
	}

	render(width: number): readonly string[] {
		if (width === this.#width) return this.#rows;
		this.#width = width;
		this.#rows = renderCouncilStatsHeader(this.#stats, Math.max(1, width - 2)).map(row => ` ${row}`);
		return this.#rows;
	}
}

/** Immediate lifecycle line, plus the re-derived stats table on the run's terminal event. */
export class CouncilRunEventComponent extends Container implements Component {
	#generation = 0;
	#abort: AbortController | undefined;
	#state: HydrationState = { kind: "idle" };
	#disposed = false;

	constructor(
		private readonly message: CustomMessage<CouncilRunEventDetails>,
		private readonly loader: CouncilRunStatsLoader | undefined,
		private readonly requestRender: () => void,
	) {
		super();
		this.#rebuild();
		if (this.#isTerminalEvent() && this.loader) this.hydrate();
	}

	/** Starts a new generation; exposed so session rebuilds can invalidate an older load. */
	hydrate(): void {
		const loader = this.loader;
		if (!loader || !this.#isTerminalEvent()) return;
		const generation = ++this.#generation;
		this.#abort?.abort();
		const abort = new AbortController();
		this.#abort = abort;
		this.#state = { kind: "loading" };
		this.#rebuild();
		void loader(this.message.details, abort.signal).then(
			stats => {
				if (this.#disposed || generation !== this.#generation || abort.signal.aborted) return;
				this.#state = { kind: "ready", stats };
				this.#rebuild();
				this.requestRender();
			},
			error => {
				if (this.#disposed || generation !== this.#generation || abort.signal.aborted) return;
				this.#state = { kind: "error", message: bounded(hydrationError(error), MAX_ERROR_CHARS) };
				this.#rebuild();
				this.requestRender();
			},
		);
	}

	override dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#generation++;
		this.#abort?.abort();
		this.#abort = undefined;
		super.dispose();
	}

	#isTerminalEvent(): boolean {
		return this.message.details?.eventKind === "terminal";
	}

	#rebuild(): void {
		this.clear();
		const line = new Text(theme.fg("muted", displayContent(this.message)), 1, 0);
		line.setIgnoreTight(true);
		this.addChild(line);
		if (!this.#isTerminalEvent()) return;
		// Live re-derivation wins; the persisted projection is the fallback that keeps a rebuilt or
		// artifact-less transcript from showing an empty terminal card.
		const stats = this.#state.kind === "ready" ? this.#state.stats : persistedStats(this.message.details);
		if (stats) this.addChild(new CouncilRunStatsRows(stats));
		if (!stats && this.#state.kind === "error") {
			this.addChild(new Text(theme.fg("warning", this.#state.message), 1, 0));
		}
	}
}
