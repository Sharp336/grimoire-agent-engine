import type { RuntimeAccess } from "./runtime-protocol";

export interface RuntimePageRequest extends RuntimeAccess {
	agentInstanceRef: string;
	attemptId?: string;
	revision?: number;
	cursor?: string;
	limit?: number;
	inputId?: string;
}

export interface RuntimeResourceRequest extends RuntimeAccess {
	resource: Record<string, unknown>;
	offset: number;
	limit: number;
}
