import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcEvalCompleteFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import {
	createIsolatedRpcProcessRoot,
	RawRpcProcess,
	type RpcProcessFrame,
	removeIsolatedRpcProcessRoot,
} from "./helpers/rpc-v3-process-harness";

const repositoryRoot = path.resolve(import.meta.dir, "../../..");

async function resolveConformanceBinary(configuredBinary: string | undefined): Promise<string | undefined> {
	if (!configuredBinary) return undefined;
	const resolvedBinary = path.resolve(configuredBinary);
	let binaryStat: fs.Stats;
	try {
		binaryStat = await fs.promises.stat(resolvedBinary);
	} catch (cause) {
		throw new Error(`OMP_RPC_CONFORMANCE_BIN does not exist: ${resolvedBinary}`, { cause });
	}
	if (!binaryStat.isFile()) {
		throw new Error(`OMP_RPC_CONFORMANCE_BIN is not a regular file: ${resolvedBinary}`);
	}
	try {
		await fs.promises.access(resolvedBinary, fs.constants.X_OK);
	} catch (cause) {
		throw new Error(`OMP_RPC_CONFORMANCE_BIN is not executable: ${resolvedBinary}`, { cause });
	}
	const binaryPath = await fs.promises.realpath(resolvedBinary);
	if (!path.isAbsolute(binaryPath)) throw new Error(`Resolved conformance binary is not absolute: ${binaryPath}`);

	let newestBuildInput: { path: string; mtimeMs: number } | undefined;
	for (const pattern of ["packages/*/src/**/*", "packages/coding-agent/scripts/**/*"]) {
		const glob = new Bun.Glob(pattern);
		for await (const candidate of glob.scan({ cwd: repositoryRoot, absolute: true, onlyFiles: true })) {
			const basename = path.basename(candidate);
			if (
				basename.includes(".generated.") ||
				basename === "embedded-client.generated.txt" ||
				basename === "mupdf-wasm-embed.ts" ||
				basename === "native-embed.ts"
			) {
				continue;
			}
			const stat = await fs.promises.stat(candidate);
			if (!newestBuildInput || stat.mtimeMs > newestBuildInput.mtimeMs) {
				newestBuildInput = { path: candidate, mtimeMs: stat.mtimeMs };
			}
		}
	}
	if (newestBuildInput && binaryStat.mtimeMs < newestBuildInput.mtimeMs) {
		throw new Error(
			`OMP_RPC_CONFORMANCE_BIN is stale: ${path.relative(repositoryRoot, newestBuildInput.path)} is newer; rebuild the binary before running conformance`,
		);
	}
	return binaryPath;
}

const binaryPath = (await resolveConformanceBinary(Bun.env.OMP_RPC_CONFORMANCE_BIN?.trim())) ?? "";

const PROFILE = { name: "omp.session", major: 3, minMinor: 0, maxMinor: 0 } as const;
const HOST_CAPABILITIES = {
	interactions: ["confirm", "approval", "ask", "progress", "notification"],
	semanticContent: ["text", "markdown", "fields", "table", "tree", "diff", "form", "action"],
} as const;
const CORE_CAPABILITIES = ["session.observe", "session.execute", "session.shutdown"] as const;

function record(value: unknown, description: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${description} is not an object`);
	return value as Record<string, unknown>;
}

function array(value: unknown, description: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${description} is not an array`);
	return value;
}

function responseData(frame: RpcProcessFrame, command: string): Record<string, unknown> {
	expect(frame).toMatchObject({ type: "response", command, success: true });
	return record(frame.data, `${command} response data`);
}

function readyManifest(process: RawRpcProcess): Record<string, unknown> {
	const ready = process.logicalFrames.find(frame => frame.type === "ready");
	return record(ready?.capabilities, "ready capabilities");
}

function supportedSemanticCapabilityIds(manifest: Record<string, unknown>): string[] {
	const sessionHost = record(manifest.sessionHost, "sessionHost manifest");
	return array(sessionHost.capabilities, "sessionHost capabilities")
		.map(value => record(value, "sessionHost capability"))
		.filter(capability => capability.supported === true)
		.map(capability => capability.id)
		.filter((id): id is string => typeof id === "string");
}

async function initializeRaw(
	process: RawRpcProcess,
	framingVersion = 1,
	additionalCapabilities: readonly string[] = [],
): Promise<Record<string, unknown>> {
	const manifest = readyManifest(process);
	const supportedCapabilities = supportedSemanticCapabilityIds(manifest);
	const requestedCapabilities = [...supportedCapabilities, ...additionalCapabilities];
	for (const capability of CORE_CAPABILITIES) expect(requestedCapabilities).toContain(capability);
	const response = await process.request({
		id: `initialize-v${framingVersion}`,
		type: "initialize",
		profile: PROFILE,
		framingVersion,
		hostCapabilities: HOST_CAPABILITIES,
		requestedCapabilities,
	});
	const data = responseData(response, "initialize");
	expect(data).toMatchObject({ ok: true, profile: { name: "omp.session", major: 3, minor: 0 }, framingVersion });
	const negotiated = array(data.capabilities, "negotiated capabilities").map(value => record(value, "capability"));
	for (const capability of supportedCapabilities) {
		expect(negotiated).toContainEqual(expect.objectContaining({ id: capability, supported: true }));
	}
	return data;
}

type ObservedFrame = Readonly<Record<string, unknown>>;

class ObservableFrameLog extends Array<ObservedFrame> {
	readonly #waiters = new Set<{
		from: number;
		predicate(frame: ObservedFrame): boolean;
		resolve(frame: ObservedFrame): void;
		timer: NodeJS.Timeout;
	}>();

	override push(...items: ObservedFrame[]): number {
		const firstNewIndex = this.length;
		const length = super.push(...items);
		for (const waiter of Array.from(this.#waiters)) {
			for (let index = Math.max(waiter.from, firstNewIndex); index < this.length; index++) {
				const frame = this[index];
				if (!frame || !waiter.predicate(frame)) continue;
				clearTimeout(waiter.timer);
				this.#waiters.delete(waiter);
				waiter.resolve(frame);
				break;
			}
		}
		return length;
	}

	waitFor(
		predicate: (frame: ObservedFrame) => boolean,
		description: string,
		options: { from?: number; timeoutMs?: number } = {},
	): Promise<ObservedFrame> {
		const from = options.from ?? 0;
		for (let index = from; index < this.length; index++) {
			const frame = this[index];
			if (frame && predicate(frame)) return Promise.resolve(frame);
		}
		const timeoutMs = options.timeoutMs ?? 15_000;
		const { promise, resolve, reject } = Promise.withResolvers<ObservedFrame>();
		const waiter = {
			from,
			predicate,
			resolve,
			// A real process can fail to emit; fake time cannot bound external I/O.
			timer: setTimeout(() => {
				this.#waiters.delete(waiter);
				reject(new Error(`Timed out waiting for ${description}; last frames: ${JSON.stringify(this.slice(-8))}`));
			}, timeoutMs),
		};
		this.#waiters.add(waiter);
		return promise;
	}
}

