import { fail } from "./errors.js";
import { boundedMap, controlFree, inputObject } from "./guards.js";
import { type EntryId, entryId, type HostId, hostId, type SessionId, sessionId } from "./ids.js";
export interface DurableEntry {
	id: EntryId;
	parentId: EntryId | null;
	hostId: HostId;
	sessionId: SessionId;
	kind: string;
	timestamp: string;
	data: Record<string, unknown>;
}
export function decodeEntry(input: unknown): DurableEntry {
	const path = "entry";
	const value = inputObject(input);
	entryId(value.id, `${path}.id`);
	if (value.parentId === undefined) fail("INVALID_FRAME", "parentId is required", `${path}.parentId`);
	if (value.parentId !== null) entryId(value.parentId, `${path}.parentId`);
	hostId(value.hostId, `${path}.hostId`);
	sessionId(value.sessionId, `${path}.sessionId`);
	controlFree(value.kind, `${path}.kind`, 128);
	controlFree(value.timestamp, `${path}.timestamp`, 128);
	boundedMap(value.data, `${path}.data`);
	return value as unknown as DurableEntry;
}
export function isDurableEntry(value: unknown): value is DurableEntry {
	try {
		decodeEntry(value);
		return true;
	} catch {
		return false;
	}
}
