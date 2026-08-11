import { escapeXmlText } from "@oh-my-pi/pi-utils";
import type {
	GoalObservation,
	GoalWayfindingOutcome,
	GoalWayfindingState,
	GoalWaypoint,
} from "./state";

const MAX_GOAL_ID_LENGTH = 256;
const MAX_TEXT_LENGTH = 1_000;
const MAX_LIST_ITEMS = 8;
const MAX_LIST_ITEM_LENGTH = 400;
const MAX_TOTAL_LENGTH = 6_000;

const WAYFINDING_OUTCOMES: ReadonlySet<GoalWayfindingOutcome> = new Set([
	"succeeded",
	"partial",
	"failed",
	"unexpected",
	"blocked",
]);

export interface GoalWaypointUpdate {
	action: string;
	rationale: string;
	guidance?: string;
	successSignal?: string;
	replanIf?: string;
}

export interface GoalWayfindingUpdate {
	goalId: string;
	expectedRevision: number;
	focus?: string;
	waypoint: GoalWaypointUpdate;
	lastObservation?: GoalObservation;
	blockers?: readonly string[];
	assumptions?: readonly string[];
}

export interface NormalizedGoalWayfindingUpdate {
	goalId: string;
	expectedRevision: number;
	focus?: string;
	waypoint: GoalWaypoint;
	lastObservation?: GoalObservation;
	blockers?: readonly string[];
	assumptions?: readonly string[];
}

function normalizeRequiredText(label: string, value: string, maxLength = MAX_TEXT_LENGTH): string {
	const normalized = value.trim();
	if (!normalized) {
		throw new Error(`${label} is required`);
	}
	if (normalized.length > maxLength) {
		throw new Error(`${label} must be at most ${maxLength} characters`);
	}
	return normalized;
}

function normalizeOptionalText(label: string, value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim();
	if (!normalized) return undefined;
	if (normalized.length > MAX_TEXT_LENGTH) {
		throw new Error(`${label} must be at most ${MAX_TEXT_LENGTH} characters`);
	}
	return normalized;
}

function normalizeStringList(label: string, values: readonly string[] | undefined): readonly string[] | undefined {
	if (values === undefined) return undefined;
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const item = value.trim();
		if (!item || seen.has(item)) continue;
		if (item.length > MAX_LIST_ITEM_LENGTH) {
			throw new Error(`${label} entries must be at most ${MAX_LIST_ITEM_LENGTH} characters`);
		}
		seen.add(item);
		normalized.push(item);
	}
	if (normalized.length > MAX_LIST_ITEMS) {
		throw new Error(`${label} must contain at most ${MAX_LIST_ITEMS} entries`);
	}
	return normalized.length > 0 ? normalized : undefined;
}

function totalLength(update: Omit<NormalizedGoalWayfindingUpdate, "goalId" | "expectedRevision">): number {
	const waypoint = update.waypoint;
	let total =
		(update.focus?.length ?? 0) +
		waypoint.action.length +
		waypoint.rationale.length +
		(waypoint.guidance?.length ?? 0) +
		(waypoint.successSignal?.length ?? 0) +
		(waypoint.replanIf?.length ?? 0) +
		(update.lastObservation?.summary.length ?? 0);
	for (const item of update.blockers ?? []) total += item.length;
	for (const item of update.assumptions ?? []) total += item.length;
	return total;
}

