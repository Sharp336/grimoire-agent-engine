import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type {
	ChildInvalidationDTO,
	ChildPermissionSet,
	ChildSnapshotDTO,
} from "@oh-my-pi/pi-coding-agent/agent-control/protocol";
import type { AgentControlExtensionHost } from "@oh-my-pi/pi-coding-agent/agent-control/server";
import { $which } from "@oh-my-pi/pi-utils";

const DEFAULT_CAP = 4;
const KITTY_TIMEOUT_MS = 5_000;
const HANDOFF_EXPIRY_MS = 30_000;
const OWNER_VAR = "OMP_PANE_OWNER";
const VIEWER_VAR = "OMP_PANE_VIEWER";
const UNAVAILABLE_NOTICE = "Kitty subagent panes are unavailable; agents continue in Agent Hub.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_ID_PATTERN = /^[1-9][0-9]*$/;

export interface KittyExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface KittyWindow {
	id: number;
	cmdline: string[];
	userVars: Record<string, string>;
}

export interface KittyPaneControllerOptions {
	host: Pick<AgentControlExtensionHost, "getGeneration" | "getChildren" | "onInvalidation" | "createPermissionSet">;
	kittenExecutable: string;
	ompExecutable: string;
	passwordFile: string;
	exec(command: string, args: string[]): Promise<KittyExecResult>;
	createHandoff(permission: ChildPermissionSet): Promise<string | undefined>;
	notice(): void;
	removeHandoff?(locator: string): Promise<void>;
	randomNonce?: () => string;
	cap?: number;
}

interface PaneRecord {
	nonce: string;
	viewerId: string;
	windowId: number;
	handoffLocator?: string;
	handoffTimer?: NodeJS.Timeout;
}

interface KittyResolvedConfig {
	kittenExecutable: string;
	ompExecutable: string;
	passwordFile: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every(item => typeof item === "string");
}

/** Parse only the identity fields needed for ownership checks. Raw `kitten @ ls` output must never be logged. */
export function parseKittyWindows(raw: string): KittyWindow[] {
	let root: unknown;
	try {
		root = JSON.parse(raw);
	} catch {
		throw new Error("Kitty returned malformed structured window data.");
	}
	const windows: KittyWindow[] = [];
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (!isRecord(value)) return;
		if (
			typeof value.id === "number" &&
			Number.isSafeInteger(value.id) &&
			value.id > 0 &&
			Array.isArray(value.cmdline) &&
			value.cmdline.every(item => typeof item === "string") &&
			isStringRecord(value.user_vars)
		) {
			windows.push({ id: value.id, cmdline: value.cmdline, userVars: value.user_vars });
		}
		for (const [key, child] of Object.entries(value)) {
			if (key !== "cmdline" && key !== "user_vars") visit(child);
		}
	};
	visit(root);
	return windows;
}

export function isOwnedViewer(window: KittyWindow, record: PaneRecord): boolean {
	return (
		window.id === record.windowId &&
		window.userVars[OWNER_VAR] === record.nonce &&
		window.userVars[VIEWER_VAR] === record.viewerId
	);
}

function ownershipMatch(record: PaneRecord): string {
	return `id:${record.windowId} and var:${OWNER_VAR}=${record.nonce} and var:${VIEWER_VAR}=${record.viewerId}`;
}

function parseWindowId(stdout: string): number | undefined {
	const value = stdout.trim();
	if (!NUMERIC_ID_PATTERN.test(value)) return undefined;
	const id = Number(value);
	return Number.isSafeInteger(id) ? id : undefined;
}

function remoteArgs(passwordFile: string, command: string, args: readonly string[] = []): string[] {
	return ["@", "--password-file", passwordFile, command, ...args];
}