function waitForArrayFrame(
	frames: ObservableFrameLog,
	predicate: (frame: ObservedFrame) => boolean,
	description: string,
	options: { from?: number; timeoutMs?: number } = {},
): Promise<ObservedFrame> {
	return frames.waitFor(predicate, description, options);
}

async function reconstructArtifact(client: RpcClient, artifactId: string): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let offset = 0;
	for (;;) {
		const range = await client.readArtifact(artifactId, { offset, length: 32_767 });
		const chunk = Uint8Array.from(Buffer.from(range.data, "base64"));
		expect(range.offset).toBe(offset);
		expect(range.byteLength).toBe(chunk.byteLength);
		chunks.push(chunk);
		offset += chunk.byteLength;
		if (range.eof) break;
		expect(chunk.byteLength).toBeGreaterThan(0);
	}
	const result = new Uint8Array(offset);
	let cursor = 0;
	for (const chunk of chunks) {
		result.set(chunk, cursor);
		cursor += chunk.byteLength;
	}
	return result;
}

const nativeAskProviderFixture = path.join(import.meta.dir, "fixtures", "rpc-v3-process-provider.ts");
const nativeAskArgs = [
	"--extension",
	nativeAskProviderFixture,
	"--model",
	"rpc-process/rpc-native-ask",
	"--api-key",
	"rpc-process-key",
	"--tools",
	"ask",
] as const;

interface ScheduledNativeAsk {
	from: number;
	operationId: string;
	request: RpcProcessFrame;
}

async function scheduleNativeAsk(process: RawRpcProcess, requestId: string): Promise<ScheduledNativeAsk> {
	const from = process.logicalFrames.length;
	const scheduled = responseData(
		await process.request({
			id: requestId,
			type: "prompt",
			message: "exercise the official native AskTool",
		}),
		"prompt",
	);
	const operationId = String(scheduled.operationId);
	const request = await process.waitFor(
		frame =>
			frame.type === "extension_ui_request" &&
			frame.method === "ask" &&
			array(frame.questions, "native Ask questions").some(
				question => record(question, "native Ask question").id === "native-ask-question",
			),
		{ from, description: "official native AskTool request" },
	);
	return { from, operationId, request };
}

async function answerNativeAsk(process: RawRpcProcess, request: RpcProcessFrame): Promise<void> {
	process.write({
		type: "extension_ui_response",
		id: request.id,
		result: {
			kind: "submit",
			results: [
				{
					id: "native-ask-question",
					question: "Choose the native AskTool answer",
					options: ["native-ask-answer", "wrong-answer"],
					multi: false,
					selectedOptions: ["native-ask-answer"],
				},
			],
		},
	});
	await process.flush();
}

let pythonEnvironmentRoot: string | undefined;

afterAll(async () => {
	if (pythonEnvironmentRoot) await fs.promises.rm(pythonEnvironmentRoot, { recursive: true, force: true });
});

