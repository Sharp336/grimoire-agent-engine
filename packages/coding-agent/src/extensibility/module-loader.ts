/** Runtime-selected module loading boundary for user and plugin modules. */
export async function loadRuntimeModule(modulePath: string, cacheBust = ""): Promise<unknown> {
	return import(cacheBust ? `${modulePath}?${cacheBust}` : modulePath);
}
