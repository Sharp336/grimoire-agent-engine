import type { ToolSession } from "../../tools";
import type { JsStatusEvent } from "../js/shared/types";

export interface PyToolBridgeEntry {
	toolSession: ToolSession;
	signal?: AbortSignal;
	emitStatus?: (event: JsStatusEvent) => void;
}

const registrations = new Map<string, PyToolBridgeEntry>();

function bridgeRegistrationKey(sessionId: string, runId: string): string {
	return `${sessionId}:${runId}`;
}

export function getPyToolBridgeEntry(sessionId: string, runId: string): PyToolBridgeEntry | undefined {
	const registrationKey = bridgeRegistrationKey(sessionId, runId);
	return registrations.get(registrationKey) ?? registrations.get(sessionId);
}

export function registerPyToolBridge(sessionId: string, runId: string, entry: PyToolBridgeEntry): () => void {
	const key = bridgeRegistrationKey(sessionId, runId);
	registrations.set(key, entry);
	return () => {
		if (registrations.get(key) === entry) {
			registrations.delete(key);
		}
	};
}

export function clearPyToolBridgeRegistrations(): void {
	registrations.clear();
}