export function normalizeGoalWayfindingUpdate(input: GoalWayfindingUpdate): NormalizedGoalWayfindingUpdate {
	const goalId = normalizeRequiredText("goal_id", input.goalId, MAX_GOAL_ID_LENGTH);
	if (
		!Number.isSafeInteger(input.expectedRevision) ||
		input.expectedRevision < 0 ||
		input.expectedRevision >= Number.MAX_SAFE_INTEGER
	) {
		throw new Error("expected_revision must be a non-negative safe integer below Number.MAX_SAFE_INTEGER");
	}

	const lastObservation = input.lastObservation
		? {
				outcome: input.lastObservation.outcome,
				summary: normalizeRequiredText("observation", input.lastObservation.summary),
			}
		: undefined;
	if (lastObservation && !WAYFINDING_OUTCOMES.has(lastObservation.outcome)) {
		throw new Error(`unsupported wayfinding outcome: ${String(lastObservation.outcome)}`);
	}

	const normalized: NormalizedGoalWayfindingUpdate = {
		goalId,
		expectedRevision: input.expectedRevision,
		focus: normalizeOptionalText("focus", input.focus),
		waypoint: {
			action: normalizeRequiredText("next_action", input.waypoint.action),
			rationale: normalizeRequiredText("why", input.waypoint.rationale),
			guidance: normalizeOptionalText("guidance", input.waypoint.guidance),
			successSignal: normalizeOptionalText("success_signal", input.waypoint.successSignal),
			replanIf: normalizeOptionalText("replan_if", input.waypoint.replanIf),
		},
		lastObservation,
		blockers: normalizeStringList("blockers", input.blockers),
		assumptions: normalizeStringList("assumptions", input.assumptions),
	};
	if (totalLength(normalized) > MAX_TOTAL_LENGTH) {
		throw new Error(`wayfinding state must be at most ${MAX_TOTAL_LENGTH} characters in total`);
	}
	return normalized;
}

export function createGoalWayfindingState(
	update: NormalizedGoalWayfindingUpdate,
	revision: number,
): GoalWayfindingState {
	if (!Number.isSafeInteger(revision) || revision <= 0) {
		throw new Error("wayfinding revision must be a positive safe integer");
	}
	return {
		revision,
		focus: update.focus,
		waypoint: { ...update.waypoint },
		lastObservation: update.lastObservation ? { ...update.lastObservation } : undefined,
		blockers: update.blockers ? [...update.blockers] : undefined,
		assumptions: update.assumptions ? [...update.assumptions] : undefined,
	};
}

export function cloneGoalWayfindingState(state: GoalWayfindingState | undefined): GoalWayfindingState | undefined {
	if (!state) return undefined;
	return {
		...state,
		waypoint: { ...state.waypoint },
		lastObservation: state.lastObservation ? { ...state.lastObservation } : undefined,
		blockers: state.blockers ? [...state.blockers] : undefined,
		assumptions: state.assumptions ? [...state.assumptions] : undefined,
	};
}

function pushTextElement(lines: string[], tag: string, value: string | undefined, indent: string): void {
	if (value === undefined) return;
	lines.push(`${indent}<${tag}>${escapeXmlText(value)}</${tag}>`);
}

function pushListElement(lines: string[], tag: string, values: readonly string[] | undefined): void {
	if (!values?.length) return;
	lines.push(`\t<${tag}>`);
	for (const value of values) {
		lines.push(`\t\t<item>${escapeXmlText(value)}</item>`);
	}
	lines.push(`\t</${tag}>`);
}

export function renderGoalWayfindingState(state: GoalWayfindingState | undefined): string {
	if (!state) return "";
	const lines = [`<wayfinding revision="${state.revision}">`];
	pushTextElement(lines, "focus", state.focus, "\t");
	lines.push("\t<waypoint>");
	pushTextElement(lines, "action", state.waypoint.action, "\t\t");
	pushTextElement(lines, "rationale", state.waypoint.rationale, "\t\t");
	pushTextElement(lines, "guidance", state.waypoint.guidance, "\t\t");
	pushTextElement(lines, "success_signal", state.waypoint.successSignal, "\t\t");
	pushTextElement(lines, "replan_if", state.waypoint.replanIf, "\t\t");
	lines.push("\t</waypoint>");
	if (state.lastObservation) {
		lines.push(`\t<last_observation outcome="${state.lastObservation.outcome}">`);
		pushTextElement(lines, "summary", state.lastObservation.summary, "\t\t");
		lines.push("\t</last_observation>");
	}
	pushListElement(lines, "blockers", state.blockers);
	pushListElement(lines, "assumptions", state.assumptions);
	lines.push("</wayfinding>");
	return lines.join("\n");
}
