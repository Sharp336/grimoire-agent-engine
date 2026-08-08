export interface CostGateController {
	warnCost?: number;
	maxCost?: number;
	/** One-time warn flag, shared across the whole session tree. */
	warned: boolean;
	/** Bound by the root session on first dispatch. */
	getCost?: () => number;
}

export class CostCapExceededError extends Error {
	constructor(public readonly cap: number) {
		super(`Cost cap reached ($${cap.toFixed(2)}). Raise session.maxCost or remove --max-cost to continue.`);
		this.name = "CostCapExceededError";
	}
}

export function createCostGateController(options: { warnCost?: number; maxCost?: number }): CostGateController {
	return { warnCost: options.warnCost, maxCost: options.maxCost, warned: false };
}

export type CostGateDecision = "ok" | "warn" | "cap";

export function evaluateCostGate(controller: CostGateController, cost: number): CostGateDecision {
	if (controller.maxCost !== undefined && cost >= controller.maxCost) return "cap";
	if (controller.warnCost !== undefined && cost >= controller.warnCost && !controller.warned) {
		controller.warned = true;
		return "warn";
	}
	return "ok";
}

export function applyCostGate<T>(
	gate: CostGateController,
	getCost: () => number,
	onWarn: (message: string) => void,
	dispatch: () => T,
): T {
	gate.getCost ??= getCost;
	const cost = gate.getCost();
	const decision = evaluateCostGate(gate, cost);
	if (decision === "cap") {
		throw new CostCapExceededError(gate.maxCost!);
	}
	if (decision === "warn") {
		onWarn(
			`Cost warning: cumulative session cost $${cost.toFixed(2)} reached the warn threshold ($${gate.warnCost!.toFixed(2)}).`,
		);
	}
	return dispatch();
}

// A negative or non-finite threshold can never be crossed by a cumulative
// cost, so it most likely means a misconfigured settings value; treat it as
// unset rather than enforcing a broken contract.
function normalizeThreshold(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function resolveCostGate(
	flags: { warnCost?: number; maxCost?: number },
	configured: { warnCost?: number; maxCost?: number },
): CostGateController | undefined {
	const warnCost = normalizeThreshold(flags.warnCost ?? configured.warnCost);
	const maxCost = normalizeThreshold(flags.maxCost ?? configured.maxCost);
	if (warnCost === undefined && maxCost === undefined) return undefined;
	return createCostGateController({ warnCost, maxCost });
}
