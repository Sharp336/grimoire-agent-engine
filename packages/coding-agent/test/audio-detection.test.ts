import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectSupportedAudioMimeTypeFromFile } from "../src/utils/audio-input";

// OggS capture pattern + page-header padding + codec signature, all within the
// first 512 bytes the detector reads.
function oggWith(codec: string): Buffer {
	return Buffer.concat([Buffer.from("OggS"), Buffer.alloc(28), Buffer.from(codec)]);
}

describe("audio format detection", () => {
	it("classifies Ogg/Opus and Ogg/Vorbis as audio but rejects Ogg/Theora video", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-audio-detect-"));
		try {
			const opus = join(dir, "opus.ogg");
			await writeFile(opus, oggWith("OpusHead"));
			expect(await detectSupportedAudioMimeTypeFromFile(opus)).toBe("audio/ogg");

			const vorbis = join(dir, "vorbis.ogg");
			await writeFile(vorbis, oggWith("\x01vorbis"));
			expect(await detectSupportedAudioMimeTypeFromFile(vorbis)).toBe("audio/ogg");

			// Ogg/Theora is a video container and must NOT be treated as audio.
			const theora = join(dir, "video.ogv");
			await writeFile(theora, oggWith("\x80theora"));
			expect(await detectSupportedAudioMimeTypeFromFile(theora)).toBeNull();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
