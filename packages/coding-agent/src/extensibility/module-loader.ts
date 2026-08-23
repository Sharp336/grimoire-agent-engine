/** Runtime-selected module loading boundary for user and plugin modules. */
export async function loadRuntimeModule(modulePath: string): Promise<unknown> {
	return import(modulePath);
}
