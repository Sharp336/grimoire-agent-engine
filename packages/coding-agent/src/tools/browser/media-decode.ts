const MAX_DECODED_MEDIA_BYTES = 32 * 1024 * 1024;
const CANONICAL_BASE64_CHUNK = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface DecodedMediaChunks {
	chunks: Buffer[];
	byteLength: number;
}

export function decodeBoundedMediaChunks(base64Chunks: readonly string[]): DecodedMediaChunks {
	let byteLength = 0;
	for (const chunk of base64Chunks) {
		if (!CANONICAL_BASE64_CHUNK.test(chunk)) {
			throw new Error("downloadMedia page transfer returned invalid base64 data");
		}
		const padding = chunk.endsWith("==") ? 2 : chunk.endsWith("=") ? 1 : 0;
		byteLength += (chunk.length / 4) * 3 - padding;
		if (byteLength > MAX_DECODED_MEDIA_BYTES) {
			throw new Error("downloadMedia response exceeds the 32 MiB limit");
		}
	}
	const chunks = base64Chunks.map(chunk => {
		const decoded = Buffer.from(chunk, "base64");
		if (decoded.toString("base64") !== chunk) {
			throw new Error("downloadMedia page transfer returned invalid base64 data");
		}
		return decoded;
	});
	return { chunks, byteLength };
}