function launchArgs(passwordFile: string, nonce: string, viewerId: string, viewerCommand: readonly string[]): string[] {
	return remoteArgs(passwordFile, "launch", [
		"--type=window",
		"--keep-focus",
		"--env",
		"OMP_KITTY_SUBAGENT_PANES",
		"--env",
		"OMP_KITTY_OMP_EXECUTABLE",
		"--env",
		"OMP_KITTY_KITTEN_EXECUTABLE",
		"--env",
		"OMP_KITTY_RC_PASSWORD_FILE",
		"--env",
		"KITTY_RC_PASSWORD",
		"--env",
		"KITTY_LISTEN_ON",
		"--env",
		"KITTY_PUBLIC_KEY",
		"--var",
		`${OWNER_VAR}=${nonce}`,
		"--var",
		`${VIEWER_VAR}=${viewerId}`,
		"--",
		...viewerCommand,
	]);
}

/** Generation-scoped, failure-isolated owner for Kitty viewer panes. */
export class KittyPaneController {
	readonly #options: KittyPaneControllerOptions;
	readonly #cap: number;
	readonly #admitted = new Set<string>();
	readonly #panes = new Map<string, PaneRecord>();
	readonly #startOrder: string[] = [];
	readonly #ordered = new Set<string>();
	#queue: Promise<void> = Promise.resolve();
	#generation = "";
	#orderGeneration = "";
	#unsubscribe: (() => void) | undefined;
	#closed = false;
	#notified = false;

	constructor(options: KittyPaneControllerOptions) {
		this.#options = options;
		this.#cap = options.cap ?? DEFAULT_CAP;
	}