describe.skipIf(binaryPath.length === 0)("RPC v3 explicit native-binary process conformance", () => {
	test("raw JSONL manifest, semantic negotiation, unsupported capability, and every required v3 ID", async () => {
		const process = await RawRpcProcess.start(binaryPath);
		try {
			const manifestResponse = await process.request({ id: "manifest", type: "get_capabilities" });
			const manifest = responseData(manifestResponse, "get_capabilities");
			expect(manifest).toEqual(readyManifest(process));

			const negotiation = await initializeRaw(process, 1, ["rpc.future.unsupported"]);
			expect(structuredClone(array(negotiation.capabilities, "negotiated capabilities"))).toContainEqual(
				expect.objectContaining({
					id: "rpc.future.unsupported",
					version: 0,
					supported: false,
					unsupportedReason: {
						code: "unknown_capability",
						message: "Capability is not advertised",
					},
				}),
			);
			expect((await process.request({ id: "alive-after-negotiation", type: "get_capabilities" })).success).toBe(
				true,
			);
			const commandCapabilities = array(manifest.commands, "command manifest").map(value =>
				record(value, "command capability"),
			);
			const requiredIdCommands = commandCapabilities.filter(command => {
				if (command.version !== 3) return false;
				const schema = record(command.inputSchema, `${String(command.name)} input schema`);
				return array(schema.required, `${String(command.name)} required fields`).includes("id");
			});
			expect(requiredIdCommands.length).toBeGreaterThan(0);
			for (const capability of requiredIdCommands) {
				const name = capability.name;
				if (typeof name !== "string") throw new Error("Command capability name is not a string");
				const schema = record(capability.inputSchema, `${name} input schema`);
				const properties = record(schema.properties, `${name} input properties`);
				const command: Record<string, unknown> = { type: name };
				for (const field of array(schema.required, `${name} required fields`)) {
					if (field === "type" || field === "id" || typeof field !== "string") continue;
					const fieldSchema = record(properties[field], `${name}.${field} schema`);
					if (!("example" in fieldSchema)) throw new Error(`Required ${name}.${field} has no manifest example`);
					command[field] = fieldSchema.example;
				}
				const from = process.logicalFrames.length;
				process.write(command);
				await process.flush();
				const failure = await process.waitFor(
					frame => frame.type === "response" && frame.command === name && frame.success === false,
					{ from, description: `${name} missing-ID rejection` },
				);
				expect(failure).toMatchObject({ command: name, success: false, code: "invalid_request" });
				expect(failure.error).toContain('field "id" is required');
			}

			const future = await process.request({
				id: "future-command",
				type: "rpc_v99_future",
				futurePayload: { preserve: [1, null, "x"] },
			});
			expect(future).toMatchObject({
				id: "future-command",
				type: "response",
				command: "rpc_v99_future",
				success: false,
				code: "unsupported_command",
			});
			expect(process.logicalFrames).toContainEqual(future);
			const unknownField = await process.request({
				id: "unknown-field",
				type: "get_capabilities",
				futureField: { nested: true },
			});
			expect(unknownField).toMatchObject({
				id: "unknown-field",
				type: "response",
				command: "get_capabilities",
				success: false,
				code: "invalid_request",
			});
			expect((await process.request({ id: "alive-after-future", type: "get_capabilities" })).success).toBe(true);

			const invalidNested = responseData(
				await process.request({
					id: "nested-invalid-result",
					type: "session_invoke",
					command: { kind: "get_state" },
				}),
				"session_invoke",
			);
			expect(invalidNested).toMatchObject({
				outcome: "failed",
				error: { code: "invalid_command_result" },
			});
			const nested = responseData(
				await process.request({
					id: "nested-concurrent",
					type: "session_invoke",
					command: { kind: "set_session_name", input: { name: "nested-command-proof" } },
				}),
				"session_invoke",
			);
			expect(nested).toMatchObject({ outcome: "completed", revision: expect.any(Number) });
			const recursive = await process.request({
				id: "nested-recursive",
				type: "session_invoke",
				command: { kind: "session_open" },
			});
			expect(responseData(recursive, "session_invoke")).toMatchObject({
				outcome: "failed",
				error: { code: "unsupported_session_command" },
			});
		} finally {
			await process.dispose();
		}
	}, 45_000);

	test("raw subscriptions expose watermark, replay barrier, durable reconnect, typed gap, session isolation, and shared shutdown", async () => {
		const process = await RawRpcProcess.start(binaryPath);
		try {
			await initializeRaw(process);
			const firstOpenFrame = await process.request({ id: "open-1", type: "session_open", snapshot: true });
			const firstOpen = responseData(firstOpenFrame, "session_open");
			expect(structuredClone(firstOpen)).toMatchObject({
				subscriptionId: expect.any(String),
				replayComplete: true,
				durableCursor: expect.any(Object),
				watermark: { epoch: expect.any(String), sequence: expect.any(Number) },
				snapshot: { sessionId: expect.any(String), journalCursor: expect.any(Object) },
			});
			const firstSubscription = String(firstOpen.subscriptionId);
			const watermark = record(firstOpen.watermark, "first watermark");
			const liveFrom = process.logicalFrames.length;
			expect(
				responseData(
					await process.request({
						id: "mutate-live",
						type: "session_invoke",
						command: {
							kind: "set_session_name",
							input: { name: "raw-live-observation" },
							idempotencyKey: "raw-live-mutation",
						},
					}),
					"session_invoke",
				),
			).toMatchObject({ outcome: "completed", revision: expect.any(Number) });
			const liveFrame = await process.waitFor(
				frame => {
					if (frame.type !== "session_observation" || frame.subscriptionId !== firstSubscription) return false;
					const observation = record(frame.observation, "live observation");
					return observation.type === "observation" && observation.replay === false;
				},
				{ from: liveFrom, description: "post-barrier live observation" },
			);
			const live = record(liveFrame.observation, "live observation");
			expect(live.epoch).toBe(watermark.epoch);
			expect(live.sequence).toBeGreaterThan(Number(watermark.sequence));

			const replayFrom = process.logicalFrames.length;
			const reconnectFrame = await process.request({
				id: "reconnect",
				type: "session_open",
				snapshot: false,
				afterCursor: firstOpen.durableCursor,
			});
			const reconnect = responseData(reconnectFrame, "session_open");
			expect("snapshot" in reconnect).toBe(false);
			expect(structuredClone(reconnect)).toMatchObject({
				replayComplete: true,
				durableCursor: expect.any(Object),
				watermark: expect.any(Object),
			});
			const reconnectIndex = process.logicalFrames.indexOf(reconnectFrame);
			const replay = process.logicalFrames
				.slice(replayFrom, reconnectIndex)
				.filter(frame => frame.type === "session_observation" && frame.subscriptionId === reconnect.subscriptionId)
				.map(frame => record(frame.observation, "replayed observation"))
				.filter(observation => observation.type === "observation");
			expect(replay.length).toBeGreaterThan(0);
			expect(replay.every(observation => observation.replay === true)).toBe(true);

			const gapFrom = process.logicalFrames.length;
			const futureOpen = await process.request({
				id: "future-position",
				type: "session_open",
				snapshot: false,
				after: { epoch: watermark.epoch, sequence: Number(live.sequence) + 1_000_000 },
			});
			const futureData = responseData(futureOpen, "session_open");
			const gapFrame = await process.waitFor(
				frame => frame.type === "session_observation" && frame.subscriptionId === futureData.subscriptionId,
				{ from: gapFrom, description: "future cursor gap" },
			);
			expect(gapFrame.observation).toMatchObject({ type: "gap", recovery: "resnapshot" });

			const transitionFrom = process.logicalFrames.length;
			const transition = responseData(
				await process.request({ id: "new-session", type: "new_session" }),
				"new_session",
			);
			expect(transition).toMatchObject({ cancelled: expect.any(Boolean) });
			const secondOpen = responseData(
				await process.request({ id: "open-2", type: "session_open", snapshot: true }),
				"session_open",
			);
			const firstSnapshot = record(firstOpen.snapshot, "first snapshot");
			const secondSnapshot = record(secondOpen.snapshot, "second snapshot");
			expect(secondSnapshot.sessionId).not.toBe(firstSnapshot.sessionId);
			for (const frame of process.logicalFrames.slice(transitionFrom)) {
				if (frame.type !== "session_observation" || frame.subscriptionId !== firstSubscription) continue;
				const observation = record(frame.observation, "old subscription observation");
				expect(observation.sessionId).not.toBe(secondSnapshot.sessionId);
			}

			const shutdownFrom = process.logicalFrames.length;
			process.write({ id: "shutdown-a", type: "session_shutdown" });
			process.write({ id: "shutdown-b", type: "session_shutdown" });
			await process.flush();
			const [shutdownA, shutdownB] = await Promise.all([
				process.waitFor(frame => frame.type === "response" && frame.id === "shutdown-a", {
					from: shutdownFrom,
					description: "first shared shutdown",
				}),
				process.waitFor(frame => frame.type === "response" && frame.id === "shutdown-b", {
					from: shutdownFrom,
					description: "second shared shutdown",
				}),
			]);
			const shutdownResponses = [shutdownA, shutdownB];
			const settledShutdown = shutdownResponses.find(frame => frame.success === true);
			const rejectedShutdown = shutdownResponses.find(frame => frame.success === false);
			if (!settledShutdown || !rejectedShutdown)
				throw new Error("Concurrent shutdown did not settle exactly one caller");
			expect(responseData(settledShutdown, "session_shutdown")).toEqual({ state: "settled" });
			expect(rejectedShutdown).toMatchObject({
				type: "response",
				command: "session_shutdown",
				success: false,
				code: "session_closing",
			});
			const finalObservation = await process.waitFor(
				frame => {
					if (frame.type !== "session_observation" || frame.subscriptionId !== secondOpen.subscriptionId)
						return false;
					const observation = record(frame.observation, "final shutdown observation");
					return observation.type === "observation" && observation.kind === "session_settled";
				},
				{ from: shutdownFrom, description: "final shutdown observation" },
			);
			const finalObservationIndex = process.logicalFrames.indexOf(finalObservation);
			expect(finalObservationIndex).toBeLessThan(process.logicalFrames.indexOf(settledShutdown));
			const exitCode = await process.waitForExit();
			expect(exitCode, process.stderr).toBe(0);
			for (const id of ["shutdown-a", "shutdown-b"]) {
				expect(process.logicalFrames.filter(frame => frame.type === "response" && frame.id === id)).toHaveLength(1);
			}
			expect(process.logicalFrames.at(-1)).toMatchObject({
				type: "response",
				command: "session_shutdown",
				success: true,
				data: { state: "settled" },
			});
		} finally {
			await process.dispose();
		}
	}, 45_000);

	test("raw framing v2 reassembles chunked output without changing content or ordering", async () => {
		const fixture = path.join(import.meta.dir, "fixtures", "rpc-v3-process-interactions.ts");
		const process = await RawRpcProcess.start(binaryPath, { args: ["--extension", fixture] });
		try {
			const negotiation = await process.request({
				id: "framing-v2",
				type: "negotiate_protocol",
				protocolVersion: 2,
			});
			expect(responseData(negotiation, "negotiate_protocol")).toEqual({ protocolVersion: 2 });
			await initializeRaw(process, 2);
			const content = `framing-boundary:${"x".repeat(1_200_000)}`;
			const physicalFrom = process.physicalFrames.length;
			const logicalFrom = process.logicalFrames.length;
			responseData(
				await process.request({ id: "large-frame-command", type: "prompt", message: "/rpc-process-large-frame" }),
				"prompt",
			);
			const notification = await process.waitFor(
				frame => frame.type === "extension_ui_request" && frame.method === "notify",
				{ from: logicalFrom, description: "large notification frame", timeoutMs: 30_000 },
			);
			const chunks = process.physicalFrames.slice(physicalFrom).filter(frame => frame.type === "rpc_chunk");
			expect(chunks.length).toBeGreaterThan(1);
			expect(chunks.map(chunk => chunk.index)).toEqual(chunks.map((_, index) => index));
			expect(notification.message).toBe(content);
		} finally {
			await process.dispose();
		}
	}, 60_000);

	test("ordinary rpc stays headless while rpc-ui advertises and activates the official native AskTool", async () => {
		const [headless, interactive] = await Promise.all([
			RawRpcProcess.start(binaryPath, { args: ["--tools", "ask"] }),
			RawRpcProcess.start(binaryPath, { args: ["--tools", "ask"], mode: "rpc-ui" }),
		]);
		try {
			await Promise.all([initializeRaw(headless), initializeRaw(interactive)]);
			const [headlessInventory, interactiveInventory] = await Promise.all([
				headless.request({ id: "headless-inventory", type: "get_tool_inventory" }),
				interactive.request({ id: "interactive-inventory", type: "get_tool_inventory" }),
			]);
			const headlessTools = array(
				responseData(headlessInventory, "get_tool_inventory").tools,
				"headless tool inventory",
			).map(tool => record(tool, "headless tool"));
			const interactiveTools = array(
				responseData(interactiveInventory, "get_tool_inventory").tools,
				"interactive tool inventory",
			).map(tool => record(tool, "interactive tool"));

			expect(headlessTools.find(tool => tool.name === "ask")).toBeUndefined();
			expect(interactiveTools.filter(tool => tool.name !== "ask")).toEqual(headlessTools);
			expect(interactiveTools.find(tool => tool.name === "ask")).toMatchObject({
				name: "ask",
				presentation: "active",
				source: { kind: "builtin" },
				parameters: expect.objectContaining({ type: "object" }),
			});
		} finally {
			await Promise.all([headless.dispose(), interactive.dispose()]);
		}
	}, 45_000);

	test("raw rpc-ui carries official AskTool provider call through the typed request and same tool result", async () => {
		const process = await RawRpcProcess.start(binaryPath, {
			args: nativeAskArgs,
			mode: "rpc-ui",
			useDefaultModel: false,
		});
		try {
			await initializeRaw(process);
			const scheduled = await scheduleNativeAsk(process, "native-ask-accepted");
			await answerNativeAsk(process, scheduled.request);
			expect(
				await process.waitFor(
					frame =>
						frame.type === "interaction_settled" &&
						frame.id === scheduled.request.id &&
						record(frame.outcome, "native Ask outcome").state === "accepted",
					{ from: scheduled.from, description: "accepted native Ask settlement" },
				),
			).toMatchObject({ method: "ask", outcome: { state: "accepted" } });
			const toolResult = await process.waitFor(
				frame =>
					frame.type === "tool_execution_end" &&
					frame.toolCallId === "rpc-native-ask-call" &&
					frame.toolName === "ask",
				{ from: scheduled.from, description: "native Ask tool result" },
			);
			expect(JSON.stringify(toolResult)).toContain("native-ask-answer");
			expect(
				await process.waitFor(
					frame => frame.type === "message_end" && JSON.stringify(frame.message).includes("native-ask-verified:"),
					{ from: scheduled.from, description: "provider verification of native Ask result" },
				),
			).toBeDefined();
			await process.waitFor(
				frame => frame.type === "operation_completed" && frame.operationId === scheduled.operationId,
				{ from: scheduled.from, description: "native Ask operation completion" },
			);
		} finally {
			await process.dispose();
		}
	}, 45_000);

	test("raw rpc-ui cancellation settles native AskTool and its owning operation exactly once", async () => {
		const process = await RawRpcProcess.start(binaryPath, {
			args: nativeAskArgs,
			mode: "rpc-ui",
			useDefaultModel: false,
		});
		try {
			await initializeRaw(process);
			const scheduled = await scheduleNativeAsk(process, "native-ask-cancel");
			await process.request({
				id: "cancel-native-ask",
				type: "cancel_operation",
				operationId: scheduled.operationId,
			});
			await process.waitFor(
				frame =>
					frame.type === "interaction_settled" &&
					frame.id === scheduled.request.id &&
					record(frame.outcome, "cancelled native Ask outcome").state === "cancelled",
				{ from: scheduled.from, description: "cancelled native Ask settlement" },
			);
			await process.waitFor(
				frame => frame.type === "operation_cancelled" && frame.operationId === scheduled.operationId,
				{ from: scheduled.from, description: "cancelled native Ask operation" },
			);
			expect(
				process.logicalFrames
					.slice(scheduled.from)
					.filter(
						frame =>
							frame.operationId === scheduled.operationId &&
							["operation_completed", "operation_cancelled", "operation_failed"].includes(String(frame.type)),
					),
			).toHaveLength(1);
		} finally {
			await process.dispose();
		}
	}, 45_000);

	test("raw rpc-ui timeout settles native AskTool and records its explicit error on the same tool call", async () => {
		const process = await RawRpcProcess.start(binaryPath, {
			args: nativeAskArgs,
			mode: "rpc-ui",
			useDefaultModel: false,
			prepare: async root => {
				await Bun.write(
					path.join(root.home, ".omp", "agent", "settings.json"),
					JSON.stringify({ ask: { timeout: 0.05, notify: "off" }, speech: { enabled: false } }),
				);
			},
		});
		try {
			await initializeRaw(process);
			const scheduled = await scheduleNativeAsk(process, "native-ask-timeout");
			await process.waitFor(
				frame =>
					frame.type === "interaction_settled" &&
					frame.id === scheduled.request.id &&
					record(frame.outcome, "timed out native Ask outcome").state === "timed_out",
				{ from: scheduled.from, description: "timed out native Ask settlement" },
			);
			const toolResult = await process.waitFor(
				frame =>
					frame.type === "tool_execution_end" &&
					frame.toolCallId === "rpc-native-ask-call" &&
					frame.toolName === "ask",
				{ from: scheduled.from, description: "timed out native Ask tool result" },
			);
			expect(toolResult).toMatchObject({ isError: true });
			expect(JSON.stringify(toolResult)).toContain("Ask tool was cancelled by the user");
			await process.waitFor(
				frame =>
					frame.type === "agent_end" &&
					JSON.stringify(frame.messages).includes("rpc-native-ask-call") &&
					JSON.stringify(frame.messages).includes("Ask tool was cancelled by the user"),
				{ from: scheduled.from, description: "timed out native Ask result in terminal history" },
			);
			await process.waitFor(
				frame => frame.type === "operation_completed" && frame.operationId === scheduled.operationId,
				{ from: scheduled.from, description: "timed out native Ask operation completion" },
			);
		} finally {
			await process.dispose();
		}
	}, 45_000);

	test("raw rpc-ui authority transition cancels native AskTool before replacing the session", async () => {
		const process = await RawRpcProcess.start(binaryPath, {
			args: nativeAskArgs,
			mode: "rpc-ui",
			useDefaultModel: false,
		});
		try {
			await initializeRaw(process);
			const scheduled = await scheduleNativeAsk(process, "native-ask-transition");
			const transition = process.request({ id: "transition-during-native-ask", type: "new_session" }, 30_000);
			await process.waitFor(
				frame =>
					frame.type === "interaction_settled" &&
					frame.id === scheduled.request.id &&
					record(frame.outcome, "transition native Ask outcome").state === "cancelled",
				{ from: scheduled.from, description: "native Ask settlement during authority transition" },
			);
			expect(responseData(await transition, "new_session")).toMatchObject({ cancelled: false });
			await process.waitFor(
				frame => frame.type === "operation_cancelled" && frame.operationId === scheduled.operationId,
				{ from: scheduled.from, description: "native Ask operation cancelled by transition" },
			);
		} finally {
			await process.dispose();
		}
	}, 45_000);

	test("raw rpc-ui disconnect settles native AskTool before the native process exits", async () => {
		const process = await RawRpcProcess.start(binaryPath, {
			args: nativeAskArgs,
			mode: "rpc-ui",
			useDefaultModel: false,
		});
		try {
			await initializeRaw(process);
			const scheduled = await scheduleNativeAsk(process, "native-ask-disconnect");
			process.endInput();
			await process.waitFor(
				frame =>
					frame.type === "interaction_settled" &&
					frame.id === scheduled.request.id &&
					record(frame.outcome, "disconnected native Ask outcome").state === "disconnected",
				{ from: scheduled.from, description: "native Ask settlement on disconnect" },
			);
			expect(await process.waitForExit(30_000)).toBe(0);
		} finally {
			await process.dispose();
		}
	}, 45_000);

	test("raw JSONL settles negotiated progress, approval, and ask interactions", async () => {
		const fixture = path.join(import.meta.dir, "fixtures", "rpc-v3-process-interactions.ts");
		const process = await RawRpcProcess.start(binaryPath, { args: ["--extension", fixture] });
		try {
			await initializeRaw(process);
			const from = process.logicalFrames.length;
			const promptResponse = process.request({
				id: "interaction-command",
				type: "prompt",
				message: "/rpc-process-interactions",
			});
			expect(
				await process.waitFor(
					frame =>
						frame.type === "extension_ui_request" &&
						frame.method === "progress" &&
						frame.message === "process-progress",
					{ from, description: "raw progress interaction" },
				),
			).toMatchObject({ method: "progress", message: "process-progress" });
			const approval = await process.waitFor(
				frame => frame.type === "extension_ui_request" && frame.method === "approval",
				{ from, description: "raw approval interaction" },
			);
			expect(structuredClone(approval)).toMatchObject({
				id: expect.any(String),
				toolCallId: "process-tool-call",
				toolName: "process-fixture",
				operation: "write",
			});
			process.write({
				type: "extension_ui_response",
				id: approval.id,
				decision: "approve",
				provenance: "user",
			});
			await process.flush();
			const ask = await process.waitFor(frame => frame.type === "extension_ui_request" && frame.method === "ask", {
				from,
				description: "raw ask interaction",
			});
			expect(structuredClone(ask)).toMatchObject({
				id: expect.any(String),
				questions: [
					expect.objectContaining({
						id: "process-question",
						question: "Choose",
					}),
				],
			});
			process.write({
				type: "extension_ui_response",
				id: ask.id,
				result: {
					kind: "submit",
					results: [
						{
							id: "process-question",
							question: "Choose",
							options: ["A", "B"],
							multi: false,
							selectedOptions: ["A"],
						},
					],
				},
			});
			await process.flush();
			expect(responseData(await promptResponse, "prompt")).toBeDefined();
			for (const interaction of [approval, ask]) {
				expect(
					await process.waitFor(
						frame =>
							frame.type === "interaction_settled" &&
							frame.id === interaction.id &&
							record(frame.outcome, "interaction outcome").state === "accepted",
						{ from, description: `${String(interaction.method)} settlement` },
					),
				).toMatchObject({ method: interaction.method, outcome: { state: "accepted" } });
			}
		} finally {
			await process.dispose();
		}
	}, 30_000);

	test("raw JSONL cancels queued and active prompt implementations exactly once", async () => {
		const fixture = path.join(import.meta.dir, "fixtures", "rpc-v3-process-provider.ts");
		const process = await RawRpcProcess.start(binaryPath, {
			args: ["--extension", fixture, "--model", "rpc-process/rpc-hold", "--api-key", "rpc-process-key"],
			useDefaultModel: false,
		});
		try {
			await initializeRaw(process);
			const from = process.logicalFrames.length;
			const active = responseData(
				await process.request({
					id: "active-provider-command",
					type: "prompt",
					message: "hold the active provider stream",
				}),
				"prompt",
			);
			const activeOperationId = String(active.operationId);
			await process.waitFor(frame => frame.type === "agent_start", {
				from,
				description: "active provider stream",
			});
			const queued = responseData(
				await process.request({
					id: "queued-prompt-command",
					type: "prompt",
					message: "must remain queued until cancelled",
					streamingBehavior: "followUp",
				}),
				"prompt",
			);
			const queuedOperationId = String(queued.operationId);
			await process.waitFor(
				frame => {
					if (frame.type !== "queue_update" || !frame.queue || typeof frame.queue !== "object") return false;
					const queue = frame.queue as Record<string, unknown>;
					return ["steering", "followUp"].some(lane => {
						const entries = queue[lane];
						return (
							Array.isArray(entries) &&
							entries.some(
								entry =>
									entry !== null &&
									typeof entry === "object" &&
									(entry as Record<string, unknown>).operationId === queuedOperationId,
							)
						);
					});
				},
				{ from, description: "queued prompt ownership" },
			);

			await process.request({
				id: "cancel-queued-prompt",
				type: "cancel_operation",
				operationId: queuedOperationId,
			});
			await process.waitFor(
				frame => frame.type === "operation_cancelled" && frame.operationId === queuedOperationId,
				{ from, description: "queued prompt terminal" },
			);
			const queue = responseData(
				await process.request({ id: "queue-after-cancel", type: "get_queue" }),
				"get_queue",
			);
			expect(JSON.stringify(queue)).not.toContain(queuedOperationId);

			await process.request({
				id: "cancel-active-prompt",
				type: "cancel_operation",
				operationId: activeOperationId,
			});
			await process.waitFor(
				frame => frame.type === "operation_cancelled" && frame.operationId === activeOperationId,
				{ from, description: "active prompt terminal" },
			);
			await process.request({ id: "queued-cancel-shutdown", type: "session_shutdown" });
			for (const operationId of [queuedOperationId, activeOperationId]) {
				expect(
					process.logicalFrames
						.slice(from)
						.filter(
							frame =>
								frame.operationId === operationId &&
								["operation_completed", "operation_cancelled", "operation_failed"].includes(String(frame.type)),
						),
				).toHaveLength(1);
			}
		} finally {
			await process.dispose();
		}
	}, 60_000);

	test("controlled MCP fixture exposes prefixed resource lifecycle through the native process", async () => {
		const fixture = path.join(import.meta.dir, "fixtures", "resources-no-templates-mcp.ts");
		const process = await RawRpcProcess.start(binaryPath, {
			prepare: async root => {
				await fs.promises.writeFile(
					path.join(root.cwd, ".mcp.json"),
					JSON.stringify({
						mcpServers: {
							conformance: {
								type: "stdio",
								command: Bun.which("bun") ?? Bun.argv[0],
								args: [fixture],
							},
						},
					}),
				);
			},
		});
		try {
			await initializeRaw(process);
			let snapshot: Record<string, unknown> | undefined;
			let server: Record<string, unknown> | undefined;
			for (let attempt = 0; attempt < 32 && !server; attempt++) {
				snapshot = responseData(
					await process.request({ id: `resource-list-${attempt}`, type: "resource_list" }),
					"resource_list",
				);
				server = array(snapshot.servers, "resource servers")
					.map(value => record(value, "resource server"))
					.find(candidate => candidate.serverId === "mcp:conformance" && candidate.state === "connected");
			}
			expect(server).toMatchObject({
				serverId: "mcp:conformance",
				kind: "mcp",
				state: "connected",
			});
			const refresh = responseData(
				await process.request({ id: "resource-refresh", type: "resource_refresh", serverId: "mcp:conformance" }),
				"resource_refresh",
			);
			expect(structuredClone(refresh).operationId).toEqual(expect.any(String));
			const lifecycle = await process.waitFor(
				frame =>
					frame.type === "resource_operation" &&
					frame.operationId === refresh.operationId &&
					["completed", "cancelled", "failed"].includes(String(frame.outcome)),
				{ description: "MCP refresh terminal", timeoutMs: 20_000 },
			);
			expect(lifecycle).toMatchObject({
				kind: "refresh",
				serverIds: ["mcp:conformance"],
				operationId: refresh.operationId,
				outcome: "completed",
			});
			const disposed = responseData(
				await process.request({ id: "resource-dispose", type: "resource_dispose", serverId: "mcp:conformance" }),
				"resource_dispose",
			);
			expect(disposed).toMatchObject({ serverId: "mcp:conformance", kind: "mcp", state: "disabled" });
			const afterDispose = responseData(
				await process.request({ id: "resource-list-disposed", type: "resource_list" }),
				"resource_list",
			);
			expect(
				array(afterDispose.servers, "disposed resource servers")
					.map(value => record(value, "disposed resource server"))
					.find(candidate => candidate.serverId === "mcp:conformance"),
			).toMatchObject({ state: "disabled" });
			expect(
				responseData(
					await process.request({
						id: "resource-cancel-stale",
						type: "resource_cancel",
						operationId: String(refresh.operationId),
					}),
					"resource_cancel",
				),
			).toMatchObject({ cancelled: false });
			await process.request({ id: "resource-shutdown", type: "session_shutdown" });
		} finally {
			await process.dispose();
		}
	}, 60_000);

	test("bundled TypeScript RpcClient directly spawns the exact binary and preserves semantic process contracts", async () => {
		expect(() => new RpcClient({ executablePath: binaryPath, cliPath: "forbidden-second-authority" })).toThrow(
			"mutually exclusive",
		);
		const root = await createIsolatedRpcProcessRoot("omp-rpc-v3-ts-client-");
		const interactionFixture = path.join(import.meta.dir, "fixtures", "rpc-v3-process-interactions.ts");
		const rawFrames = new ObservableFrameLog();
		const interactions: Readonly<Record<string, unknown>>[] = [];
		let complete: RpcEvalCompleteFrame | undefined;
		const client = new RpcClient({
			executablePath: binaryPath,
			mode: "rpc-ui",
			cwd: root.cwd,
			env: { ...root.env, ANTHROPIC_API_KEY: "" },
			sessionDir: root.sessionDir,
			args: [
				"--extension",
				interactionFixture,
				"--extension",
				nativeAskProviderFixture,
				"--model",
				"rpc-process/rpc-native-ask",
				"--api-key",
				"rpc-process-key",
				"--tools",
				"ask",
			],
			rpcV3: {
				hostCapabilities: HOST_CAPABILITIES,
				requestedCapabilities: [...CORE_CAPABILITIES, "artifact.read", "context.projection"],
			},
		});
		client.onRawFrame(frame => rawFrames.push(frame));
		client.onEvalComplete(frame => {
			complete = frame;
		});
		client.onExtensionUiRequest(request => {
			interactions.push(request as unknown as Record<string, unknown>);
			if (request.method === "confirm") {
				client.sendUiConfirmation(request.id, true, request.operationId);
			} else if (request.method === "approval") {
				client.respondToExtensionUi({
					type: "extension_ui_response",
					id: request.id,
					decision: "approve",
					provenance: "user",
				});
			} else if (request.method === "ask") {
				const native = request.questions.some(question => question.id === "native-ask-question");
				client.respondToExtensionUi({
					type: "extension_ui_response",
					id: request.id,
					result: {
						kind: "submit",
						results: [
							{
								id: native ? "native-ask-question" : "process-question",
								question: native ? "Choose the native AskTool answer" : "Choose",
								options: native ? ["native-ask-answer", "wrong-answer"] : ["A", "B"],
								multi: false,
								selectedOptions: [native ? "native-ask-answer" : "A"],
							},
						],
					},
				});
			}
		});
		try {
			await client.start();
			expect(client.rpcV3Negotiation).toMatchObject({ ok: true, framingVersion: 2 });
			const manifest = await client.getCapabilities();
			expect(manifest.sessionHost?.capabilities).toEqual(
				expect.arrayContaining(CORE_CAPABILITIES.map(id => expect.objectContaining({ id, supported: true }))),
			);
			const initialState = await client.getState();
			const initialContext = await client.getContext();
			expect(initialContext.snapshot.sessionId).toBe(initialState.sessionId);
			const availableCommands = await client.getAvailableCommands();
			const inventory = await client.getToolInventory();
			expect(availableCommands.length).toBeGreaterThan(0);
			expect(inventory.tools.length).toBeGreaterThan(0);

			const interactionFrom = rawFrames.length;
			await client.prompt("/rpc-process-interactions");
			for (const method of ["progress", "approval", "ask"]) {
				await waitForArrayFrame(
					rawFrames,
					frame => frame.type === "extension_ui_request" && frame.method === method,
					`TypeScript ${method} interaction`,
					{ from: interactionFrom },
				);
				expect(interactions).toContainEqual(expect.objectContaining({ method }));
			}
			for (const method of ["approval", "ask"]) {
				await waitForArrayFrame(
					rawFrames,
					frame => {
						if (frame.type !== "interaction_settled" || frame.method !== method) return false;
						return record(frame.outcome, `${method} outcome`).state === "accepted";
					},
					`TypeScript ${method} settlement`,
					{ from: interactionFrom },
				);
			}
			const nativeAskFrom = rawFrames.length;
			const nativeAskOperation = await client.prompt("exercise the official native AskTool");
			if (!nativeAskOperation) throw new Error("TypeScript native Ask prompt omitted operation ownership");
			const nativeAskRequest = await waitForArrayFrame(
				rawFrames,
				frame =>
					frame.type === "extension_ui_request" &&
					frame.method === "ask" &&
					JSON.stringify(frame.questions).includes("native-ask-question"),
				"TypeScript native AskTool request",
				{ from: nativeAskFrom },
			);
			await waitForArrayFrame(
				rawFrames,
				frame =>
					frame.type === "interaction_settled" &&
					frame.id === nativeAskRequest.id &&
					record(frame.outcome, "TypeScript native Ask outcome").state === "accepted",
				"TypeScript native AskTool settlement",
				{ from: nativeAskFrom },
			);
			const nativeAskToolResult = await waitForArrayFrame(
				rawFrames,
				frame =>
					frame.type === "tool_execution_end" &&
					frame.toolCallId === "rpc-native-ask-call" &&
					frame.toolName === "ask",
				"TypeScript native AskTool result",
				{ from: nativeAskFrom },
			);
			expect(JSON.stringify(nativeAskToolResult)).toContain("native-ask-answer");
			await waitForArrayFrame(
				rawFrames,
				frame => frame.type === "message_end" && JSON.stringify(frame.message).includes("native-ask-verified:"),
				"TypeScript provider verification of native AskTool result",
				{ from: nativeAskFrom },
			);
			await waitForArrayFrame(
				rawFrames,
				frame => frame.type === "operation_completed" && frame.operationId === nativeAskOperation.operationId,
				"TypeScript native AskTool operation completion",
				{ from: nativeAskFrom },
			);
			const opened = await client.openSession({ snapshot: true });
			expect(structuredClone(opened)).toMatchObject({
				replayComplete: true,
				durableCursor: expect.any(Object),
				watermark: expect.any(Object),
				snapshot: expect.any(Object),
			});
			const observationFrom = rawFrames.length;
			const outcome = await client.invokeSession({
				kind: "set_session_name",
				input: { name: "typescript-live-observation" },
				idempotencyKey: "ts-client-live",
			});
			expect(outcome.outcome).toBe("completed");
			const live = await waitForArrayFrame(
				rawFrames,
				frame => {
					if (frame.type !== "session_observation" || frame.subscriptionId !== opened.subscriptionId) return false;
					const observation = record(frame.observation, "TS observation");
					return observation.type === "observation" && observation.replay === false;
				},
				"TypeScript post-barrier live observation",
				{ from: observationFrom },
			);
			const observation = record(live.observation, "TS live observation");
			expect(observation.sequence).toBeGreaterThan(opened.watermark?.sequence ?? -1);
			const reopened = await client.openSession({ snapshot: false, afterCursor: opened.durableCursor });
			expect(structuredClone(reopened)).toMatchObject({
				replayComplete: true,
				durableCursor: expect.any(Object),
				watermark: expect.any(Object),
			});
			expect(reopened.snapshot).toBeUndefined();

			const context = await client.getContext({ maxSources: 8, maxRelations: 16, maxContentBytes: 2048 });
			expect(context.returned.sources).toBeLessThanOrEqual(8);
			expect(context.returned.relations).toBeLessThanOrEqual(16);
			expect(context.returned.contentBytes).toBeLessThanOrEqual(2048);
			expect(context.snapshot.sources.every(source => !("tokenCount" in source))).toBe(true);

			const output = `${"z".repeat(400_000)}\n`;
			const evalFrom = rawFrames.length;
			const accepted = await client.evalExecute({
				language: "js",
				code: "console.log('z'.repeat(400000))",
				title: "lossless process output",
				timeout: 30,
			});
			const terminal = await waitForArrayFrame(
				rawFrames,
				frame =>
					frame.operationId === accepted.operationId &&
					["operation_completed", "operation_cancelled", "operation_failed"].includes(String(frame.type)),
				"TypeScript eval terminal",
				{ from: evalFrom, timeoutMs: 45_000 },
			);
			expect(terminal.type).toBe("operation_completed");
			expect(interactions).toContainEqual(
				expect.objectContaining({ method: "confirm", operationId: accepted.operationId, command: "eval_execute" }),
			);
			await waitForArrayFrame(
				rawFrames,
				frame => frame.type === "eval_complete" && frame.operationId === accepted.operationId,
				"TypeScript eval completion",
				{ from: evalFrom },
			);
			const result = record(complete?.result, "eval completion result");
			expect(structuredClone(result)).toMatchObject({
				truncated: true,
				outputBytes: expect.any(Number),
				outputPreviewBytes: expect.any(Number),
				outputTruncation: { truncated: true },
				artifact: { id: expect.any(String), byteLength: expect.any(Number), lifecycle: "available" },
				artifactRef: expect.stringMatching(/^artifact:\/\//),
			});
			const artifact = record(result.artifact, "eval artifact");
			const reconstructed = await reconstructArtifact(client, String(artifact.id));
			expect(new TextDecoder().decode(reconstructed)).toBe(output);
			const outputBytes = result.outputBytes;
			if (typeof outputBytes !== "number") throw new Error("Eval result outputBytes is not numeric");
			expect(reconstructed.byteLength).toBe(outputBytes);

			const exactOutput = "  exact output  \n";
			const exactEvalFrom = rawFrames.length;
			const exactEval = await client.evalExecute({
				language: "js",
				code: "console.log('  exact output  ')",
				title: "byte-exact bounded process output",
				timeout: 30,
			});
			const exactComplete = await waitForArrayFrame(
				rawFrames,
				frame => frame.type === "eval_complete" && frame.operationId === exactEval.operationId,
				"TypeScript bounded eval completion",
				{ from: exactEvalFrom },
			);
			const exactResult = record(exactComplete.result, "bounded eval completion result");
			const exactArtifact = record(exactResult.artifact, "bounded eval artifact");
			const exactReconstructed = await reconstructArtifact(client, String(exactArtifact.id));
			expect(new TextDecoder().decode(exactReconstructed)).toBe(exactOutput);
			const exactOutputBytes = exactResult.outputBytes;
			if (typeof exactOutputBytes !== "number") throw new Error("Bounded eval outputBytes is not numeric");
			expect(exactReconstructed.byteLength).toBe(exactOutputBytes);

			const cancelFrom = rawFrames.length;
			const cancellable = await client.evalExecute({
				language: "js",
				code: "await Bun.sleep(30000); console.log('must-not-emit')",
				title: "active cancellation",
				timeout: 60,
			});
			await waitForArrayFrame(
				rawFrames,
				frame => frame.type === "operation_started" && frame.operationId === cancellable.operationId,
				"active eval start",
				{ from: cancelFrom },
			);
			const cancellation = await client.cancelOperation(cancellable.operationId);
			expect(cancellation).toMatchObject({ operationId: cancellable.operationId });
			await waitForArrayFrame(
				rawFrames,
				frame => frame.type === "operation_cancelled" && frame.operationId === cancellable.operationId,
				"active eval cancellation",
				{ from: cancelFrom, timeoutMs: 30_000 },
			);
			expect(
				rawFrames.filter(
					frame =>
						frame.operationId === cancellable.operationId &&
						["operation_completed", "operation_cancelled", "operation_failed"].includes(String(frame.type)),
				),
			).toHaveLength(1);

			const transitionFrom = rawFrames.length;
			const transitionOperation = await client.evalExecute({
				language: "js",
				code: "await Bun.sleep(30000); console.log('stale-session-output')",
				title: "session transition cancellation",
				timeout: 60,
			});
			await waitForArrayFrame(
				rawFrames,
				frame => frame.type === "operation_started" && frame.operationId === transitionOperation.operationId,
				"transition-owned eval start",
				{ from: transitionFrom },
			);
			expect(await client.newSession()).toMatchObject({ cancelled: expect.any(Boolean) });
			await waitForArrayFrame(
				rawFrames,
				frame => frame.type === "operation_cancelled" && frame.operationId === transitionOperation.operationId,
				"transition-owned eval cancellation",
				{ from: transitionFrom, timeoutMs: 30_000 },
			);
			const transitionedOpen = await client.openSession({ snapshot: true });
			expect(transitionedOpen.snapshot?.sessionId).not.toBe(opened.snapshot?.sessionId);
			const transitionedContext = await client.getContext();
			expect(transitionedContext.snapshot).toMatchObject({
				sessionId: transitionedOpen.snapshot?.sessionId,
				sources: [],
				relations: [],
			});
			expect(transitionedContext.snapshot.provider).toBeUndefined();
			for (const frame of rawFrames.slice(transitionFrom)) {
				if (frame.type !== "session_observation" || frame.subscriptionId !== opened.subscriptionId) continue;
				const staleObservation = record(frame.observation, "stale TypeScript observation");
				expect(staleObservation.sessionId).not.toBe(transitionedOpen.snapshot?.sessionId);
			}

			const shutdownFrom = rawFrames.length;
			expect(await client.shutdownSession()).toEqual({ state: "settled" });
			const shutdown = await waitForArrayFrame(
				rawFrames,
				frame => frame.type === "response" && frame.command === "session_shutdown",
				"TypeScript shutdown response",
				{ from: shutdownFrom },
			);
			const finalObservation = rawFrames.slice(shutdownFrom).find(frame => {
				if (frame.type !== "session_observation" || frame.subscriptionId !== transitionedOpen.subscriptionId)
					return false;
				const observation = record(frame.observation, "TypeScript final observation");
				return observation.type === "observation" && observation.kind === "session_settled";
			});
			expect(finalObservation).toBeDefined();
			for (const operationId of [cancellable.operationId, transitionOperation.operationId]) {
				expect(
					rawFrames.filter(
						frame =>
							frame.operationId === operationId &&
							["operation_completed", "operation_cancelled", "operation_failed"].includes(String(frame.type)),
					),
				).toHaveLength(1);
			}
			expect(rawFrames.indexOf(finalObservation as ObservedFrame)).toBeLessThan(rawFrames.indexOf(shutdown));
			expect(rawFrames.at(-1)).toBe(shutdown);
		} finally {
			await client.stop();
			await removeIsolatedRpcProcessRoot(root);
		}
	}, 120_000);

	test("separately installed Python package drives rpc-ui and the official native AskTool through the exact binary", async () => {
		const python = Bun.which("python3");
		if (!python) throw new Error("python3 is required for Python RPC process conformance");
		pythonEnvironmentRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-rpc-v3-python-install-"));
		const pythonSite = path.join(pythonEnvironmentRoot, "site-packages");
		const repositoryRoot = path.resolve(import.meta.dir, "../../..");
		const packageRoot = path.join(repositoryRoot, "python", "omp-rpc");
		const driver = path.join(packageRoot, "tests", "rpc_v3_process_driver.py");
		const installCommand = [
			python,
			"-m",
			"pip",
			"install",
			"--target",
			pythonSite,
			"--no-deps",
			"--no-build-isolation",
			packageRoot,
		];
		const install = Bun.spawn(installCommand, { cwd: repositoryRoot, stdout: "pipe", stderr: "pipe" });
		const [installExitCode, installStdout, installStderr] = await Promise.all([
			install.exited,
			new Response(install.stdout as ReadableStream<Uint8Array>).text(),
			new Response(install.stderr as ReadableStream<Uint8Array>).text(),
		]);
		expect(installExitCode, `${installCommand.join(" ")}\nstdout:\n${installStdout}\nstderr:\n${installStderr}`).toBe(
			0,
		);
		const workRoot = path.join(pythonEnvironmentRoot, "process");
		await fs.promises.mkdir(workRoot, { recursive: true });
		const launcher =
			"import runpy,sys;site,driver,*args=sys.argv[1:];sys.path.insert(0,site);sys.argv=[driver,*args];runpy.run_path(driver,run_name='__main__')";
		const child = Bun.spawn(
			[python, "-I", "-c", launcher, pythonSite, driver, binaryPath, workRoot, nativeAskProviderFixture],
			{
				cwd: workRoot,
				env: { ...Bun.env, PYTHONNOUSERSITE: "1", PYTHONPATH: "", ANTHROPIC_API_KEY: "" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout as ReadableStream<Uint8Array>).text(),
			new Response(child.stderr as ReadableStream<Uint8Array>).text(),
		]);
		expect(exitCode, `Python process driver failed\nstdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
		const summary = JSON.parse(stdout.trim()) as Record<string, unknown>;
		expect(structuredClone(summary)).toMatchObject({
			binary: binaryPath,
			package: expect.stringContaining("site-packages/omp_rpc/__init__.py"),
			logicalFrames: expect.any(Number),
			framingVersion: 2,
		});
		expect(summary.logicalFrames).toBeGreaterThan(10);
	}, 120_000);
});
