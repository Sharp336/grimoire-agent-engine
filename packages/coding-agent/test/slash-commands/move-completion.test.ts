import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { getMoveDirectoryArgumentCompletions } from "../../src/slash-commands/helpers/directory-completion";

const originalProjectDir = getProjectDir();
let tempDir: string;

async function completeMoveArgument(argumentText: string): Promise<string[]> {
	const result = await getMoveDirectoryArgumentCompletions(argumentText);
	return result?.map(item => item.value) ?? [];
}

describe("/move directory completion", () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-move-completion-"));
		setProjectDir(tempDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setProjectDir(originalProjectDir);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("lists directories at the destination prompt without files", async () => {
		fs.mkdirSync(path.join(tempDir, "alpha"));
		fs.mkdirSync(path.join(tempDir, ".config"));
		fs.writeFileSync(path.join(tempDir, "alpha.txt"), "not a destination");

		const values = await completeMoveArgument("");

		expect(values).toContain("alpha/");
		expect(values).toContain(".config/");
		expect(values).not.toContain("alpha.txt");
	});

	it("keeps completing below directories whose names contain spaces", async () => {
		fs.mkdirSync(path.join(tempDir, "My Project", "src"), { recursive: true });
		fs.mkdirSync(path.join(tempDir, "My Project", "scripts"), { recursive: true });

		const values = await completeMoveArgument("My Project/s");

		expect(values).toContain("My Project/scripts/");
		expect(values).toContain("My Project/src/");
	});

	it("completes tilde prefixes against a deterministic home directory", async () => {
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-move-home-"));
		try {
			fs.mkdirSync(path.join(homeDir, "foo"));
			fs.mkdirSync(path.join(homeDir, "fizz"));
			vi.spyOn(os, "homedir").mockReturnValue(homeDir);

			const compactValues = await completeMoveArgument("~fo");
			const slashValues = await completeMoveArgument("~/fi");

			expect(compactValues).toContain("~/foo/");
			expect(slashValues).toContain("~/fizz/");
		} finally {
			fs.rmSync(homeDir, { recursive: true, force: true });
		}
	});
});
