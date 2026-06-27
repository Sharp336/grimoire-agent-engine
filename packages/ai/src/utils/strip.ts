/**
 * Helper to standardise removing transient parsing or serialization keys
 * from internally managed LLM structures before those objects leave provider
 * internals.
 */
export function stripVariant<T>(container: object, key: keyof T): void {
	if (Object.hasOwn(container, key)) {
		Reflect.deleteProperty(container, key);
	}
}
