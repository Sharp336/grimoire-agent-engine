/**
 * Inline media inputs shared by the media-generation tools.
 *
 * Leaf module (no tool-local deps) so `generate_image` and `generate_video`
 * load reference media through one implementation — the size cap, the
 * magic-byte MIME sniff, and the ENOENT message are the parts that must not
 * drift between them.
 */

import { isEnoent, parseImageMetadata } from "@oh-my-pi/pi-utils";
import { resolveReadPath } from "./path-utils";

/** Base64 media payload plus the MIME type sniffed from its magic bytes. */
export interface InlineMediaData {
	data: string;
	mimeType: string;
}

/** Upper bound on a single inline reference image (provider request-body limit). */
export const MAX_INLINE_IMAGE_SIZE = 35 * 1024 * 1024;

/**
 * Upper bound on a single inline source video. Base64 inflates the body by a
 * third, so this is deliberately well under the image cap: a clip that large
 * belongs behind an https URL, which the resolver passes through untouched.
 */
export const MAX_INLINE_VIDEO_SIZE = 32 * 1024 * 1024;

/** Render inline media as an RFC 2397 data URL. */
export function toDataUrl(media: InlineMediaData): string {
	return `data:${media.mimeType};base64,${media.data}`;
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
export async function loadImageFromPath(imagePath: string, cwd: string): Promise<InlineMediaData> {
	const resolved = resolveReadPath(imagePath, cwd);
	const file = Bun.file(resolved);
	try {
		// Size first: reading a huge file only to reject it wastes the allocation.
		if (file.size > MAX_INLINE_IMAGE_SIZE) {
			throw new Error(`Image file too large: ${imagePath}`);
		}
		const buffer = await file.bytes();

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
 * Decoded byte count of a base64 payload: 3 bytes per 4 characters, less the
 * one or two bytes the `=` padding stands in for. Computed rather than decoded
 * so an over-cap payload is rejected without ever being allocated.
 */
function base64ByteLength(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return (data.length / 4) * 3 - padding;
}

/**
 * Resolve a caller-supplied image reference to something a provider accepts as
 * a URL field: `http(s)` URLs pass through, anything else is a filesystem path
 * inlined as a data URL. A caller-supplied `data:` URL is checked against the
 * same type and size limits as an inlined file — it ends up in the same request
 * body, so trusting its declared header would make the cap meaningless.
 */
export async function resolveImageReferenceUrl(reference: string, cwd: string): Promise<string> {
	const trimmed = reference.trim();
	if (/^https?:\/\//i.test(trimmed)) return trimmed;
	if (trimmed.startsWith("data:")) {
		const { data, mimeType } = normalizeDataUrl(trimmed);
		if (base64ByteLength(data) > MAX_INLINE_IMAGE_SIZE) {
			throw new Error(`Image data URL too large (max ${MAX_INLINE_IMAGE_SIZE / (1024 * 1024)}MB inline)`);
		}
		// The declared type is caller-supplied, so sniff the payload instead: 64
		// base64 characters carry the 48 bytes every container signature lives in.
		// The Imagine endpoints document PNG, JPEG and WebP as the accepted image
		// inputs, so a truthful `image/heic` and a lying `image/png` both stop here.
		const sniffed = parseImageMetadata(Buffer.from(data.slice(0, 64), "base64"))?.mimeType;
		if (sniffed !== "image/png" && sniffed !== "image/jpeg" && sniffed !== "image/webp") {
			throw new Error(
				`Unsupported image data URL (PNG, JPEG or WebP required): ${sniffed ?? mimeType ?? "unrecognised"}`,
			);
		}
		// Send what the bytes actually are: a mislabelled but otherwise valid
		// image would arrive with a header contradicting its own payload.
		return sniffed === mimeType ? trimmed : `data:${sniffed};base64,${data}`;
	}
	return toDataUrl(await loadImageFromPath(trimmed, cwd));
}

/**
 * ISO-BMFF brands that denote an MP4 movie. The container is shared with
 * QuickTime (`qt  `) and the HEIF still-image family (`heic`, `avif`, `mif1`,
 * …), which the Imagine video endpoints reject, so brands are the only thing
 * that separates them — `ftyp` alone does not.
 */
const MP4_BRANDS: Record<string, true> = {
	isom: true,
	iso2: true,
	iso3: true,
	iso4: true,
	iso5: true,
	iso6: true,
	iso7: true,
	iso8: true,
	iso9: true,
	mp41: true,
	mp42: true,
	avc1: true,
	av01: true,
	dash: true,
	mmp4: true,
	"M4V ": true,
};

/**
 * MP4 detection from the container header rather than the extension: a 4-byte
 * box size, the `ftyp` box type, the major brand, a minor version, then the
 * compatible-brand list.
 *
 * Every brand in the box is checked, not just the major one: profile-specific
 * files (`cmfc`, `MSNV`, `3gp4`, …) carry a plain MP4 brand in the compatible
 * list, and rejecting those would refuse videos the endpoint accepts.
 */
function isMp4(bytes: Uint8Array): boolean {
	if (bytes.length < 12) return false;
	if (bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) return false;
	const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
	// A `ftyp` box is 16 bytes plus whole 4-byte compatible brands, and the bytes
	// it declares must actually be there — a truncated, misaligned or invented
	// header is not a movie, whether it came off disk or out of a data URL.
	if (boxSize < 16 || boxSize % 4 !== 0 || boxSize > bytes.length) return false;
	// Major brand at 8, minor version at 12, compatible brands from 16 on. A
	// brand is exactly four characters, so it can never collide with a prototype
	// key such as `constructor` and the plain index is safe.
	for (let offset = 8; offset + 4 <= boxSize; offset = offset === 8 ? 16 : offset + 4) {
		const brand = String.fromCharCode(
			bytes[offset] ?? 0,
			bytes[offset + 1] ?? 0,
			bytes[offset + 2] ?? 0,
			bytes[offset + 3] ?? 0,
		);
		if (MP4_BRANDS[brand] === true) return true;
	}
	return false;
}

/** Read a local MP4 into base64, enforcing the size cap and the container check. */
export async function loadVideoFromPath(videoPath: string, cwd: string): Promise<InlineMediaData> {
	const resolved = resolveReadPath(videoPath, cwd);
	const file = Bun.file(resolved);
	try {
		// Check the size before reading: `bytes()` on a multi-gigabyte file would
		// allocate all of it just to be told it is over the cap.
		if (file.size > MAX_INLINE_VIDEO_SIZE) {
			throw new Error(`Video file too large (max ${MAX_INLINE_VIDEO_SIZE / (1024 * 1024)}MB inline): ${videoPath}`);
		}
		const buffer = await file.bytes();
		if (!isMp4(buffer)) {
			throw new Error(`Unsupported video type (MP4 required): ${videoPath}`);
		}
		return { data: buffer.toBase64(), mimeType: "video/mp4" };
	} catch (err) {
		if (isEnoent(err)) throw new Error(`Video file not found: ${videoPath}`);
		throw err;
	}
}

/**
 * Resolve a caller-supplied video reference the same way images resolve:
 * `http(s)` URLs pass through, anything else is a filesystem path inlined as a
 * data URL. A caller-supplied `data:` URL is re-checked rather than trusted —
 * it lands in the same request body as an inlined file and must clear the same
 * type and size limits.
 */
export async function resolveVideoReferenceUrl(reference: string, cwd: string): Promise<string> {
	const trimmed = reference.trim();
	if (/^https?:\/\//i.test(trimmed)) return trimmed;
	if (trimmed.startsWith("data:")) {
		const { data, mimeType } = normalizeDataUrl(trimmed);
		if (mimeType !== "video/mp4") throw new Error(`Unsupported video data URL (video/mp4 required): ${mimeType}`);
		if (base64ByteLength(data) > MAX_INLINE_VIDEO_SIZE) {
			throw new Error(`Video data URL too large (max ${MAX_INLINE_VIDEO_SIZE / (1024 * 1024)}MB inline)`);
		}
		// The declared MIME type is caller-supplied; only the container header
		// proves what the payload is. Decode the 12-byte prefix to learn the
		// `ftyp` box size, then decode exactly that box — tens of bytes out of a
		// clip that may be megabytes.
		const prefix = Buffer.from(data.slice(0, 16), "base64");
		const boxSize = prefix.length >= 12 ? prefix.readUInt32BE(0) : 0;
		// Cap what a header claim can make us decode; a real `ftyp` is tens of
		// bytes, and the allowlist scan stops at the box anyway.
		const headerBytes = Math.min(boxSize, 1024);
		if (!isMp4(Buffer.from(data.slice(0, Math.ceil(headerBytes / 3) * 4), "base64"))) {
			throw new Error("Unsupported video data URL (MP4 required)");
		}
		return trimmed;
	}
	return toDataUrl(await loadVideoFromPath(trimmed, cwd));
}
