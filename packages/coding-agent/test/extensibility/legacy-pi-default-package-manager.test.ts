import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { DefaultPackageManager } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const tempRoots: string[] = [];

afterAll(async () => {
	for (const dir of tempRoots) {
		await removeWithRetries(dir);
	}
});

async function mkTempCwd(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

describe("DefaultPackageManager (legacy pi shim)", () => {
	it("resolve() returns discovered extensions with metadata", async () => {
		const cwd = await mkTempCwd("omp-legacy-pm-");
		const agentDir = path.join(cwd, "agent");
		const extensionsDir = path.join(agentDir, "extensions");
		await fs.mkdir(extensionsDir, { recursive: true });
		const extPath = path.join(extensionsDir, "sample-ext.ts");
		await fs.writeFile(
			extPath,
			'export default function (pi) { pi.registerCommand("sample", { handler: async () => {} }); }',
		);

		const settings = Settings.isolated({ extensions: [] });
		const pm = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
		const resolved = await pm.resolve(() => Promise.resolve("skip"));

		const match = resolved.extensions.find(entry => entry.path === extPath);
		expect(match).toBeDefined();
		expect(match?.enabled).toBe(true);
		expect(match?.metadata.source).toBe("auto");
		expect(match?.metadata.scope).toBe("user");
	});
});
