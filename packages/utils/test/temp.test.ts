import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";

describe("TempDir", () => {
	it("creates bare prefixes under the system temporary directory", () => {
		using tempDir = TempDir.createSync("omp-bare-prefix-");
		expect(path.dirname(tempDir.path())).toBe(os.tmpdir());
		expect(path.basename(tempDir.path())).toStartWith("omp-bare-prefix-");
	});
});