	async start(): Promise<void> {
		if (this.#unsubscribe || this.#closed) return;
		this.#unsubscribe = this.#options.host.onInvalidation((invalidation: ChildInvalidationDTO) => {
			if (invalidation.kind !== "generation_closed") {
				if (this.#orderGeneration !== invalidation.generation) {
					this.#orderGeneration = invalidation.generation;
					this.#startOrder.length = 0;
					this.#ordered.clear();
				}
				if (!this.#ordered.has(invalidation.childId)) {
					this.#ordered.add(invalidation.childId);
					this.#startOrder.push(invalidation.childId);
				}
			}
			void this.#enqueue(() => this.#synchronize());
		});
		await this.#enqueue(() => this.#synchronize());
	}

	/** Test/embedding seam for awaiting invalidation work without exposing mutable state. */
	settled(): Promise<void> {
		return this.#queue;
	}

	async shutdown(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		await this.#enqueue(async () => {
			await this.#cleanup([...this.#panes.values()]);
			this.#panes.clear();
		});
	}

	#enqueue(work: () => Promise<void>): Promise<void> {
		this.#queue = this.#queue.then(work, work).catch(() => this.#noticeFailure());
		return this.#queue;
	}

	async #synchronize(): Promise<void> {
		if (this.#closed) return;
		const generation = this.#options.host.getGeneration();
		if (!generation) return;
		if (generation !== this.#generation) {
			await this.#cleanup([...this.#panes.values()]);
			this.#panes.clear();
			this.#admitted.clear();
			this.#generation = generation;
		}
		if (this.#orderGeneration !== generation) {
			this.#orderGeneration = generation;
			this.#startOrder.length = 0;
			this.#ordered.clear();
		}
		const childById = new Map<string, ChildSnapshotDTO>();
		for (const child of this.#options.host.getChildren()) {
			if (child.generation !== generation) continue;
			childById.set(child.id, child);
			if (!this.#ordered.has(child.id)) {
				this.#ordered.add(child.id);
				this.#startOrder.push(child.id);
			}
		}
		for (const childId of this.#startOrder) {
			const child = childById.get(childId);
			if (!child || this.#admitted.has(child.id)) continue;
			if (this.#admitted.size >= this.#cap) break;
			this.#admitted.add(child.id);
			await this.#launch(child, generation);
		}
	}

	async #launch(child: ChildSnapshotDTO, generation: string): Promise<void> {
		const permission = this.#options.host.createPermissionSet(child.id);
		if (!permission || permission.generation !== generation) {
			this.#noticeFailure();
			return;
		}
		let locator: string | undefined;
		try {
			locator = await this.#options.createHandoff(permission);
		} catch {
			this.#noticeFailure();
			return;
		}
		if (!locator || !path.isAbsolute(locator)) {
			this.#noticeFailure();
			return;
		}
		const nonce = this.#options.randomNonce?.() ?? crypto.randomUUID();
		const viewerId = this.#options.randomNonce?.() ?? crypto.randomUUID();
		if (!UUID_PATTERN.test(nonce) || !UUID_PATTERN.test(viewerId)) {
			await this.#removeHandoff(locator);
			this.#noticeFailure();
			return;
		}
		const viewerCommand = [this.#options.ompExecutable, "__agent-pane", "--", child.id, locator];
		let result: KittyExecResult;
		try {
			result = await this.#options.exec(
				this.#options.kittenExecutable,
				launchArgs(this.#options.passwordFile, nonce, viewerId, viewerCommand),
			);
		} catch {
			await this.#removeHandoff(locator);
			this.#noticeFailure();
			return;
		}
		const responseId = result.code === 0 ? parseWindowId(result.stdout) : undefined;
		let found: KittyWindow | undefined;
		let listed = false;
		try {
			const windows = await this.#listWindows();
			listed = true;
			found = windows.find(
				window => window.userVars[OWNER_VAR] === nonce && window.userVars[VIEWER_VAR] === viewerId,
			);
		} catch {
			this.#noticeFailure();
		}
		if (listed && !found) {
			await this.#removeHandoff(locator);
			this.#noticeFailure();
			return;
		}
		const windowId = found?.id ?? responseId;
		if (!windowId) {
			await this.#removeHandoff(locator);
			this.#noticeFailure();
			return;
		}
		const record: PaneRecord = { nonce, viewerId, windowId, handoffLocator: locator };
		if (found && found.id !== responseId && responseId !== undefined) {
			await this.#closeOwned(record, [found]);
			await this.#removeHandoff(locator);
			this.#noticeFailure();
			return;
		}
		if (result.code !== 0 || responseId === undefined || !found) this.#noticeFailure();
		if (this.#closed || this.#options.host.getGeneration() !== generation) {
			await this.#closeOwned(record, found ? [found] : undefined);
			await this.#removeHandoff(locator);
			return;
		}
		if (found || responseId !== undefined) {
			this.#panes.set(child.id, record);
			this.#scheduleHandoffExpiry(record);
		}
	}

	async #cleanup(records: PaneRecord[]): Promise<void> {
		if (records.length === 0) return;
		for (const record of records) await this.#expireHandoff(record);
		let windows: KittyWindow[];
		try {
			windows = await this.#listWindows();
		} catch {
			this.#noticeFailure();
			return;
		}
		for (const record of records) await this.#closeOwned(record, windows);
	}

	#scheduleHandoffExpiry(record: PaneRecord): void {
		const locator = record.handoffLocator;
		if (!locator) return;
		record.handoffTimer = setTimeout(() => {
			void this.#enqueue(async () => {
				if (record.handoffLocator !== locator) return;
				await this.#expireHandoff(record);
			});
		}, HANDOFF_EXPIRY_MS);
		record.handoffTimer.unref();
	}

	async #expireHandoff(record: PaneRecord): Promise<void> {
		clearTimeout(record.handoffTimer);
		record.handoffTimer = undefined;
		const locator = record.handoffLocator;
		record.handoffLocator = undefined;
		if (locator) await this.#removeHandoff(locator);
	}

	async #closeOwned(record: PaneRecord, windows?: KittyWindow[]): Promise<void> {
		let current = windows;
		if (!current) {
			try {
				current = await this.#listWindows();
			} catch {
				this.#noticeFailure();
				return;
			}
		}
		if (!current.some(window => isOwnedViewer(window, record))) return;
		try {
			const result = await this.#options.exec(
				this.#options.kittenExecutable,
				remoteArgs(this.#options.passwordFile, "close-window", [
					"--match",
					ownershipMatch(record),
					"--ignore-no-match",
				]),
			);
			if (result.code !== 0) this.#noticeFailure();
		} catch {
			this.#noticeFailure();
		}
	}

	async #listWindows(): Promise<KittyWindow[]> {
		const result = await this.#options.exec(
			this.#options.kittenExecutable,
			remoteArgs(this.#options.passwordFile, "ls"),
		);
		if (result.code !== 0) throw new Error("Kitty list failed.");
		return parseKittyWindows(result.stdout);
	}

	async #removeHandoff(locator: string): Promise<void> {
		try {
			if (this.#options.removeHandoff) await this.#options.removeHandoff(locator);
			else await fs.promises.rm(locator, { force: true });
		} catch {
			this.#noticeFailure();
		}
	}

	#noticeFailure(): void {
		if (this.#notified) return;
		this.#notified = true;
		try {
			this.#options.notice();
		} catch {}
	}
}

