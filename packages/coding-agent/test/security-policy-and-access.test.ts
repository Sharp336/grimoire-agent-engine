import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import {
	requestWorkspaceCapabilityAccess,
	resolveWorkspaceCapabilityDecision,
	type SecurityApprovalUi,
} from "../src/security/access";
import { loadManagedPolicyFile } from "../src/security/policy";

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "omp-security-"));
}

describe("security hardening", () => {
	let tempDir: string;
	let originalPolicyPath: string | undefined;
	let originalPublicKeyPath: string | undefined;
	let originalAgentDir: string | undefined;
	let originalResolvedAgentDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
		originalPolicyPath = process.env.OH_OMP_POLICY_PATH;
		originalPublicKeyPath = process.env.OH_OMP_POLICY_PUBLIC_KEY_PATH;
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		originalResolvedAgentDir = getAgentDir();
		delete process.env.OH_OMP_POLICY_PATH;
		delete process.env.OH_OMP_POLICY_PUBLIC_KEY_PATH;
		delete process.env.PI_CODING_AGENT_DIR;
	});

	afterEach(() => {
		if (originalPolicyPath === undefined) delete process.env.OH_OMP_POLICY_PATH;
		else process.env.OH_OMP_POLICY_PATH = originalPolicyPath;
		if (originalPublicKeyPath === undefined) delete process.env.OH_OMP_POLICY_PUBLIC_KEY_PATH;
		else process.env.OH_OMP_POLICY_PUBLIC_KEY_PATH = originalPublicKeyPath;
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		setAgentDir(originalResolvedAgentDir);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("loads a signed managed policy with verified metadata", async () => {
		const policyPath = path.join(tempDir, "policy.yml");
		const publicKeyPath = path.join(tempDir, "policy.pub");
		const text = ["version: 1", "capabilities:", "  shell-exec: confirm", ""].join("\n");
		const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
		const signature = crypto.sign(null, Buffer.from(text, "utf8"), privateKey).toString("base64");
		fs.writeFileSync(policyPath, text);
		fs.writeFileSync(publicKeyPath, publicKey.export({ format: "pem", type: "spki" }));
		fs.writeFileSync(`${policyPath}.sig`, `${signature}\n`);

		const result = await loadManagedPolicyFile(policyPath, "system");

		expect(result.status).toBe("loaded");
		expect(result.policy?.verification.status).toBe("verified");
		expect(result.policy?.verification.publicKeyPath).toBe(publicKeyPath);
	});

	it("rejects policies that request signed loading without a valid detached signature", async () => {
		const policyPath = path.join(tempDir, "policy.yml");
		fs.writeFileSync(policyPath, ["version: 1", "integrity:", "  requireSignedManagedPolicy: true", ""].join("\n"));

		const result = await loadManagedPolicyFile(policyPath, "override");

		expect(result.status).toBe("error");
		expect(result.issues[0]?.code).toBe("signature-missing");
	});

	it("persists workspace trust when the user approves a default-deny capability", async () => {
		const agentDir = path.join(tempDir, "agent");
		const workspaceDir = path.join(tempDir, "workspace");
		const policyPath = path.join(tempDir, "policy.yml");
		const ui: SecurityApprovalUi = {
			select: async () => "Trust workspace",
			confirm: async () => true,
		};
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(workspaceDir, { recursive: true });
		fs.writeFileSync(policyPath, "version: 1\n");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		setAgentDir(agentDir);
		process.env.OH_OMP_POLICY_PATH = policyPath;

		const granted = await requestWorkspaceCapabilityAccess({
			cwd: workspaceDir,
			capability: "shell-exec",
			action: "Bash command execution",
			ui,
			trustBehavior: "allow-once-or-trust",
		});
		const resolved = await resolveWorkspaceCapabilityDecision({
			cwd: workspaceDir,
			capability: "shell-exec",
		});

		expect(granted.decision).toBe("allow");
		expect(granted.source).toBe("workspace-trust");
		expect(resolved.decision).toBe("allow");
		expect(resolved.source).toBe("workspace-trust");
		expect(fs.readFileSync(path.join(getAgentDir(), "workspace-trust.yml"), "utf8")).toContain("shell-exec");
	});

	it("does not allow workspace trust to override a managed deny", async () => {
		const agentDir = path.join(tempDir, "agent");
		const workspaceDir = path.join(tempDir, "workspace");
		const policyPath = path.join(tempDir, "policy.yml");
		const ui: SecurityApprovalUi = {
			select: async () => "Trust workspace",
			confirm: async () => true,
		};
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(workspaceDir, { recursive: true });
		fs.writeFileSync(policyPath, ["version: 1", "capabilities:", "  shell-exec: deny", ""].join("\n"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		setAgentDir(agentDir);
		process.env.OH_OMP_POLICY_PATH = policyPath;

		let deniedMessage = "";
		try {
			await requestWorkspaceCapabilityAccess({
				cwd: workspaceDir,
				capability: "shell-exec",
				action: "Bash command execution",
				ui,
				trustBehavior: "allow-once-or-trust",
			});
		} catch (error) {
			deniedMessage = error instanceof Error ? error.message : String(error);
		}
		expect(deniedMessage).toMatch(/blocked by security policy/);

		const resolved = await resolveWorkspaceCapabilityDecision({
			cwd: workspaceDir,
			capability: "shell-exec",
		});
		expect(resolved.decision).toBe("deny");
		expect(resolved.source).toBe("managed");
		expect(fs.existsSync(path.join(getAgentDir(), "workspace-trust.yml"))).toBe(false);
	});

	it("uses confirmation for managed confirm decisions without persisting workspace trust", async () => {
		const agentDir = path.join(tempDir, "agent");
		const workspaceDir = path.join(tempDir, "workspace");
		const policyPath = path.join(tempDir, "policy.yml");
		const ui: SecurityApprovalUi = {
			select: async () => "Cancel",
			confirm: async () => true,
		};
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(workspaceDir, { recursive: true });
		fs.writeFileSync(policyPath, ["version: 1", "capabilities:", "  shell-exec: confirm", ""].join("\n"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		setAgentDir(agentDir);
		process.env.OH_OMP_POLICY_PATH = policyPath;

		const result = await requestWorkspaceCapabilityAccess({
			cwd: workspaceDir,
			capability: "shell-exec",
			action: "Bash command execution",
			ui,
		});
		const resolved = await resolveWorkspaceCapabilityDecision({
			cwd: workspaceDir,
			capability: "shell-exec",
		});

		expect(result.decision).toBe("allow");
		expect(result.source).toBe("managed");
		expect(resolved.decision).toBe("confirm");
		expect(fs.existsSync(path.join(getAgentDir(), "workspace-trust.yml"))).toBe(false);
	});
});
