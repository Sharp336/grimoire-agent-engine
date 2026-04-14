import * as esbuild from "esbuild";

interface BunBuildOptions {
  entrypoints: string[];
  outdir?: string;
  minify?: boolean;
  naming?: string;
  target?: string | string[];
  define?: Record<string, string>;
  external?: string[];
  sourcemap?: boolean;
}

interface BunBuildResult {
  success: boolean;
  outputs: Map<string, { path: string; content: Uint8Array }>;
  logs: string[];
}

export async function build(options: BunBuildOptions): Promise<BunBuildResult> {
  const logs: string[] = [];
  try {
    const result = await esbuild.build({
      entryPoints: options.entrypoints,
      bundle: true,
      outdir: options.outdir ?? "./out",
      minify: options.minify ?? false,
      target: (options.target as string[]) ?? ["es2024"],
      define: options.define,
      external: options.external,
      sourcemap: options.sourcemap,
      write: !!options.outdir,
      logLevel: "silent",
      platform: "browser",
      format: "esm",
    });

    if (result.errors.length > 0) {
      for (const e of result.errors) {
        logs.push(`error: ${e.text}`);
      }
      return { success: false, outputs: new Map(), logs };
    }

    for (const w of result.warnings) {
      logs.push(`warning: ${w.text}`);
    }

    return { success: true, outputs: new Map(), logs };
  } catch (err) {
    logs.push(err instanceof Error ? err.message : String(err));
    return { success: false, outputs: new Map(), logs };
  }
}
