export const REQUIRED_EXPORTS = [
	"astEdit",
	"astGrep",
	"ChunkState",
	"copyToClipboard",
	"detectMacOSAppearance",
	"encodeSixel",
	"executeShell",
	"extractSegments",
	"getDefaultTabWidth",
	"getIndentation",
	"getSupportedLanguages",
	"getWorkProfile",
	"glob",
	"grep",
	"highlightCode",
	"htmlToMarkdown",
	"invalidateFsScanCache",
	"killTree",
	"listDescendants",
	"MacAppearanceObserver",
	"matchesKey",
	"matchesKittySequence",
	"matchesLegacySequence",
	"parseKey",
	"parseKittySequence",
	"PhotonImage",
	"projfsOverlayProbe",
	"projfsOverlayStart",
	"projfsOverlayStop",
	"PtySession",
	"readImageFromClipboard",
	"sanitizeText",
	"SearchDb",
	"search",
	"setDefaultTabWidth",
	"Shell",
	"sliceWithWidth",
	"supportsLanguage",
	"truncateToWidth",
	"visibleWidth",
	"wrapTextWithAnsi",
] as const;

const embeddedLoadPatch = "let embeddedAddon = null;\n";
const lazyLoadPatch = [
	"if (isCompiledBinary) {",
	"\ttry {",
	'\t\t({ embeddedAddon } = require("./embedded-addon"));',
	"\t} catch {",
	"\t\tembeddedAddon = null;",
	"\t}",
	"}",
	"",
].join("\n");

const requiredExportsBlock = `const REQUIRED_EXPORTS = [\n${REQUIRED_EXPORTS.map(name => `\t"${name}",`).join("\n")}\n];\n\nfunction validateNative(bindings) {\n\tconst missing = REQUIRED_EXPORTS.filter(name => typeof bindings[name] !== "function");\n\tif (missing.length === 0) {\n\t\treturn bindings;\n\t}\n\n\tthrow new Error(\`Native addon missing required exports: \${missing.join(", ")}\`);\n}\n\n`;

const maybeExtractEmbeddedAddonBlock = `function maybeExtractEmbeddedAddon(errors) {\n\tif (!isCompiledBinary || !embeddedAddon) return null;\n\tif (embeddedAddon.platformTag !== platformTag || embeddedAddon.version !== packageVersion) return null;\n\n\tconst selectedEmbeddedFile = selectEmbeddedAddonFile();\n\tif (!selectedEmbeddedFile) return null;\n\tconst targetPath = path.join(versionedDir, selectedEmbeddedFile.filename);\n\n\ttry {\n\t\tfs.mkdirSync(versionedDir, { recursive: true });\n\t} catch (err) {\n\t\tconst message = err instanceof Error ? err.message : String(err);\n\t\terrors.push(\`embedded addon dir: \${message}\`);\n\t\treturn null;\n\t}\n\n\tlet embeddedBuffer;\n\ttry {\n\t\tembeddedBuffer = fs.readFileSync(selectedEmbeddedFile.filePath);\n\t} catch (err) {\n\t\tconst message = err instanceof Error ? err.message : String(err);\n\t\terrors.push(\`embedded addon read (\${selectedEmbeddedFile.filename}): \${message}\`);\n\t\treturn null;\n\t}\n\n\tif (fs.existsSync(targetPath)) {\n\t\ttry {\n\t\t\tconst cachedBuffer = fs.readFileSync(targetPath);\n\t\t\tif (cachedBuffer.equals(embeddedBuffer)) {\n\t\t\t\treturn targetPath;\n\t\t\t}\n\t\t\tif (process.env.PI_DEV) {\n\t\t\t\tconsole.warn(\`Embedded addon differs from cached copy \${targetPath}; using bundled payload\`);\n\t\t\t}\n\t\t\treturn selectedEmbeddedFile.filePath;\n\t\t} catch (err) {\n\t\t\tconst message = err instanceof Error ? err.message : String(err);\n\t\t\terrors.push(\`embedded addon compare (\${selectedEmbeddedFile.filename}): \${message}\`);\n\t\t\treturn selectedEmbeddedFile.filePath;\n\t\t}\n\t}\n\n\ttry {\n\t\tfs.writeFileSync(targetPath, embeddedBuffer);\n\t\treturn targetPath;\n\t} catch (err) {\n\t\tconst message = err instanceof Error ? err.message : String(err);\n\t\terrors.push(\`embedded addon write (\${selectedEmbeddedFile.filename}): \${message}\`);\n\t\treturn selectedEmbeddedFile.filePath;\n\t}\n}\n\n`;

