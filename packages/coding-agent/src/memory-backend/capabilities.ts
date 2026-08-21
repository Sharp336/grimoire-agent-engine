import type { MemoryBackendCapability, MemoryBackendId } from "./types";

/**
 * Authoritative feature surface for each memory backend.
 *
 * Tool activation and runtime operations use this table instead of spelling out
 * backend identities, so a new backend declares its capabilities in one place.
 */
const MEMORY_BACKEND_CAPABILITIES: Record<MemoryBackendId, readonly MemoryBackendCapability[]> = {
	off: [],
	local: [],
	hindsight: ["recall", "retain", "reflect"],
	mnemopi: ["recall", "retain", "reflect", "exact-read", "edit"],
	"mnemosyne-oss": ["recall", "retain", "reflect", "exact-read", "edit"],
};

export function memoryBackendSupports(id: string, capability: MemoryBackendCapability): boolean {
	const capabilities: readonly MemoryBackendCapability[] | undefined =
		MEMORY_BACKEND_CAPABILITIES[id as MemoryBackendId];
	return capabilities?.includes(capability) ?? false;
}
