import { type Component, Container, Text } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { councilRoleLabel } from "../../config/model-roles";
import {
	type CouncilAdjudication,
	type CouncilFindingAdjudication,
	validatePersistedCouncilReport,
} from "../../council/schema";
import type { CouncilManifest } from "../../council/state";
import { loadCouncilAdjudications } from "../../council/stats";
import { CouncilStorage, CouncilStorageError, councilArtifactUrl } from "../../council/storage";
import { hasResolvableTranscript } from "../../internal-urls/registry-helpers";
import type { CustomMessage } from "../../session/messages";
import type { ToolSession } from "../../tools";
import { replaceTabs, shortenEmbeddedPaths } from "../../tools/render-utils";
import { theme } from "../theme/theme";

const MAX_IMMEDIATE_CHARS = 2_400;
const MAX_DETAIL_CHARS = 8_000;
const MAX_ERROR_CHARS = 180;
const MAX_WARNING_ROWS = 5;
/** Findings listed individually; the tail is reported as a count. */
const MAX_FINDING_ROWS = 8;
const MAX_FINDING_TITLE_CHARS = 120;
const MAX_FINDING_REASON_CHARS = 240;
/** Pointer rows (report artifact plus transcript) the card will ever show. */
const MAX_POINTER_ROWS = 8;
/** Reviewer reports opened for finding titles. A report is only read for its display strings. */
const MAX_REPORT_READS = 12;
/** Reserved child ids probed for a live transcript, deduplicated across rounds and attempts. */
const MAX_TRANSCRIPT_PROBES = 32;
/**
 * One delayed retry before the card settles into its error state. A checkpoint is a durable replace:
 * a read that lands mid-rename sees the run as missing for a few milliseconds, which is
 * indistinguishable from a genuinely absent manifest until you look again.
 */
const HYDRATION_RETRY_DELAY_MS = 750;

/**
 * Decoded `details` of a persisted `council-summary` card. Every field is `unknown`: this is a
 * payload some earlier build wrote, so it is validated at use. The producer-side shape lives in
 * `council/events.ts`.
 */
export interface CouncilSummaryDetails {
	runId?: unknown;
	manifestUrl?: unknown;
	/**
	 * The `Final:` value the coordinator already rendered into this card's immediate content —
	 * a `local://` URL, or its one wording for an unpublished run. Present so the hydrated block can
	 * skip re-deriving a second, differently worded copy of the same fact.
	 */
	finalUrl?: unknown;
}

/** Everything the hydrated block renders, gathered off the synchronous render path. */
export interface CouncilSummaryHydration {
	manifest: CouncilManifest;
	/** Main's decisions, keyed by the round that settled them. Empty when none were readable. */
	adjudications?: ReadonlyMap<number, CouncilAdjudication>;
	/**
	 * The adjudication read threw. Distinct from an empty map, which a run with no findings and a
	 * round Main has not judged yet both produce while being perfectly healthy.
	 */
	adjudicationsUnreadable?: boolean;
	/**
	 * Finding id to its one-line `impact`, read from the reviewer reports. Findings carry no title,
	 * so this is the headline the card shows; a missing entry degrades exactly one row.
	 */
	findingSummaries?: ReadonlyMap<string, string>;
	/**
	 * Reserved child ids whose `history://` transcript still resolves. Child refs are released when a
	 * run settles, so a persisted id routinely outlives its transcript and `history://<dead-id>`
	 * throws; only ids in this set are advertised as links.
	 */
	resolvableAgentIds?: ReadonlySet<string>;
}

export type CouncilSummaryManifestLoader = (
	details: CouncilSummaryDetails | undefined,
	signal: AbortSignal,
) => Promise<CouncilSummaryHydration>;

type HydrationState =
	| { kind: "loading" }
	| { kind: "ready"; hydration: CouncilSummaryHydration }
	| { kind: "error"; message: string };

class CouncilSummaryLoadError extends Error {
	constructor(readonly kind: "metadata" | "foreign") {
		super(kind);
	}
}

function bounded(value: string, max: number): string {
	const sanitized = shortenEmbeddedPaths(replaceTabs(sanitizeText(value)));
	if (sanitized.length <= max) return sanitized;
	return `${sanitized.slice(0, Math.max(0, max - 1))}…`;
}

function displayContent(message: CustomMessage<CouncilSummaryDetails>): string {
	if (typeof message.content === "string") return bounded(message.content, MAX_IMMEDIATE_CHARS);
	const text = message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map(part => part.text)
		.join("");
	return bounded(text, MAX_IMMEDIATE_CHARS);
}

