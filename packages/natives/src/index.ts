import { createRequire } from "node:module";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

const require = createRequire(import.meta.url);
const __dirname = import.meta.dirname!;

function getNativesDir() {
	const xdgDataHome = process.env.XDG_DATA_HOME;
	if (xdgDataHome && fs.existsSync(path.join(xdgDataHome, "omp"))) {
		return path.join(xdgDataHome, "omp", "natives");
	}
	return path.join(os.homedir(), ".omp", "natives");
}

const platformTag = `${process.platform}-${process.arch}`;
const nativeDir = path.join(__dirname, "..", "native");
const execDir = path.dirname(process.execPath);
const userDataDir =
	process.platform === "win32"
		? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "omp")
		: path.join(os.homedir(), ".local", "bin");

const defaultFilename = `pi_natives.${platformTag}.node`;
const candidates = [
	path.join(nativeDir, defaultFilename),
	path.join(execDir, defaultFilename),
	path.join(getNativesDir(), defaultFilename),
	path.join(userDataDir, defaultFilename),
];

function loadNative() {
	for (const candidate of candidates) {
		try {
			return require(candidate);
		} catch {
			continue;
		}
	}
	throw new Error(`Failed to load pi_natives native addon. Tried: ${candidates.join(", ")}`);
}

const bindings = loadNative();

const enumExports = {
	AstMatchStrictness: {
		Cst: "cst",
		Smart: "smart",
		Ast: "ast",
		Relaxed: "relaxed",
		Signature: "signature",
		Template: "template",
	},
	ChunkAnchorStyle: {
		Full: "full",
		Kind: "kind",
		Bare: "bare",
		FullOmit: "full-omit",
		KindOmit: "kind-omit",
		None: "none",
	},
	ChunkEditOp: {
		Put: "put",
		Replace: "replace",
		Delete: "delete",
		Before: "before",
		After: "after",
		Prepend: "prepend",
		Append: "append",
	},
	ChunkFocusMode: {
		Expanded: "expanded",
		Collapsed: "collapsed",
		Container: "container",
	},
	ChunkReadStatus: {
		Ok: "ok",
		NotFound: "not_found",
		UnsupportedRegion: "unsupported_region",
	},
	ChunkRegion: { Head: "^", Body: "~" },
	Ellipsis: { Unicode: 0, Ascii: 1, Omit: 2 },
	FileType: { File: 1, Dir: 2, Symlink: 3 },
	GrepOutputMode: {
		Content: "content",
		Count: "count",
		FilesWithMatches: "filesWithMatches",
	},
	ImageFormat: { PNG: 0, JPEG: 1, WEBP: 2, GIF: 3 },
	KeyEventType: { Press: 1, Repeat: 2, Release: 3 },
	MacOSAppearance: { Dark: "dark", Light: "light" },
	SamplingFilter: {
		Nearest: 1,
		Triangle: 2,
		CatmullRom: 3,
		Gaussian: 4,
		Lanczos3: 5,
	},
};

const merged = { ...bindings, ...enumExports };
export default merged;

export const highlightCode = bindings.highlightCode;
export const supportsLanguage = bindings.supportsLanguage;
export const getSupportedLanguages = bindings.getSupportedLanguages;
export const detectMacOSAppearance = bindings.detectMacOSAppearance;
export const MacAppearanceObserver = bindings.MacAppearanceObserver;
export const MacOSPowerAssertion = bindings.MacOSPowerAssertion;
export const projfsOverlayStop = bindings.projfsOverlayStop;
export const projfsOverlayProbe = bindings.projfsOverlayProbe;
export const projfsOverlayStart = bindings.projfsOverlayStart;
export const fuzzyFind = bindings.fuzzyFind;
export const astEdit = bindings.astEdit;
export const astGrep = bindings.astGrep;
export const glob = bindings.glob;
export const grep = bindings.grep;
export const search = bindings.search;
export const hasMatch = bindings.hasMatch;
export const htmlToMarkdown = bindings.htmlToMarkdown;
export const parseKey = bindings.parseKey;
export const matchesKey = bindings.matchesKey;
export const parseKittySequence = bindings.parseKittySequence;
export const matchesKittySequence = bindings.matchesKittySequence;
export const matchesLegacySequence = bindings.matchesLegacySequence;
export const killTree = bindings.killTree;
export const listDescendants = bindings.listDescendants;
export const getWorkProfile = bindings.getWorkProfile;
export const sanitizeText = bindings.sanitizeText;
export const visibleWidth = bindings.visibleWidth;
export const extractSegments = bindings.extractSegments;
export const sliceWithWidth = bindings.sliceWithWidth;
export const truncateToWidth = bindings.truncateToWidth;
export const wrapTextWithAnsi = bindings.wrapTextWithAnsi;
export const encodeSixel = bindings.encodeSixel;
export const PhotonImage = bindings.PhotonImage;
export const resizeImage = bindings.resizeImage;
export const convertImage = bindings.convertImage;
export const inspectImage = bindings.inspectImage;
export const Shell = bindings.Shell;
export const PtySession = bindings.PtySession;
export const ChunkState = bindings.ChunkState;
export const executeShell = bindings.executeShell;
export const copyToClipboard = bindings.copyToClipboard;
export const readImageFromClipboard = bindings.readImageFromClipboard;
export const invalidateFsScanCache = bindings.invalidateFsScanCache;
export const formatAnchor = bindings.formatAnchor;
export const profileStart = bindings.profileStart;
export const profileStop = bindings.profileStop;
export const wyhash = bindings.wyhash;
export const DapSession = bindings.DapSession;

export const {
	AstMatchStrictness,
	ChunkAnchorStyle,
	ChunkEditOp,
	ChunkFocusMode,
	ChunkRegion,
	ChunkReadStatus,
	Ellipsis,
	FileType,
	GrepOutputMode,
	ImageFormat,
	KeyEventType,
	MacOSAppearance,
	SamplingFilter,
} = enumExports;

export type * from "../native/index.d.ts";
