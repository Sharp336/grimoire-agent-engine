import { inflateSync } from "fflate";

export function inflateZipEntry(bytes: Uint8Array, uncompressedSize: number): Uint8Array {
	return inflateSync(bytes, { out: new Uint8Array(uncompressedSize) });
}
