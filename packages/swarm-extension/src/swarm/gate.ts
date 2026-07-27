/**
 * Gate mechanism: pause, ambient scan, timeout, resume.
 *
 * - Declared gates (§6.2): executor writes gate-<agent>.json and pauses
 * - Ambient scan (§7.1): post-wave checks pending-question-<agentName>.md
 * - Resume (§6.3): SessionManager.open() + append response as next user turn
 * - Timeout (§7.2.3): synthetic response on expiry per on_timeout policy
 * - Per-agent filenames (§7.2.1): avoids parallel-wave collisions
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { GateConfig } from "./schema";

// ============================================================================
// Types
// ============================================================================

export interface GateFile {
	agent: string;
	prompt: string;
	actions: string[];
	timeout?: number;
	onTimeout?: "fail" | "default_action";
	defaultAction?: string;
	pausedAt: number;
}

export interface GateResponse {
	agent: string;
	decision: string;
	resolvedAt: number;
}

// ============================================================================
// File path helpers
// ============================================================================

export function gateFilePath(stateDir: string, agentName: string): string {
	return path.join(stateDir, `gate-${agentName}.json`);
}

export function gateResponsePath(stateDir: string, agentName: string): string {
	return path.join(stateDir, `gate-response-${agentName}.json`);
}

export function pendingQuestionPath(stateDir: string, agentName: string): string {
	return path.join(stateDir, `pending-question-${agentName}.md`);
}

// ============================================================================
// Gate file operations
// ============================================================================

export async function writeGateFile(stateDir: string, agentName: string, config: GateConfig): Promise<void> {
	const gateFile: GateFile = {
		agent: agentName,
		prompt: config.prompt,
		actions: config.actions,
		timeout: config.timeout,
		onTimeout: config.onTimeout,
		defaultAction: config.defaultAction,
		pausedAt: Date.now(),
	};
	await Bun.write(gateFilePath(stateDir, agentName), JSON.stringify(gateFile, null, 2));
}

export async function readGateFile(stateDir: string, agentName: string): Promise<GateFile | null> {
	try {
		const content = await Bun.file(gateFilePath(stateDir, agentName)).text();
		return JSON.parse(content) as GateFile;
	} catch {
		return null;
	}
}

export async function gateFileExists(stateDir: string, agentName: string): Promise<boolean> {
	try {
		await fs.access(gateFilePath(stateDir, agentName));
		return true;
	} catch {
		return false;
	}
}

// ============================================================================
// Gate response operations
// ============================================================================

export async function writeGateResponse(stateDir: string, agentName: string, decision: string): Promise<void> {
	const response: GateResponse = {
		agent: agentName,
		decision,
		resolvedAt: Date.now(),
	};
	await Bun.write(gateResponsePath(stateDir, agentName), JSON.stringify(response, null, 2));
}

export async function readGateResponse(stateDir: string, agentName: string): Promise<GateResponse | null> {
	try {
		const content = await Bun.file(gateResponsePath(stateDir, agentName)).text();
		return JSON.parse(content) as GateResponse;
	} catch {
		return null;
	}
}

export async function gateResponseExists(stateDir: string, agentName: string): Promise<boolean> {
	try {
		await fs.access(gateResponsePath(stateDir, agentName));
		return true;
	} catch {
		return false;
	}
}

// ============================================================================
// Ambient scan (§7.1)
// ============================================================================

/**
 * Scan for pending-question-<agentName>.md files for agents in a wave.
 * Returns a map of agentName → question content for agents that have pending questions.
 */
export async function scanPendingQuestions(stateDir: string, agentNames: string[]): Promise<Map<string, string>> {
	const results = new Map<string, string>();
	for (const agentName of agentNames) {
		const questionPath = pendingQuestionPath(stateDir, agentName);
		try {
			const content = await fs.readFile(questionPath, "utf-8");
			results.set(agentName, content);
		} catch {
			// No pending question for this agent
		}
	}
	return results;
}

/**
 * Create a gate file from an ambient pending question.
 * The question content becomes the gate prompt with a single "respond" action.
 */
export async function createAmbientGate(stateDir: string, agentName: string, questionContent: string): Promise<void> {
	await writeGateFile(stateDir, agentName, {
		prompt: questionContent,
		actions: ["respond"],
	});
}

// ============================================================================
// Timeout (§7.2.3)
// ============================================================================

/**
 * Handle gate timeout by writing a synthetic response.
 * - on_timeout: "fail" → decision is "fail"
 * - on_timeout: "default_action" → decision is defaultAction
 * - no on_timeout → decision is "fail" (default)
 */
export async function handleGateTimeout(stateDir: string, agentName: string, config: GateConfig): Promise<GateResponse> {
	const decision =
		config.onTimeout === "default_action" && config.defaultAction ? config.defaultAction : "fail";
	await writeGateResponse(stateDir, agentName, decision);
	return { agent: agentName, decision, resolvedAt: Date.now() };
}

// ============================================================================
// Wait for gate response with timeout
// ============================================================================

const GATE_POLL_INTERVAL = 100; // ms

/**
 * Poll for a gate response file. If timeout is configured, writes synthetic
 * response on expiry. Returns the response (human or synthetic).
 */
export async function waitForGateResponse(
	stateDir: string,
	agentName: string,
	config: GateConfig,
	signal?: AbortSignal,
): Promise<GateResponse> {
	const deadline = config.timeout != null ? Date.now() + config.timeout * 1000 : Infinity;

	while (true) {
		// Check for human response first
		const response = await readGateResponse(stateDir, agentName);
		if (response) return response;

		// Check for timeout
		if (Date.now() >= deadline) {
			return handleGateTimeout(stateDir, agentName, config);
		}

		// Check for abort
		if (signal?.aborted) {
			throw new Error(`Gate wait aborted for agent '${agentName}'`);
		}

		// Poll
		await new Promise(resolve => setTimeout(resolve, GATE_POLL_INTERVAL));
	}
}

// ============================================================================
// Resume via session-resume (§6.3)
// ============================================================================

/**
 * Resume a paused agent session by opening the prior session file
 * and appending the gate response as the next user turn.
 * NOT a re-spawn — uses SessionManager.open() + createAgentSession().
 */
export interface ResumeAgentOptions {
	/** State directory containing gate files */
	stateDir: string;
	/** Name of the agent to resume */
	agentName: string;
	/** Gate response decision */
	decision: string;
	/** Directory where session JSONL files are stored */
	artifactsDir: string;
	/** Agent ID used as session file name prefix */
	agentId: string;
	/** System prompt for the resumed session */
	systemPrompt: string;
	/** Model override for the resumed session */
	modelOverride?: string;
}

/**
 * Resolve the session file path for a given agent ID in the artifacts directory.
 */
export function resolveSessionFile(artifactsDir: string, agentId: string): string {
	return path.join(artifactsDir, `${agentId}.jsonl`);
}
