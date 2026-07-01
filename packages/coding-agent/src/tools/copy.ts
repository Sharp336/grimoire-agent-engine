import * as fs from "node:fs/promises";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { isEnoent, prompt, untilAborted } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { InternalUrlRouter, parseInternalUrl, resolveSshUrlTransferTarget } from "../internal-urls";
import copyDescription from "../prompts/tools/copy.md" with { type: "text" };
import type { SSHConnectionTarget } from "../ssh/connection-manager";
import { readRemoteFile, statRemotePath, writeRemoteFile } from "../ssh/file-transfer";
import type { ToolSession } from ".";
import { invalidateFsScanAfterWrite } from "./fs-cache-invalidation";
import { formatPathRelativeToCwd, isInternalUrlPath, isSshUrl, pathTargetsSsh, resolveReadPath } from "./path-utils";
import { enforcePlanModeWrite, resolvePlanPath, unwrapHashlineHeaderPath } from "./plan-mode-guard";
import { ToolError } from "./tool-errors";
import { clampTimeout } from "./tool-timeouts";

const copySchema = type({
	source: type("string").describe("source file path or URI"),
	destination: type("string").describe("destination file path or URI"),
	"timeout?": type("number").describe("timeout in seconds"),
});

export type CopyParams = typeof copySchema.infer;

// ponytail: buffered regular-file copies; add streaming if bulk transfers matter.
const COPY_MAX_BYTES = 64 * 1024 * 1024;

type CopyEndpoint =
	| { kind: "local"; raw: string; path: string }
	| { kind: "ssh"; raw: string; target: SSHConnectionTarget; remotePath: string };

export interface CopyToolDetails {
	bytes: number;
	source: string;
	destination: string;
}

function normalizeCopyPath(value: string): string {
	const path = unwrapHashlineHeaderPath(value.trim());
	if (!path) throw new ToolError("copy source and destination must be non-empty paths");
	return path;
}

function isWritableInternalDestination(value: string): boolean {
	const lower = value.toLowerCase();
	return lower.startsWith("local:") || lower.startsWith("vault:");
}

function formatLimit(): string {
	return `${Math.floor(COPY_MAX_BYTES / (1024 * 1024))} MiB`;
}

function endpointLabel(endpoint: CopyEndpoint, cwd: string): string {
	return endpoint.kind === "local" ? formatPathRelativeToCwd(endpoint.path, cwd) : endpoint.raw;
}

async function assertRemoteRegularFile(
	endpoint: Extract<CopyEndpoint, { kind: "ssh" }>,
	signal?: AbortSignal,
): Promise<void> {
	const kind = await statRemotePath(endpoint.target, endpoint.remotePath, { signal });
	if (kind === "directory") {
		throw new ToolError(`copy source is a directory: ${endpoint.raw}`);
	}
	if (kind === "other") {
		throw new ToolError(`copy source is not a regular file: ${endpoint.raw}`);
	}
}

export class CopyTool implements AgentTool<typeof copySchema, CopyToolDetails> {
	readonly name = "copy";
	readonly approval = (args: unknown) => {
		const params = args as Partial<CopyParams>;
		return pathTargetsSsh(`${params.source ?? ""}\n${params.destination ?? ""}`) ? "exec" : "write";
	};
	readonly label = "Copy";
	readonly description = prompt.render(copyDescription);
	readonly parameters = copySchema;
	readonly strict = true;
	readonly loadMode = "discoverable" as const;
	readonly summary = "Copy one regular file between local/internal and SSH paths";

	constructor(private readonly session: ToolSession) {}

