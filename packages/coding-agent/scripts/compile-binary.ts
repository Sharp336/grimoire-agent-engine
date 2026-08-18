import * as path from "node:path";
import { parseEmbeddedSourceCommit } from "@oh-my-pi/pi-utils/dirs";

import { buildDocsIndexPayload } from "./generate-docs-index";
import { createLegacyPiVirtualModulePlugin } from "./legacy-pi-virtual-module";

/** Native runtime dependencies always resolved from the on-demand install instead of embedded into compiled binaries. */
export const COMPILED_EXTERNAL_DEPENDENCIES: readonly string[] = Object.freeze(["fastembed", "onnxruntime-node"]);

const RUNTIME_BUILD_SOURCE_MODULE = path.join("packages", "utils", "src", "runtime-build-source.ts");

function createRuntimeBuildSourcePlugin(repoRoot: string, sourceCommit: string | undefined): Bun.BunPlugin {
	const modulePath = path.resolve(repoRoot, RUNTIME_BUILD_SOURCE_MODULE);
	const sourceLiteral = sourceCommit === undefined ? "undefined" : JSON.stringify(sourceCommit);
	return {
		name: "runtime-build-source",
		setup(build) {
			build.onLoad({ filter: /runtime-build-source\.ts$/ }, args => {
				if (path.resolve(args.path) !== modulePath) return undefined;
				return {
					contents: `export const RUNTIME_BUILD_SOURCE_COMMIT: string | undefined = ${sourceLiteral};\n`,
					loader: "ts",
				};
			});
		},
	};
}

/**
 * Read the exact Git object identity that a production binary binds into its
 * bytes. Call this before generators touch checked-in placeholders.
 */
export function resolveCleanSourceCommit(sourceRoot: string): string {
	const head = Bun.spawnSync(["git", "-C", sourceRoot, "rev-parse", "HEAD"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (head.exitCode !== 0) {
		throw new Error(`Unable to read Git HEAD for binary build: ${head.stderr.toString().trim()}`);
	}
	const sourceCommit = parseEmbeddedSourceCommit(head.stdout.toString().trim());
	if (!sourceCommit) {
		throw new Error("Git HEAD for binary build must be a lowercase 40-hex commit");
	}

	const status = Bun.spawnSync(["git", "-C", sourceRoot, "status", "--porcelain=v1", "--untracked-files=all"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (status.exitCode !== 0) {
		throw new Error(`Unable to inspect binary build worktree: ${status.stderr.toString().trim()}`);
	}
	if (status.stdout.toString().length > 0) {
		throw new Error("Refusing to build a binary from a dirty worktree");
	}
	return sourceCommit;
}

/** Inputs shared by local and release coding-agent binary builds. */
export interface CodingAgentCompileOptions {
	/** Absolute repository root used for package resolution. */
	readonly repoRoot: string;
	/** Absolute CLI entrypoint. */
	readonly entrypoint: string;
	/** Absolute standalone executable output path. */
	readonly outfile: string;
	/** Concrete Transformers.js version baked into the tiny-model worker. */
	readonly transformersVersion: string;
	/** Optional immutable Git identity embedded into the standalone artifact. */
	readonly sourceCommit?: string;

	/** Optional cross-compilation runtime target. */
	readonly target?: Bun.Build.CompileTarget;
	/** Optional unmodified Bun executable used as the standalone runtime template. */
	readonly executablePath?: string;
	/** Match release builds that minify identifiers while retaining names. */
	readonly minifyIdentifiers?: boolean;
	/** Disable Bun's built-in Darwin signing before the caller re-signs. */
	readonly skipBuiltinCodesign?: boolean;
}

/**
 * Compile the coding-agent executable with its legacy Pi compatibility module
 * graph supplied by an in-memory build plugin rather than generated files.
 */
export async function compileCodingAgent(options: CodingAgentCompileOptions): Promise<void> {
	const sourceCommit =
		options.sourceCommit === undefined ? undefined : parseEmbeddedSourceCommit(options.sourceCommit);
	if (options.sourceCommit !== undefined && !sourceCommit) {
		throw new Error("Coding-agent binary source commit must be lowercase 40-hex");
	}

	const previousCodesignSetting = Bun.env.BUN_NO_CODESIGN_MACHO_BINARY;
	if (options.skipBuiltinCodesign) {
		Bun.env.BUN_NO_CODESIGN_MACHO_BINARY = "1";
	}
	try {
		const output = await Bun.build({
			entrypoints: [options.entrypoint],
			root: options.repoRoot,
			external: [...COMPILED_EXTERNAL_DEPENDENCIES],
			define: {
				"process.env.PI_COMPILED": JSON.stringify("true"),
				"process.env.PI_TINY_TRANSFORMERS_VERSION": JSON.stringify(options.transformersVersion),
				"process.env.PI_DOCS_EMBED": JSON.stringify((await buildDocsIndexPayload()).payload),
			},
			minify: {
				identifiers: options.minifyIdentifiers ?? false,
				keepNames: true,
			},
			plugins: [
				createRuntimeBuildSourcePlugin(options.repoRoot, sourceCommit),
				await createLegacyPiVirtualModulePlugin(),
			],
			compile: {
				...(options.executablePath
					? { executablePath: options.executablePath }
					: options.target
						? { target: options.target }
						: {}),
				outfile: options.outfile,
				autoloadBunfig: false,
				autoloadDotenv: false,
				autoloadTsconfig: false,
				autoloadPackageJson: false,
			},
			throw: false,
		});
		if (!output.success) {
			throw new Error(`Coding-agent binary bundle failed:\n${output.logs.map(log => log.message).join("\n")}`);
		}
	} finally {
		if (previousCodesignSetting === undefined) {
			delete Bun.env.BUN_NO_CODESIGN_MACHO_BINARY;
		} else {
			Bun.env.BUN_NO_CODESIGN_MACHO_BINARY = previousCodesignSetting;
		}
	}
}
