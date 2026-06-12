import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AGENT_CONTROL_PROTOCOL_VERSION, type ChildPermissionSet } from "./protocol";

const HANDOFF_MAX_BYTES = 16 * 1024;
const HANDOFF_FILE_PATTERN = /^handoff-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;

export type AgentPaneHandoffErrorCode =
	| "invalid_locator"
	| "insecure_directory"
	| "missing_handoff"
	| "insecure_handoff"
	| "invalid_handoff";

export class AgentPaneHandoffError extends Error {
	readonly code: AgentPaneHandoffErrorCode;

	constructor(code: AgentPaneHandoffErrorCode, message: string) {
		super(message);
		this.name = "AgentPaneHandoffError";
		this.code = code;
	}
}

export interface AgentPaneHandoffOptions {
	/** Test/embedding override. The packaged pane command intentionally uses the confined default. */
	rootDir?: string;
}

export function agentPaneHandoffDirectory(): string {
	const uid = process.getuid?.();
	return path.join(os.tmpdir(), `omp-agent-pane-${uid ?? "user"}`);
}

function ownerMatches(stat: fs.Stats): boolean {
	const uid = process.getuid?.();
	return uid === undefined || stat.uid === uid;
}

async function secureRoot(rootDir: string, create: boolean): Promise<string> {
	const root = path.resolve(rootDir);
	if (create) {
		try {
			await fs.promises.mkdir(root, { mode: OWNER_ONLY_DIRECTORY_MODE });
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
	}
	let stat: fs.Stats;
	try {
		stat = await fs.promises.lstat(root);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			throw new AgentPaneHandoffError("missing_handoff", "Agent pane handoff is unavailable or already consumed.");
		}
		throw error;
	}
	if (stat.isSymbolicLink() || !stat.isDirectory() || !ownerMatches(stat) || (stat.mode & 0o077) !== 0) {
		throw new AgentPaneHandoffError("insecure_directory", "Agent pane handoff directory failed its security check.");
	}
	return root;
}

function confinedLocator(root: string, locator: string): string {
	if (!path.isAbsolute(locator)) {
		throw new AgentPaneHandoffError("invalid_locator", "Agent pane handoff locator must be absolute.");
	}
	const resolved = path.resolve(locator);
	if (path.dirname(resolved) !== root || !HANDOFF_FILE_PATTERN.test(path.basename(resolved))) {
		throw new AgentPaneHandoffError(
			"invalid_locator",
			"Agent pane handoff locator is outside its confined directory.",
		);
	}
	return resolved;
}

function isPermissionSet(value: unknown): value is ChildPermissionSet {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<ChildPermissionSet>;
	if (
		candidate.version !== AGENT_CONTROL_PROTOCOL_VERSION ||
		typeof candidate.generation !== "string" ||
		candidate.generation.length === 0 ||
		typeof candidate.childId !== "string" ||
		candidate.childId.length === 0 ||
		typeof candidate.token !== "string" ||
		candidate.token.length === 0 ||
		typeof candidate.endpoint !== "string"
	) {
		return false;
	}
	try {
		const endpoint = new URL(candidate.endpoint);
		return (
			endpoint.protocol === "http:" &&
			endpoint.hostname === "127.0.0.1" &&
			endpoint.username === "" &&
			endpoint.password === "" &&
			endpoint.pathname === "/" &&
			endpoint.search === "" &&
			endpoint.hash === ""
		);
	} catch {
		return false;
	}
}

/** Atomically publish one owner-only handoff file. Its path is a non-secret one-shot locator. */
export async function createAgentPaneHandoff(
	permissionSet: ChildPermissionSet,
	options: AgentPaneHandoffOptions = {},
): Promise<string> {
	if (!isPermissionSet(permissionSet)) {
		throw new AgentPaneHandoffError("invalid_handoff", "Refusing to create an invalid agent pane handoff.");
	}
	const root = await secureRoot(options.rootDir ?? agentPaneHandoffDirectory(), true);
	const nonce = crypto.randomUUID();
	const locator = path.join(root, `handoff-${nonce}.json`);
	const temporary = path.join(root, `handoff-${nonce}-pending.json`);
	try {
		const handle = await fs.promises.open(
			temporary,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
			OWNER_ONLY_FILE_MODE,
		);
		try {
			await handle.writeFile(JSON.stringify(permissionSet), "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await fs.promises.rename(temporary, locator);
	} catch (error) {
		await fs.promises.rm(temporary, { force: true });
		throw error;
	}
	return locator;
}

/**
 * Open, verify, read, and unlink a handoff before returning its permission set.
 * Valid owner-only files are consumed even when their payload is malformed.
 */
export async function consumeAgentPaneHandoff(
	locator: string,
	childSelector: string,
	options: AgentPaneHandoffOptions = {},
): Promise<ChildPermissionSet> {
	const root = await secureRoot(options.rootDir ?? agentPaneHandoffDirectory(), false);
	const file = confinedLocator(root, locator);
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	} catch (error) {
		if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ELOOP")) {
			throw new AgentPaneHandoffError("missing_handoff", "Agent pane handoff is unavailable or already consumed.");
		}
		throw error;
	}
	let text: string;
	try {
		const stat = await handle.stat();
		if (
			!stat.isFile() ||
			!ownerMatches(stat) ||
			(stat.mode & 0o777) !== OWNER_ONLY_FILE_MODE ||
			stat.size > HANDOFF_MAX_BYTES
		) {
			throw new AgentPaneHandoffError("insecure_handoff", "Agent pane handoff failed its security check.");
		}
		text = await handle.readFile("utf8");
		await fs.promises.unlink(file);
	} finally {
		await handle.close();
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new AgentPaneHandoffError("invalid_handoff", "Agent pane handoff payload is malformed.");
	}
	if (!isPermissionSet(value) || value.childId !== childSelector) {
		throw new AgentPaneHandoffError("invalid_handoff", "Agent pane handoff does not match the requested child.");
	}
	return value;
}
