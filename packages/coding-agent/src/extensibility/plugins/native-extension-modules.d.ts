declare module "omp-native-extension-modules" {
	/** Lazy host package namespace loaders retained for compiled native extensions. */
	export const BUNDLED_PI_MODULE_LOADERS: Readonly<Record<string, () => Promise<Readonly<Record<string, unknown>>>>>;
}
