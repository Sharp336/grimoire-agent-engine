/**
 * Capture request contract shared by the Auto-Learn controller, the isolated
 * capture runner in `sdk.ts`, and the `/learn` slash command.
 *
 * Three kinds, three very different privacy envelopes:
 *   - `substantive` — the legacy behavior: a private agent over a detached copy
 *     of the FULL primary transcript, nudged to capture whatever was reusable.
 *   - `recovery` — transcript-free. The agent sees only bounded, redacted
 *     failure evidence plus (optionally) the procedure it already had.
 *   - `manual` — a bounded, token-capped window of recent real exchanges the
 *     user explicitly asked to preserve.
 *
 * Only `substantive` copies the conversation; the other two are constructed from
 * host-controlled data so nothing unrelated leaks into a persisted procedure.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ManagedProcedureScope } from "./catalog";

/** One bounded, redacted failure observation retained for capture evidence. */
export interface RecoveryEvidence {
	/** Failure family (`bash`, `mcp:<server>`). */
	family: string;
	/** Exact tool name inside the family. */
	toolName: string;
	/** Canonicalized arguments, capped and redacted. */
	argumentsSummary: string;
	/** Text result summary, capped and redacted. */
	resultSummary: string;
}

/** One family that failed repeatedly and then produced a non-error result. */
export interface RecoveredFamily {
	family: string;
	platform: string;
	/** Eligible failures counted before the recovery. */
	failureCount: number;
	/** At most the latest three failures for this family. */
	evidence: RecoveryEvidence[];
	/** Tool name that produced the recovering non-error result. */
	recoveredToolName: string;
	/** Redacted summary of the recovering result. */
	recoverySummary: string;
}

/** A procedure the host already had for a recovered family, for improvement rather than duplication. */
export interface CaptureReferenceProcedure {
	name: string;
	description: string;
	/** SKILL.md body, already size-capped by the caller. */
	body: string;
}

/**
 * Trusted, host-supplied catalog metadata the capture agent cannot omit or forge.
 *
 * Built PER `manage_skill` CALL inside a bounded capture: `toolFamilies` carries
 * exactly the one candidate the host assigned to that call, never the union of
 * every family in the request. Unioning them would tag each procedure with all
 * families and make per-candidate accounting impossible.
 */
export interface CaptureMetadataContext {
	scope: ManagedProcedureScope;
	projectKey?: string;
	projectLabel?: string;
	/** The assigned family for this call; merged into `ompManaged.toolFamilies`. */
	toolFamilies: string[];
	/** Current platform; merged into `ompManaged.platforms`. */
	platforms: string[];
	/** Host-derived symptom terms; merged into `ompManaged.triggers`. */
	triggers: string[];
	/**
	 * Host-assigned candidate this call is accounted against, echoed back in the
	 * tool result so the runner computes coverage from its OWN assignment rather
	 * than from names, counts, or model claims. Undefined for a manual capture,
	 * which has exactly one unnamed candidate.
	 */
	assignedFamily?: string;
}

/** Result-details key `manage_skill` stamps inside a bounded Auto-Learn capture. */
export const CAPTURE_RESULT_DETAILS_KEY = "autolearnCapture";

/**
 * Trusted per-call record of what a bounded capture actually wrote.
 *
 * Written by host tool code on a successful create/update and read back from the
 * finalized non-error result, so it is the only sound basis for deciding whether
 * a candidate still needs a corrective retry.
 */
export interface CaptureWriteRecord {
	action: "create" | "update";
	name: string;
	/** The candidate family the host assigned to this call. */
	family?: string;
}

/** Legacy full-transcript capture after a substantive turn. */
export interface SubstantiveCaptureRequest {
	kind: "substantive";
}

/** Transcript-free capture for verified tool-level recoveries. */
export interface RecoveryCaptureRequest {
	kind: "recovery";
	/** At most three recovered families per request. */
	families: RecoveredFamily[];
	/** Existing procedures matched for those families, if any. */
	references: CaptureReferenceProcedure[];
	metadata: CaptureMetadataContext;
}

/** User-directed capture over a bounded recent exchange window. */
export interface ManualCaptureRequest {
	kind: "manual";
	/** Immutable snapshot of the selected exchanges; never mutated after creation. */
	messages: readonly AgentMessage[];
	/** Untrusted user focus text; narrows selection, never an instruction override. */
	focus?: string;
	/** User-visible count of exchanges included, for the operator-facing report. */
	turns: number;
	references: CaptureReferenceProcedure[];
	metadata: CaptureMetadataContext;
}

/** Any capture the controller or `/learn` can schedule. */
export type AutoLearnCaptureRequest = SubstantiveCaptureRequest | RecoveryCaptureRequest | ManualCaptureRequest;

/** One procedure the capture agent successfully persisted. */
export interface CapturedProcedure {
	action: "create" | "update";
	name: string;
}

/** Result of a capture run, as observed from finalized non-error tool results. */
export interface AutoLearnCaptureResult {
	/** Procedures whose `manage_skill` call finalized without error. */
	stored: CapturedProcedure[];
	/**
	 * Why nothing (or not everything) was stored. Present only on partial or total
	 * failure; callers must surface this instead of claiming a memory was saved.
	 */
	error?: string;
}

/** Outcome of an explicit `/learn`, as reported to the operator. */
export type ManualAutoLearnResult = { ok: true; stored: CapturedProcedure[] } | { ok: false; error: string };

/** Bridge installed by the controller so `/learn` can reach the capture pipeline. */
export type ManualAutoLearnHandler = (request: { turns: number; focus?: string }) => Promise<ManualAutoLearnResult>;

/** Default `/learn` window in real user exchanges. */
export const MANUAL_CAPTURE_DEFAULT_TURNS = 4;
/** Accepted `/learn --turns` range. */
export const MANUAL_CAPTURE_MIN_TURNS = 1;
export const MANUAL_CAPTURE_MAX_TURNS = 12;
/** Estimated-token ceiling on the selected `/learn` snapshot. */
export const MANUAL_CAPTURE_MAX_TOKENS = 16_000;
/** Combined byte budget for reference procedure bodies handed to a capture agent. */
export const CAPTURE_REFERENCE_BODY_BUDGET = 8 * 1024;
/** Max recovered families bound into one recovery capture request. */
export const MAX_RECOVERED_FAMILIES_PER_CAPTURE = 3;
