/**
 * Source-mode fallback for artifact identity. The standalone binary builder
 * replaces this exact module with an immutable commit literal during bundling.
 */
export const RUNTIME_BUILD_SOURCE_COMMIT: string | undefined = undefined;
