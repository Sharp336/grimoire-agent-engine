import type { RuntimeScope, RuntimeWork } from "./runtime-protocol";

export interface RuntimeSnapshot {
	version: "1.0";
	scope: RuntimeScope;
	epoch: string;
	generation: number;
	watermark: number;
	projectionHash: string;
	agents: Record<string, unknown>[];
	members?: Record<string, unknown>[];
	nextCursor: string | null;
	work: RuntimeWork;
}
