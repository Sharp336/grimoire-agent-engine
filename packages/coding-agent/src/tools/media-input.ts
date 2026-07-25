/**
 * Inline media inputs shared by the media-generation tools.
 *
 * Leaf module (no tool-local deps) so `generate_image` and `generate_video`
 * load reference images through one implementation — the size cap, the
 * magic-byte MIME sniff, and the ENOENT message are the parts that must not
 * drift between them.
 */

import { isEnoent, parseImageMetadata } from "@oh-my-pi/pi-utils";
import { resolveReadPath } from "./path-utils";

/** Base64 image payload plus the MIME type sniffed from its magic bytes. */
export interface InlineImageData {
	data: string;
	mimeType: string;
}

/** Upper bound on a single inline reference image (provider request-body limit). */
export const MAX_INLINE_IMAGE_SIZE = 35 * 1024 * 1024;

/** Render an inline image as an RFC 2397 data URL. */
export function toDataUrl(image: InlineImageData): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

/**
 * Split a possibly-data-URL string into raw base64 and its declared MIME type.
 * Plain base64 passes through with no MIME type.
 */
export function normalizeDataUrl(data: string): { data: string; mimeType?: string } {
	const match = data.match(/^data:([^;]+);base64,(.+)$/);
	if (!match) return { data };
	return { data: match[2] ?? "", mimeType: match[1] };
}

/** Read a local image into base64, enforcing the size cap and a known image type. */
export async function loadImageFromPath(imagePath: string, cwd: string): Promise<InlineImageData> {
	const resolved = resolveReadPath(imagePath, cwd);
	try {
		const buffer = await Bun.file(resolved).bytes();
		if (buffer.length > MAX_INLINE_IMAGE_SIZE) {
			throw new Error(`Image file too large: ${imagePath}`);
		}

		const metadata = parseImageMetadata(buffer);
		const mimeType = metadata?.mimeType;
		if (!mimeType) {
			throw new Error(`Unsupported image type: ${imagePath}`);
		}

		return { data: buffer.toBase64(), mimeType };
	} catch (err) {
		if (isEnoent(err)) throw new Error(`Image file not found: ${imagePath}`);
		throw err;
	}
}

/**
 * Resolve a caller-supplied image reference to something a provider accepts as
 * a URL field: `http(s)` and `data:` URLs pass through untouched, anything else
 * is treated as a filesystem path and inlined as a data URL.
 */
export async function resolveImageReferenceUrl(reference: string, cwd: string): Promise<string> {
	const trimmed = reference.trim();
	if (/^https?:\/\//i.test(trimmed)) return trimmed;
	if (trimmed.startsWith("data:")) return trimmed;
	return toDataUrl(await loadImageFromPath(trimmed, cwd));
}
