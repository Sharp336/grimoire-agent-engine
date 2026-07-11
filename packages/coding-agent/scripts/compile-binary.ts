import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";

import { buildDocsIndexPayload } from "./generate-docs-index";
import { createLegacyPiVirtualModulePlugin } from "./legacy-pi-virtual-module";

/** Dependencies always resolved from runtime installs instead of embedded into compiled binaries. */
export const COMPILED_EXTERNAL_DEPENDENCIES: readonly string[] = Object.freeze(["fastembed", "onnxruntime-node"]);

function replaceRequiredSource(source: string, needle: string, replacement: string): string {
	const next = source.replace(needle, replacement);
	if (next === source) {
		throw new Error(`header-generator compile transform could not find expected source: ${needle}`);
	}
	return next;
}

async function buildEmbeddedHeaderGeneratorSource(repoRoot: string): Promise<{ path: string; source: string }> {
	const requireFromRepo = createRequire(path.join(repoRoot, "package.json"));
	const headerGeneratorRoot = path.dirname(requireFromRepo.resolve("header-generator"));
	const headerGeneratorModulePath = path.join(headerGeneratorRoot, "header-generator.js");
	const dataFilesRoot = path.join(headerGeneratorRoot, "data_files");

	const [source, headersOrderJson, browserHelperJson, inputNetworkZip, headerNetworkZip] = await Promise.all([
		Bun.file(headerGeneratorModulePath).text(),
		Bun.file(path.join(dataFilesRoot, "headers-order.json")).text(),
		Bun.file(path.join(dataFilesRoot, "browser-helper-file.json")).text(),
		fs.readFile(path.join(dataFilesRoot, "input-network-definition.zip")),
		fs.readFile(path.join(dataFilesRoot, "header-network-definition.zip")),
	]);
	const dirnameTemplatePlaceholder = "$" + "{__dirname}";

	let embeddedSource = replaceRequiredSource(
		source,
		'const utils_1 = require("./utils");',
		[
			'const utils_1 = require("./utils");',
			`const __OMP_HEADERS_ORDER_JSON = ${JSON.stringify(headersOrderJson)};`,
			`const __OMP_BROWSER_HELPER_JSON = ${JSON.stringify(browserHelperJson)};`,
			`const __OMP_INPUT_NETWORK_ZIP = Buffer.from(${JSON.stringify(inputNetworkZip.toString("base64"))}, "base64");`,
			`const __OMP_HEADER_NETWORK_ZIP = Buffer.from(${JSON.stringify(headerNetworkZip.toString("base64"))}, "base64");`,
		].join("\n"),
	);
	embeddedSource = replaceRequiredSource(
		embeddedSource,
		`this.headersOrder = JSON.parse((0, fs_1.readFileSync)(\`${dirnameTemplatePlaceholder}/data_files/headers-order.json\`).toString());`,
		"this.headersOrder = JSON.parse(__OMP_HEADERS_ORDER_JSON);",
	);
	embeddedSource = replaceRequiredSource(
		embeddedSource,
		`const uniqueBrowserStrings = JSON.parse((0, fs_1.readFileSync)(\`${dirnameTemplatePlaceholder}/data_files/browser-helper-file.json\`, 'utf8').toString());`,
		"const uniqueBrowserStrings = JSON.parse(__OMP_BROWSER_HELPER_JSON);",
	);
	embeddedSource = replaceRequiredSource(
		embeddedSource,
		`path: \`${dirnameTemplatePlaceholder}/data_files/input-network-definition.zip\`,`,
		"path: __OMP_INPUT_NETWORK_ZIP,",
	);
	embeddedSource = replaceRequiredSource(
		embeddedSource,
		`path: \`${dirnameTemplatePlaceholder}/data_files/header-network-definition.zip\`,`,
		"path: __OMP_HEADER_NETWORK_ZIP,",
	);

	return { path: headerGeneratorModulePath, source: embeddedSource };
}

/** Embeds header-generator data files so compiled binaries do not read build-machine paths. */
export async function createHeaderGeneratorCompilePlugin(repoRoot: string): Promise<Bun.BunPlugin> {
	const embedded = await buildEmbeddedHeaderGeneratorSource(repoRoot);

	return {
		name: "omp-header-generator-data",
		setup(build) {
			build.onLoad({ filter: /[/\\]header-generator[/\\]header-generator\.js$/ }, args => {
				if (path.normalize(args.path) !== path.normalize(embedded.path)) return undefined;
				return { contents: embedded.source, loader: "js" };
			});
		},
	};
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
	/** Optional cross-compilation runtime target. */
	readonly target?: Bun.Build.CompileTarget;
	/** Dependencies intentionally resolved from the runtime filesystem. */
	readonly external?: readonly string[];
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
	const previousCodesignSetting = Bun.env.BUN_NO_CODESIGN_MACHO_BINARY;
	if (options.skipBuiltinCodesign) {
		Bun.env.BUN_NO_CODESIGN_MACHO_BINARY = "1";
	}
	try {
		const external = [...new Set([...COMPILED_EXTERNAL_DEPENDENCIES, ...(options.external ?? [])])];
		const [docsIndex, headerGeneratorPlugin, legacyPiPlugin] = await Promise.all([
			buildDocsIndexPayload(),
			createHeaderGeneratorCompilePlugin(options.repoRoot),
			createLegacyPiVirtualModulePlugin(),
		]);
		const output = await Bun.build({
			entrypoints: [options.entrypoint],
			root: options.repoRoot,
			external,
			define: {
				"process.env.PI_COMPILED": JSON.stringify("true"),
				"process.env.PI_TINY_TRANSFORMERS_VERSION": JSON.stringify(options.transformersVersion),
				"process.env.PI_DOCS_EMBED": JSON.stringify(docsIndex.payload),
			},
			minify: {
				identifiers: options.minifyIdentifiers ?? false,
				keepNames: true,
			},
			plugins: [headerGeneratorPlugin, legacyPiPlugin],
			compile: {
				...(options.target ? { target: options.target } : {}),
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
