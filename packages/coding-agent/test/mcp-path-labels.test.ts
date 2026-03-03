import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { getMCPScopePathLabels } from "../src/modes/mcp-path-labels";

let testAgentDir = "";
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

beforeEach(async () => {
	testAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-labels-"));
	setAgentDir(testAgentDir);
});

afterEach(async () => {
	if (originalAgentDir) {
		setAgentDir(originalAgentDir);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
	if (testAgentDir) {
		await fs.rm(testAgentDir, { recursive: true, force: true });
		testAgentDir = "";
	}
});

describe("getMCPScopePathLabels", () => {
	it("uses the runtime user agent directory for user scope", () => {
		const cwd = path.join(os.tmpdir(), "omp-mcp-labels-project");
		const labels = getMCPScopePathLabels(cwd);

		expect(labels.user).toBe(path.join(testAgentDir, "mcp.json"));
		expect(labels.project).toBe(path.join(cwd, ".omp", "mcp.json"));
	});

	it("shortens home-prefixed user path labels", () => {
		const customUserDir = path.join(os.homedir(), ".omp", "agents");
		setAgentDir(customUserDir);

		const labels = getMCPScopePathLabels(path.join(os.tmpdir(), "omp-mcp-labels-project"));
		expect(labels.user).toBe(path.join("~", ".omp", "agents", "mcp.json"));
	});

	it("does not shorten paths that only share a home prefix", () => {
		const customUserDir = path.join(`${os.homedir()}-alt`, ".omp", "agents");
		setAgentDir(customUserDir);

		const labels = getMCPScopePathLabels(path.join(os.tmpdir(), "omp-mcp-labels-project"));
		expect(labels.user).toBe(path.join(customUserDir, "mcp.json"));
	});
});