function hydrationError(error: unknown, runId: string | undefined): string {
	const reason = ((): string => {
		if (error instanceof CouncilSummaryLoadError) {
			return error.kind === "foreign"
				? "Council summary manifest link is foreign."
				: "Council summary metadata is malformed.";
		}
		if (error instanceof CouncilStorageError) {
			if (error.code === "COUNCIL_RUN_NOT_FOUND") return "Council manifest is missing.";
			if (error.message.includes("does not match active session")) {
				return "Council manifest belongs to a different session.";
			}
			if (error.code === "COUNCIL_RECOVERY_CORRUPT" || error.code === "COUNCIL_ARTIFACT_HASH_MISMATCH") {
				return "Council manifest is corrupt.";
			}
			return "Council manifest is unavailable.";
		}
		return "Council manifest could not be hydrated.";
	})();
	// The run id turns "the manifest is missing" into something the operator can act on: it is the
	// argument to `/council resume` and the stem of every artifact filename on disk.
	return runId ? `${reason} (run ${bounded(runId, 64)})` : reason;
}

function outcomeCounts(manifest: CouncilManifest): string {
	const counts = new Map<string, number>();
	for (const round of manifest.rounds) {
		for (const member of round.members) counts.set(member.status, (counts.get(member.status) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([status, count]) => `${status} ${count}`)
		.join(", ");
}

/**
 * Every finding this run raised, with the role that raised it, its title and how Main disposed of
 * it. Bounded per row and in total: the card is a durable transcript entry, not a report viewer.
 */
function findingRows(hydration: CouncilSummaryHydration): string[] {
	const rows: string[] = [];
	let total = 0;
	for (const round of hydration.manifest.rounds) {
		const judged = new Map<string, CouncilFindingAdjudication>();
		for (const disposition of hydration.adjudications?.get(round.round)?.dispositions ?? []) {
			judged.set(disposition.id, disposition);
		}
		for (const member of round.members) {
			for (const id of member.findingIds) {
				total++;
				if (total > MAX_FINDING_ROWS) continue;
				const decision = judged.get(id);
				const summary = hydration.findingSummaries?.get(id);
				rows.push(
					`  ${bounded(id, 32)} ${bounded(councilRoleLabel(member.role), 48)}: ${
						summary ? bounded(summary, MAX_FINDING_TITLE_CHARS) : "unsummarised finding"
					} -> ${decision ? decision.disposition : "not judged"}`,
				);
				if (decision?.reason) rows.push(`    ${bounded(decision.reason, MAX_FINDING_REASON_CHARS)}`);
			}
		}
	}
	if (total === 0) return [];
	const lines: string[] = [];
	if (hydration.adjudicationsUnreadable === true) {
		lines.push("Dispositions unreadable: findings are listed without Main's decisions.");
	}
	lines.push(`Findings (${total}):`, ...rows);
	if (total > MAX_FINDING_ROWS) lines.push(`  … ${total - MAX_FINDING_ROWS} more`);
	return lines;
}

/**
 * Report artifacts and per-attempt transcripts, one row per role that has either.
 *
 * A `history://` link is only printed for an id the registry can still serve: child refs are
 * released when a run settles, so most persisted ids outlive their transcripts and linking one
 * blind hands the operator a URL that throws.
 */
function pointerRows(hydration: CouncilSummaryHydration): string[] {
	const rows: string[] = [];
	let dropped = 0;
	const add = (label: string, artifactUrl: string | undefined, agentIds: readonly string[] | undefined): void => {
		const segments: string[] = [];
		if (artifactUrl) segments.push(`report ${bounded(artifactUrl, 200)}`);
		const live = (agentIds ?? []).filter(id => hydration.resolvableAgentIds?.has(id) === true);
		if (live.length > 0) segments.push(`transcript ${live.map(id => `history://${bounded(id, 48)}`).join(", ")}`);
		else if ((agentIds ?? []).length > 0) segments.push("transcript unavailable");
		if (segments.length === 0) return;
		if (rows.length >= MAX_POINTER_ROWS) {
			dropped++;
			return;
		}
		rows.push(`  ${bounded(label, 48)}: ${segments.join(" · ")}`);
	};

	add("Planner", undefined, hydration.manifest.planner.agentIds);
	for (const round of hydration.manifest.rounds) {
		for (const member of round.members) {
			add(`${councilRoleLabel(member.role)} r${round.round}`, member.artifact?.url, member.agentIds);
		}
	}
	add("Adjudicator", undefined, hydration.manifest.adjudicator.agentIds);
	if (rows.length === 0) return [];
	if (dropped > 0) rows.push(`  … ${dropped} more`);
	return ["Transcripts:", ...rows];
}

function manifestLines(hydration: CouncilSummaryHydration, details: CouncilSummaryDetails | undefined): string[] {
	const manifest = hydration.manifest;
	const lines = [
		`State: ${manifest.state} · rounds ${manifest.rounds.length} · outcomes ${outcomeCounts(manifest) || "none"}`,
	];
	for (const round of manifest.rounds.slice(0, 12)) {
		const members = round.members
			.map(
				member =>
					`${bounded(councilRoleLabel(member.role), 48)} ${member.status}${member.attempts > 1 ? ` (${member.attempts} attempts)` : ""}`,
			)
			.join(", ");
		lines.push(`Round ${round.round} ${round.status}: ${bounded(members, 600)}`);
	}
	if (manifest.rounds.length > 12) lines.push(`… ${manifest.rounds.length - 12} more rounds`);

	lines.push(...findingRows(hydration));

	const warnings: string[] = [];
	if (manifest.degraded) warnings.push("Run completed with degraded results.");
	if (manifest.failure) warnings.push(`${manifest.failure.phase}: ${manifest.failure.reason}`);
	warnings.push(...manifest.warnings);
	for (const round of manifest.rounds) {
		for (const member of round.members) {
			if (member.failureReason) warnings.push(`${councilRoleLabel(member.role)}: ${member.failureReason}`);
		}
	}
	for (const warning of warnings.slice(0, MAX_WARNING_ROWS)) lines.push(`Warning: ${bounded(warning, 500)}`);
	if (warnings.length > MAX_WARNING_ROWS) lines.push(`… ${warnings.length - MAX_WARNING_ROWS} more warnings`);

	lines.push(...pointerRows(hydration));

	const final = [...manifest.planVersions].reverse().find(version => version.kind === "final");
	if (final) lines.push(`Final artifact: ${final.artifact.url}`);
	else {
		// A run that never published still wrote drafts and per-round revisions. Pointing at the
		// newest one of any kind beats "unavailable" for an interrupted or failed run.
		const latest = [...manifest.planVersions].sort((left, right) => left.version - right.version).at(-1);
		if (latest) lines.push(`Latest ${latest.kind}: ${latest.artifact.url}`);
	}

	// `Final:` and `Manifest:` are already in the immediate, provider-visible content above, rendered
	// by the coordinator from `summary.md`. Re-deriving them produced a second copy of the same fact,
	// worded differently for an unpublished run. Only a card persisted before `details` carried the
	// final URL falls back to deriving it here.
	if (details?.finalUrl === undefined && manifest.published) {
		lines.push(`Final: local://${bounded(manifest.outputPath, 500)}`);
	}
	if (details?.manifestUrl === undefined) {
		lines.push(`Manifest: ${councilArtifactUrl(manifest.runId, "manifest.json")}`);
	}
	return lines;
}

/**
 * A council finding has no `title` field. Its `impact` line is the closest thing to one — the
 * reviewer's own statement of what goes wrong — and it lives in the reviewer's report artifact,
 * not in the adjudication or the manifest.
 */
async function readFindingSummaries(
	storage: CouncilStorage,
	manifest: CouncilManifest,
	signal: AbortSignal,
): Promise<ReadonlyMap<string, string>> {
	const summaries = new Map<string, string>();
	let reads = 0;
	for (const round of manifest.rounds) {
		for (const [memberIndex, member] of round.members.entries()) {
			if (!member.artifact || member.findingIds.length === 0) continue;
			if (reads >= MAX_REPORT_READS || signal.aborted) return summaries;
			reads++;
			try {
				// Same slot arithmetic the storage layer validates reports with, so a report whose
				// deterministic ids do not match its slot is rejected here too rather than mislabelled.
				const report = validatePersistedCouncilReport(
					JSON.parse(await storage.readArtifact(member.artifact)),
					(round.round - 1) * manifest.roster.length + memberIndex,
				);
				for (const finding of report.findings) summaries.set(finding.id, finding.impact);
			} catch {
				// A missing or corrupt report costs that member's summaries, never the card.
			}
		}
	}
	return summaries;
}

async function probeResolvableTranscripts(manifest: CouncilManifest): Promise<ReadonlySet<string>> {
	const candidates = new Set<string>(manifest.planner.agentIds ?? []);
	for (const round of manifest.rounds) {
		for (const member of round.members) {
			for (const id of member.agentIds ?? []) candidates.add(id);
		}
	}
	const probed = await Promise.all(
		[...candidates]
			.slice(0, MAX_TRANSCRIPT_PROBES)
			.map(async id => ({ id, resolvable: await hasResolvableTranscript(id) })),
	);
	return new Set(probed.filter(entry => entry.resolvable).map(entry => entry.id));
}

/** Build a hydration loader pinned to the actual session that rendered the message. */
export function createCouncilSummaryManifestLoader(
	session: Pick<ToolSession, "localProtocolOptions" | "sessionManager">,
): CouncilSummaryManifestLoader {
	return async (details, signal) => {
		if (signal.aborted) throw signal.reason;
		const runId = typeof details?.runId === "string" && details.runId.length > 0 ? details.runId : undefined;
		const manifestUrl =
			typeof details?.manifestUrl === "string" && details.manifestUrl.length > 0 ? details.manifestUrl : undefined;
		if (!runId || !manifestUrl) throw new CouncilSummaryLoadError("metadata");
		let expectedUrl: string;
		try {
			expectedUrl = councilArtifactUrl(runId, "manifest.json");
		} catch (error) {
			if (error instanceof CouncilStorageError && error.code === "COUNCIL_ARTIFACT_INVALID") {
				throw new CouncilSummaryLoadError("metadata");
			}
			throw error;
		}
		if (manifestUrl !== expectedUrl) throw new CouncilSummaryLoadError("foreign");
		const storage = new CouncilStorage(session);
		const manifest = await storage.load(runId);
		if (signal.aborted) throw signal.reason;
		const adjudications = await loadCouncilAdjudications(storage, manifest);
		if (signal.aborted) throw signal.reason;
		const findingSummaries = await readFindingSummaries(storage, manifest, signal);
		if (signal.aborted) throw signal.reason;
		const resolvableAgentIds = await probeResolvableTranscripts(manifest);
		if (signal.aborted) throw signal.reason;
		return {
			manifest,
			adjudications: adjudications.adjudications,
			adjudicationsUnreadable: adjudications.unreadable,
			findingSummaries,
			resolvableAgentIds,
		};
	};
}

function defaultRetrySchedule(retry: () => void): void {
	setTimeout(retry, HYDRATION_RETRY_DELAY_MS).unref?.();
}

/** Immediate provider-context card with generation-safe durable manifest hydration. */
export class CouncilSummaryComponent extends Container implements Component {
	#generation = 0;
	#abort: AbortController | undefined;
	#state: HydrationState = { kind: "loading" };
	#disposed = false;
	#retryUsed = false;

	constructor(
		private readonly message: CustomMessage<CouncilSummaryDetails>,
		private readonly loader: CouncilSummaryManifestLoader,
		private readonly requestRender: () => void,
		/**
		 * Runs the one delayed retry. The default defers by {@link HYDRATION_RETRY_DELAY_MS}; the
		 * timer is unref'd and the callback re-checks disposal, so a card torn down mid-wait is inert.
		 * Tests pass `retry => retry()` to drive the path without a wall clock.
		 */
		private readonly scheduleRetry: (retry: () => void) => void = defaultRetrySchedule,
	) {
		super();
		this.#rebuild();
		this.hydrate();
	}

	/** Starts a new generation; exposed so session rebuilds can invalidate an older load. */
	hydrate(): void {
		this.#retryUsed = false;
		this.#load();
	}

	#load(): void {
		const generation = ++this.#generation;
		this.#abort?.abort();
		const abort = new AbortController();
		this.#abort = abort;
		this.#state = { kind: "loading" };
		this.#rebuild();
		void this.loader(this.message.details, abort.signal).then(
			hydration => {
				if (this.#disposed || generation !== this.#generation || abort.signal.aborted) return;
				this.#state = { kind: "ready", hydration };
				this.#rebuild();
				this.requestRender();
			},
			error => {
				if (this.#disposed || generation !== this.#generation || abort.signal.aborted) return;
				// One retry, then settle. A checkpoint's durable replace makes a mid-rename read look
				// exactly like a missing run, and the card outlives that window by far. A malformed or
				// foreign link is decided by the message's own details and can never change, so it
				// settles immediately rather than paying a second load for the same verdict.
				if (!this.#retryUsed && !(error instanceof CouncilSummaryLoadError)) {
					this.#retryUsed = true;
					this.scheduleRetry(() => {
						if (!this.#disposed && generation === this.#generation) this.#load();
					});
					return;
				}
				const runId = typeof this.message.details?.runId === "string" ? this.message.details.runId : undefined;
				this.#state = { kind: "error", message: bounded(hydrationError(error, runId), MAX_ERROR_CHARS) };
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

	#rebuild(): void {
		this.clear();
		const header = new Text(theme.bold(theme.fg("accent", "Council summary")), 1, 0);
		header.setIgnoreTight(true);
		this.addChild(header);
		const immediate = new Text(displayContent(this.message), 1, 0);
		immediate.setIgnoreTight(true);
		this.addChild(immediate);
		if (this.#state.kind === "loading") {
			this.addChild(new Text(theme.fg("dim", "Loading durable council details…"), 1, 0));
			return;
		}
		if (this.#state.kind === "error") {
			this.addChild(new Text(theme.fg("warning", this.#state.message), 1, 0));
			return;
		}
		const rich = bounded(manifestLines(this.#state.hydration, this.message.details).join("\n"), MAX_DETAIL_CHARS);
		const detail = new Text(theme.fg("muted", rich), 1, 0);
		detail.setIgnoreTight(true);
		this.addChild(detail);
	}
}