	async #resolveSshEndpoint(raw: string): Promise<CopyEndpoint> {
		const parsed = parseInternalUrl(raw);
		const { target, remotePath } = await resolveSshUrlTransferTarget(parsed, this.session.cwd);
		return { kind: "ssh", raw, target, remotePath };
	}

	async #resolveSource(rawPath: string, signal?: AbortSignal): Promise<CopyEndpoint> {
		const raw = normalizeCopyPath(rawPath);
		if (isSshUrl(raw)) return this.#resolveSshEndpoint(raw);
		if (isInternalUrlPath(raw)) {
			const router = InternalUrlRouter.instance();
			if (!router.canHandle(raw)) {
				throw new ToolError(`copy source uses an unsupported internal URL: ${raw}`);
			}
			const resource = await router.resolve(raw, {
				cwd: this.session.cwd,
				settings: this.session.settings,
				signal,
				localProtocolOptions: this.session.localProtocolOptions,
				skills: this.session.skills,
			});
			if (resource.isDirectory) throw new ToolError(`copy source is a directory: ${raw}`);
			if (!resource.sourcePath) {
				throw new ToolError(
					`copy source must resolve to a regular file on disk or ssh:// path; unsupported internal URL: ${raw}`,
				);
			}
			return { kind: "local", raw, path: resource.sourcePath };
		}
		return { kind: "local", raw, path: resolveReadPath(raw, this.session.cwd) };
	}

	async #resolveDestination(rawPath: string): Promise<CopyEndpoint> {
		const raw = normalizeCopyPath(rawPath);
		if (isSshUrl(raw)) return this.#resolveSshEndpoint(raw);
		if (isInternalUrlPath(raw) && !isWritableInternalDestination(raw)) {
			throw new ToolError(`copy destination must be a local path, local://, vault://, or ssh:// path: ${raw}`);
		}
		return { kind: "local", raw, path: resolvePlanPath(this.session, raw) };
	}

	async #readLocal(endpoint: Extract<CopyEndpoint, { kind: "local" }>, signal?: AbortSignal): Promise<Uint8Array> {
		const stat = await fs.stat(endpoint.path);
		if (!stat.isFile()) throw new ToolError(`copy source is not a regular file: ${endpoint.raw}`);
		if (stat.size > COPY_MAX_BYTES) {
			throw new ToolError(`copy source exceeds ${formatLimit()}: ${endpoint.raw}`);
		}
		return await untilAborted(signal, () => Bun.file(endpoint.path).bytes());
	}

	async #readRemote(
		endpoint: Extract<CopyEndpoint, { kind: "ssh" }>,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<Uint8Array> {
		await assertRemoteRegularFile(endpoint, signal);
		const result = await readRemoteFile(endpoint.target, endpoint.remotePath, {
			maxBytes: COPY_MAX_BYTES,
			timeoutMs,
			signal,
		});
		if (result.truncated) {
			throw new ToolError(`copy source exceeds ${formatLimit()}: ${endpoint.raw}`);
		}
		return result.bytes;
	}

	async #readBytes(endpoint: CopyEndpoint, timeoutMs: number, signal?: AbortSignal): Promise<Uint8Array> {
		return endpoint.kind === "local"
			? await this.#readLocal(endpoint, signal)
			: await this.#readRemote(endpoint, timeoutMs, signal);
	}

	async #writeLocal(endpoint: Extract<CopyEndpoint, { kind: "local" }>, bytes: Uint8Array): Promise<void> {
		let op: "create" | "update" = "create";
		try {
			const stat = await fs.stat(endpoint.path);
			if (stat.isDirectory()) throw new ToolError(`copy destination is a directory: ${endpoint.raw}`);
			if (!stat.isFile()) throw new ToolError(`copy destination is not a regular file: ${endpoint.raw}`);
			op = "update";
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		enforcePlanModeWrite(this.session, endpoint.raw, { op });
		await Bun.write(endpoint.path, bytes);
		invalidateFsScanAfterWrite(endpoint.path);
		this.session.bumpFileMutationVersion?.(endpoint.path);
	}

	async #writeBytes(
		endpoint: CopyEndpoint,
		bytes: Uint8Array,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<void> {
		if (endpoint.kind === "local") {
			await this.#writeLocal(endpoint, bytes);
			return;
		}
		enforcePlanModeWrite(this.session, endpoint.raw, { op: "update" });
		await writeRemoteFile(endpoint.target, endpoint.remotePath, bytes, { timeoutMs, signal });
	}

	async execute(_id: string, params: CopyParams, signal?: AbortSignal): Promise<AgentToolResult<CopyToolDetails>> {
		return untilAborted(signal, async () => {
			const timeoutMs = clampTimeout("copy", params.timeout) * 1000;
			const source = await this.#resolveSource(params.source, signal);
			const destination = await this.#resolveDestination(params.destination);
			const bytes = await this.#readBytes(source, timeoutMs, signal);
			await this.#writeBytes(destination, bytes, timeoutMs, signal);
			const sourceLabel = endpointLabel(source, this.session.cwd);
			const destinationLabel = endpointLabel(destination, this.session.cwd);
			return {
				content: [
					{ type: "text", text: `Copied ${bytes.length} bytes from ${sourceLabel} to ${destinationLabel}` },
				],
				details: { bytes: bytes.length, source: sourceLabel, destination: destinationLabel },
			};
		});
	}
}
