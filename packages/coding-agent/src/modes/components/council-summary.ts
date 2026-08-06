import { type Component, Container, Text } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { CouncilManifest } from "../../council/state";
import { CouncilStorage, CouncilStorageError, councilArtifactUrl } from "../../council/storage";
import type { CustomMessage } from "../../session/messages";
import type { ToolSession } from "../../tools";
import { replaceTabs, shortenEmbeddedPaths } from "../../tools/render-utils";
import { theme } from "../theme/theme";

export const COUNCIL_SUMMARY_MESSAGE_TYPE = "council-summary";

const MAX_IMMEDIATE_CHARS = 2_400;
const MAX_DETAIL_CHARS = 8_000;
const MAX_ERROR_CHARS = 180;
const MAX_WARNING_ROWS = 5;

export interface CouncilSummaryDetails {
	runId?: unknown;
	manifestUrl?: unknown;
}

export type CouncilSummaryManifestLoader = (
	details: CouncilSummaryDetails | undefined,
	signal: AbortSignal,
) => Promise<CouncilManifest>;

type HydrationState =
	| { kind: "loading" }
	| { kind: "ready"; manifest: CouncilManifest }
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

function hydrationError(error: unknown): string {
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

function manifestLines(manifest: CouncilManifest): string[] {
	const lines = [
		`State: ${manifest.state} · rounds ${manifest.rounds.length} · outcomes ${outcomeCounts(manifest) || "none"}`,
	];
	for (const round of manifest.rounds.slice(0, 12)) {
		const members = round.members
			.map(
				member =>
					`${bounded(member.role, 48)} ${member.status}${member.attempts > 1 ? ` (${member.attempts} attempts)` : ""}`,
			)
			.join(", ");
		lines.push(`Round ${round.round} ${round.status}: ${bounded(members, 600)}`);
	}
	if (manifest.rounds.length > 12) lines.push(`… ${manifest.rounds.length - 12} more rounds`);

	const warnings: string[] = [];
	if (manifest.degraded) warnings.push("Run completed with degraded results.");
	if (manifest.failure) warnings.push(`${manifest.failure.phase}: ${manifest.failure.reason}`);
	warnings.push(...manifest.warnings);
	for (const round of manifest.rounds) {
		for (const member of round.members) {
			if (member.failureReason) warnings.push(`${member.role}: ${member.failureReason}`);
		}
	}
	for (const warning of warnings.slice(0, MAX_WARNING_ROWS)) lines.push(`Warning: ${bounded(warning, 500)}`);
	if (warnings.length > MAX_WARNING_ROWS) lines.push(`… ${warnings.length - MAX_WARNING_ROWS} more warnings`);
	const final = [...manifest.planVersions].reverse().find(version => version.kind === "final");
	if (manifest.published) lines.push(`Final: ${bounded(manifest.outputPath, 500)}`);
	if (final) lines.push(`Final artifact: ${final.artifact.url}`);
	if (!manifest.published && !final) lines.push("Final: unavailable");
	lines.push(`Manifest: ${councilArtifactUrl(manifest.runId, "manifest.json")}`);
	return lines;
}

/** Build a manifest loader pinned to the actual session that rendered the message. */
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
		const manifest = await new CouncilStorage(session).load(runId);
		if (signal.aborted) throw signal.reason;
		return manifest;
	};
}

/** Immediate provider-context card with generation-safe durable manifest hydration. */
export class CouncilSummaryComponent extends Container implements Component {
	#generation = 0;
	#abort: AbortController | undefined;
	#state: HydrationState = { kind: "loading" };
	#disposed = false;

	constructor(
		private readonly message: CustomMessage<CouncilSummaryDetails>,
		private readonly loader: CouncilSummaryManifestLoader,
		private readonly requestRender: () => void,
	) {
		super();
		this.#rebuild();
		this.hydrate();
	}

	/** Starts a new generation; exposed so session rebuilds can invalidate an older load. */
	hydrate(): void {
		const generation = ++this.#generation;
		this.#abort?.abort();
		const abort = new AbortController();
		this.#abort = abort;
		this.#state = { kind: "loading" };
		this.#rebuild();
		void this.loader(this.message.details, abort.signal).then(
			manifest => {
				if (this.#disposed || generation !== this.#generation || abort.signal.aborted) return;
				this.#state = { kind: "ready", manifest };
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
		const rich = bounded(manifestLines(this.#state.manifest).join("\n"), MAX_DETAIL_CHARS);
		const detail = new Text(theme.fg("muted", rich), 1, 0);
		detail.setIgnoreTight(true);
		this.addChild(detail);
	}
}
