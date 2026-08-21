import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

const MINIMIZER_GAIN_FILE = "minimizer-gain.jsonl";
const BYTES_PER_TOKEN_ESTIMATE = 4;
const TELEMETRY_FILE_MODE = 0o600;
const TELEMETRY_DIR_MODE = 0o700;

/** Classification persisted for a completed eligible bash execution; consumed by the Stats Gain dashboard. */
export type BashMinimizerGainKind = "saved" | "missed";

/**
 * Completed native bash-minimizer outcome supplied by bash-session telemetry
 * callers before it is persisted for the Stats Gain dashboard.
 */
export interface BashMinimizerGainInput {
	command: string;
	cwd?: string;
	sessionCwd?: string;
	sessionId?: string;
	filter: string;
	inputBytes: number;
	outputBytes: number;
	exitCode: number | null;
	kind?: BashMinimizerGainKind;
	agentDir?: string;
}

/** Resolves the opt-in local JSONL destination used by telemetry writers. */
function getBashMinimizerGainPath(agentDir = getAgentDir()): string {
	return path.join(agentDir, MINIMIZER_GAIN_FILE);
}

/**
 * Appends one eligible native bash-minimizer outcome for the Stats Gain dashboard.
 * Called by bash execution paths only after the command has completed.
 */
export async function appendBashMinimizerGainRecord(input: BashMinimizerGainInput): Promise<void> {
	const kind = input.kind ?? "saved";
	const savedBytes = kind === "saved" ? input.inputBytes - input.outputBytes : 0;
	if (kind === "saved" && savedBytes <= 0) return;

	const observedInputBytes = input.inputBytes;
	const observedOutputBytes = input.outputBytes;
	if (kind === "missed" && observedInputBytes <= 0 && observedOutputBytes <= 0) return;

	const recordsPath = getBashMinimizerGainPath(input.agentDir);
	const resolvedCwd = input.cwd ? path.resolve(input.cwd) : undefined;
	const resolvedSessionCwd = input.sessionCwd ? path.resolve(input.sessionCwd) : undefined;
	const cwdRealpath = resolvedCwd ? await fs.realpath(resolvedCwd).catch(() => resolvedCwd) : undefined;
	const sessionCwdRealpath = resolvedSessionCwd
		? await fs.realpath(resolvedSessionCwd).catch(() => resolvedSessionCwd)
		: undefined;
	const record = {
		schemaVersion: 1,
		timestamp: new Date().toISOString(),
		...(cwdRealpath ? { cwd: cwdRealpath } : {}),
		...(sessionCwdRealpath ? { sessionCwd: sessionCwdRealpath } : {}),
		...(input.sessionId ? { sessionId: input.sessionId } : {}),
		command: input.command,
		filter: input.filter,
		inputBytes: observedInputBytes,
		outputBytes: observedOutputBytes,
		savedBytes,
		...(kind === "saved" ? { savedTokens: Math.round(savedBytes / BYTES_PER_TOKEN_ESTIMATE) } : {}),
		exitCode: input.exitCode,
		kind,
	};

	await appendPrivateTelemetryLine(recordsPath, `${JSON.stringify(record)}\n`);
}

/** Creates the JSONL file `0600` and its parent `0700` so umask cannot leave it world-readable. */
async function appendPrivateTelemetryLine(recordsPath: string, line: string): Promise<void> {
	const dir = path.dirname(recordsPath);
	await fs.mkdir(dir, { recursive: true, mode: TELEMETRY_DIR_MODE });
	if (process.platform !== "win32") {
		await fs.chmod(dir, TELEMETRY_DIR_MODE);
	}
	const handle = await fs.open(recordsPath, "a", TELEMETRY_FILE_MODE);
	try {
		if (process.platform !== "win32") {
			await handle.chmod(TELEMETRY_FILE_MODE);
		}
		await handle.appendFile(line, "utf8");
	} finally {
		await handle.close();
	}
}