const oldLoadNativeSnippet = [
	"\tconst embeddedCandidate = maybeExtractEmbeddedAddon(errors);",
	"\tconst runtimeCandidates = embeddedCandidate ? [embeddedCandidate, ...dedupedCandidates] : dedupedCandidates;",
	"\tfor (const candidate of runtimeCandidates) {",
	"\t\ttry {",
	"\t\t\tconst bindings = require_(candidate);",
	"\t\t\tif (process.env.PI_DEV) {",
	"\t\t\t\tconsole.log(`Loaded native addon from ${candidate}`);",
	"\t\t\t}",
	"\t\t\treturn bindings;",
].join("\n");

const newLoadNativeSnippet = [
	"\tconst embeddedCandidate = maybeExtractEmbeddedAddon(errors);",
	"\tconst runtimeCandidates = embeddedCandidate ? [...new Set([embeddedCandidate, ...dedupedCandidates])] : dedupedCandidates;",
	"\tfor (const candidate of runtimeCandidates) {",
	"\t\ttry {",
	"\t\t\tconst bindings = validateNative(require_(candidate));",
	"\t\t\tif (process.env.PI_DEV) {",
	"\t\t\t\tconsole.log(`Loaded native addon from ${candidate}`);",
	"\t\t\t}",
	"\t\t\treturn bindings;",
].join("\n");

function insertBefore(content: string, marker: string, block: string, description: string): string {
	if (content.includes(block)) {
		return content;
	}

	const index = content.indexOf(marker);
	if (index === -1) {
		throw new Error(`Could not patch native loader: missing ${description}.`);
	}
	return `${content.slice(0, index)}${block}${content.slice(index)}`;
}

function replaceOnce(content: string, from: string, to: string, description: string): string {
	if (content.includes(to)) {
		return content;
	}
	if (!content.includes(from)) {
		throw new Error(`Could not patch native loader: missing ${description}.`);
	}
	return content.replace(from, to);
}

function replaceBetween(content: string, startMarker: string, endMarker: string, replacement: string, description: string): string {
	const startIndex = content.indexOf(startMarker);
	if (startIndex === -1) {
		throw new Error(`Could not patch native loader: missing ${description} start marker.`);
	}
	const endIndex = content.indexOf(endMarker, startIndex);
	if (endIndex === -1) {
		throw new Error(`Could not patch native loader: missing ${description} end marker.`);
	}

	const current = content.slice(startIndex, endIndex);
	if (current === replacement) {
		return content;
	}
	return `${content.slice(0, startIndex)}${replacement}${content.slice(endIndex)}`;
}

export async function patchNativeLoader(indexPath: string): Promise<void> {
	let content = await Bun.file(indexPath).text();

	if (!content.includes(embeddedLoadPatch)) {
		content = content.replace(/const \{ embeddedAddon \} = require\("\.\/embedded-addon"\);\n/, embeddedLoadPatch);
	}
	if (!content.includes(lazyLoadPatch)) {
		content = content.replace(/(const isCompiledBinary =[\s\S]*?__filename\.includes\("%7EBUN"\);\n)/, `$1\n${lazyLoadPatch}`);
	}

	content = insertBefore(content, "function runCommand(command, args) {\n", requiredExportsBlock, "validation block");
	content = replaceBetween(
		content,
		"function maybeExtractEmbeddedAddon(errors) {\n",
		"function loadNative() {\n",
		maybeExtractEmbeddedAddonBlock,
		"embedded addon extraction block",
	);
	content = replaceOnce(content, oldLoadNativeSnippet, newLoadNativeSnippet, "loadNative candidate validation block");

	await Bun.write(indexPath, content);
}