export function isExplicitLocalKitty(env: NodeJS.ProcessEnv = process.env): boolean {
	return (
		env.OMP_KITTY_SUBAGENT_PANES === "1" &&
		NUMERIC_ID_PATTERN.test(env.KITTY_WINDOW_ID ?? "") &&
		!env.SSH_CONNECTION &&
		!env.SSH_CLIENT &&
		!env.SSH_TTY
	);
}

function executable(candidate: string | undefined): string | undefined {
	if (!candidate || !path.isAbsolute(candidate)) return undefined;
	try {
		const resolved = fs.realpathSync(candidate);
		fs.accessSync(resolved, fs.constants.X_OK);
		return resolved;
	} catch {
		return undefined;
	}
}

export function resolveKittyConfig(env: NodeJS.ProcessEnv = process.env): KittyResolvedConfig | undefined {
	const ompExecutable =
		executable(env.OMP_KITTY_OMP_EXECUTABLE) ?? executable(process.argv[1]) ?? executable($which("omp") ?? undefined);
	const kittenExecutable =
		executable(env.OMP_KITTY_KITTEN_EXECUTABLE) ??
		executable($which("kitten") ?? undefined) ??
		executable("/Applications/kitty.app/Contents/MacOS/kitten");
	const passwordFile = env.OMP_KITTY_RC_PASSWORD_FILE;
	if (!ompExecutable || !kittenExecutable || !passwordFile || !path.isAbsolute(passwordFile)) return undefined;
	try {
		const stat = fs.lstatSync(passwordFile);
		const uid = process.getuid?.();
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			(uid !== undefined && stat.uid !== uid) ||
			(stat.mode & 0o077) !== 0
		)
			return undefined;
	} catch {
		return undefined;
	}
	return { ompExecutable, kittenExecutable, passwordFile: fs.realpathSync(passwordFile) };
}

export default function kittySubagentPanes(pi: ExtensionAPI): void {
	if (!isExplicitLocalKitty()) return;
	let controller: KittyPaneController | undefined;
	let notified = false;
	const notify = (ctx: ExtensionContext): void => {
		if (notified) return;
		notified = true;
		ctx.ui.notify(UNAVAILABLE_NOTICE, "warning");
	};
	pi.on("session_start", async (_event, ctx) => {
		if (controller) return;
		const config = resolveKittyConfig();
		const host = config ? pi.acquireAgentControl() : undefined;
		if (!config || !host) {
			notify(ctx);
			return;
		}
		controller = new KittyPaneController({
			host,
			kittenExecutable: config.kittenExecutable,
			ompExecutable: config.ompExecutable,
			passwordFile: config.passwordFile,
			exec: (command, args) => pi.exec(command, args, { timeout: KITTY_TIMEOUT_MS }),
			createHandoff: permission => pi.pi.createAgentPaneHandoff(permission),
			notice: () => notify(ctx),
		});
		await controller.start();
	});
	pi.on("session_shutdown", async () => {
		await controller?.shutdown();
	});
}
