import type { Readable, Writable } from "node:stream";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
	CallToolRequestSchema,
	type JSONRPCMessage,
	JSONRPCMessageSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { Tool, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { OmpMcpConnector, OmpMcpInvocationGateway, OmpMcpTool, OmpTurnBinding, OmpTurnBroker } from "./broker";

const DEFAULT_MAX_JSON_BYTES = 1_048_576;

export interface OmpMcpBrokerClient {
	readonly connector: OmpMcpConnector;
	claim(turnToken: string): Promise<OmpTurnBinding>;
	listTools(): Promise<readonly OmpMcpTool[]>;
	invoke(call: {
		callId: string;
		wireName: string;
		arguments?: Record<string, unknown>;
		input?: string;
	}): Promise<ToolResultMessage>;
	release(bindingId: string): Promise<void>;
	onToolsChanged(listener: () => void): () => void;
	close(): Promise<void>;
}

export interface OmpMcpServerOptions {
	readonly client: OmpMcpBrokerClient;
	readonly input?: Readable;
	readonly output?: Writable;
	readonly maxJsonBytes?: number;
}

export function createDirectBrokerClient(
	broker: OmpTurnBroker & OmpMcpInvocationGateway,
	connector: OmpMcpConnector,
): OmpMcpBrokerClient {
	return {
		connector,
		claim: turnToken => broker.claim(turnToken, connector),
		listTools: () => broker.listTools(connector),
		invoke: call => broker.invoke(connector, call),
		release: bindingId => broker.release(bindingId, connector),
		onToolsChanged: listener => broker.onToolsChanged(connector, listener),
		close: () => broker.closeConnector(connector),
	};
}

class BoundedStdioServerTransport implements Transport {
	onclose?: () => void;
	onerror?: (error: Error) => void;
	onmessage?: <T extends JSONRPCMessage>(message: T) => void;
	readonly #input: Readable;
	readonly #output: Writable;
	readonly #maxBytes: number;
	#buffer = Buffer.alloc(0);
	#started = false;
	#closed = false;

	constructor(input: Readable, output: Writable, maxBytes: number) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new Error("MCP JSON size limit is invalid");
		this.#input = input;
		this.#output = output;
		this.#maxBytes = maxBytes;
	}

	async start(): Promise<void> {
		if (this.#started) throw new Error("MCP stdio transport is already started");
		this.#started = true;
		this.#input.on("data", this.#onData);
		this.#input.on("error", this.#onInputError);
		this.#input.on("end", this.#onEnd);
	}

	async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
		if (this.#closed) throw new Error("MCP stdio transport is closed");
		const encoded = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
		if (encoded.byteLength > this.#maxBytes) throw new Error("MCP JSON response exceeds size limit");
		const sent = Promise.withResolvers<void>();
		const onError = (error: Error) => {
			this.#output.off("error", onError);
			sent.reject(error);
		};
		this.#output.once("error", onError);
		this.#output.write(encoded, error => {
			this.#output.off("error", onError);
			if (error) sent.reject(error);
			else sent.resolve();
		});
		await sent.promise;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#input.off("data", this.#onData);
		this.#input.off("error", this.#onInputError);
		this.#input.off("end", this.#onEnd);
		this.#buffer = Buffer.alloc(0);
		this.onclose?.();
	}

	readonly #onInputError = (error: Error) => {
		this.onerror?.(error);
		void this.close();
	};

	readonly #onEnd = () => {
		void this.close();
	};

	readonly #onData = (chunk: Buffer | string) => {
		if (this.#closed) return;
		const bytes = Buffer.from(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
		this.#buffer = this.#buffer.length === 0 ? bytes : Buffer.concat([this.#buffer, bytes]);
		while (!this.#closed) {
			const newline = this.#buffer.indexOf(0x0a);
			if (newline < 0) {
				if (this.#buffer.byteLength > this.#maxBytes) this.#fatal(new Error("MCP JSON request exceeds size limit"));
				return;
			}
			if (newline > this.#maxBytes) {
				this.#fatal(new Error("MCP JSON request exceeds size limit"));
				return;
			}
			const line = this.#buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
			this.#buffer = this.#buffer.subarray(newline + 1);
			try {
				this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)));
			} catch (error) {
				this.#fatal(error instanceof Error ? error : new Error(String(error)));
			}
		}
	};

	#fatal(error: Error): void {
		this.onerror?.(error);
		void this.close();
	}
}

function toolDescriptor(tool: OmpMcpTool): { name: string; description: string; inputSchema: Record<string, unknown> } {
	if (tool.name === "chatgpt_web_bind_turn" && "inputSchema" in tool) {
		return {
			name: tool.name,
			description: tool.description,
			inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
		};
	}
	const ompTool = tool as Tool;
	if (ompTool.native !== undefined) throw new Error(`native tool cannot be routed over MCP: ${ompTool.name}`);
	if (ompTool.customFormat !== undefined) {
		return {
			name: ompTool.customWireName ?? ompTool.name,
			description: ompTool.description,
			inputSchema: {
				type: "object",
				properties: { input: { type: "string" } },
				required: ["input"],
				additionalProperties: false,
			},
		};
	}
	return {
		name: ompTool.customWireName ?? ompTool.name,
		description: ompTool.description,
		inputSchema: ompTool.parameters as Record<string, unknown>,
	};
}

function mcpResult(message: ToolResultMessage) {
	return {
		content: message.content.map(block => {
			if (block.type === "text") return { type: "text" as const, text: block.text };
			if (block.type === "image") return { type: "image" as const, data: block.data, mimeType: block.mimeType };
			throw new Error("unsupported OMP tool result content");
		}),
		...(message.isError === true ? { isError: true } : {}),
	};
}

const APPROVAL_CONTROL_FIELDS: Readonly<Record<string, true>> = {
	approval: true,
	approvaldecision: true,
	approvalmode: true,
	approvaloverride: true,
	approvaloverrides: true,
	approvalpolicy: true,
	approved: true,
	autoapprove: true,
	autoapprovetoolcalls: true,
	providersafetyapproved: true,
	toolapproval: true,
	toolapprovalpolicy: true,
	toolsapproval: true,
	toolsapprovalmode: true,
	xdevapproved: true,
};

function assertNoApprovalControlFields(value: unknown): void {
	const pending: unknown[] = [value];
	const visited = new Set<object>();
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current || typeof current !== "object" || visited.has(current)) continue;
		visited.add(current);
		for (const [key, child] of Object.entries(current)) {
			const normalized = key.replace(/[^a-z]/gi, "").toLowerCase();
			if (APPROVAL_CONTROL_FIELDS[normalized]) {
				throw new Error("MCP tool input contains a reserved approval-control field");
			}
			pending.push(child);
		}
	}
}

export async function runOmpMcpServer(options: OmpMcpServerOptions): Promise<void> {
	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	const transport = new BoundedStdioServerTransport(input, output, options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES);
	const server = new Server(
		{ name: "omp-chatgpt-web", version: "1.0.0" },
		{ capabilities: { tools: { listChanged: true } } },
	);
	const validator = new AjvJsonSchemaValidator();
	let activeBinding: OmpTurnBinding | undefined;
	let transitionBarrier = Promise.resolve();
	let notificationBarrier = Promise.resolve();

	const queueNotification = () => {
		notificationBarrier = notificationBarrier.then(() => server.sendToolListChanged());
	};
	const serializeTransition = async <T>(operation: () => Promise<T>): Promise<T> => {
		const previous = transitionBarrier;
		const transition = Promise.withResolvers<void>();
		transitionBarrier = transition.promise;
		const finish = transition.resolve;
		await previous;
		try {
			return await operation();
		} finally {
			finish();
		}
	};
	const unsubscribe = options.client.onToolsChanged(queueNotification);

	server.setRequestHandler(ListToolsRequestSchema, async () => {
		await transitionBarrier;
		await notificationBarrier;
		const tools = await options.client.listTools();
		await notificationBarrier;
		return { tools: tools.map(toolDescriptor) };
	});

	server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
		assertNoApprovalControlFields(request.params);
		if (request.params.name === "chatgpt_web_bind_turn") {
			return serializeTransition(async () => {
				await notificationBarrier;
				const args = request.params.arguments;
				if (
					!args ||
					typeof args.turnToken !== "string" ||
					args.turnToken.length < 20 ||
					Object.keys(args).some(key => key !== "turnToken")
				)
					throw new Error("chatgpt_web_bind_turn requires exactly one turnToken string");
				activeBinding = await options.client.claim(args.turnToken);
				await notificationBarrier;
				return {
					content: [{ type: "text", text: JSON.stringify({ bound: true, bindingId: activeBinding.bindingId }) }],
					structuredContent: { bound: true, bindingId: activeBinding.bindingId },
				};
			});
		}
		await transitionBarrier;
		await notificationBarrier;
		if (!activeBinding) throw new Error("chatgpt_web_bind_turn must succeed before invoking a turn tool");
		const tools = await options.client.listTools();
		const descriptor = tools.map(toolDescriptor).find(tool => tool.name === request.params.name);
		if (!descriptor || descriptor.name === "chatgpt_web_bind_turn") {
			throw new Error(`tool is not available in this turn: ${request.params.name}`);
		}
		const validation = validator.getValidator(descriptor.inputSchema)(request.params.arguments ?? {});
		if (!validation.valid) {
			throw new Error(
				`tool arguments do not match the declared schema: ${validation.errorMessage ?? "invalid arguments"}`,
			);
		}
		const tool = tools.find(candidate => {
			if (candidate.name === "chatgpt_web_bind_turn") return false;
			const ompTool = candidate as Tool;
			return (ompTool.customWireName ?? ompTool.name) === request.params.name;
		}) as Tool | undefined;
		if (!tool) throw new Error(`tool is not available in this turn: ${request.params.name}`);
		const result = await options.client.invoke({
			callId: String(extra.requestId),
			wireName: request.params.name,
			...(tool.customFormat !== undefined
				? { input: String((request.params.arguments as Record<string, unknown> | undefined)?.input ?? "") }
				: { arguments: request.params.arguments ?? {} }),
		});
		return mcpResult(result);
	});

	let failure: unknown;
	const closed = Promise.withResolvers<void>();
	transport.onclose = closed.resolve;
	transport.onerror = closed.reject;
	try {
		await server.connect(transport);
		await closed.promise;
	} catch (error) {
		failure = error;
	}
	unsubscribe();
	const cleanupErrors: unknown[] = [];
	if (activeBinding) {
		try {
			await options.client.release(activeBinding.bindingId);
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	try {
		await options.client.close();
	} catch (error) {
		cleanupErrors.push(error);
	}
	try {
		await server.close();
	} catch (error) {
		cleanupErrors.push(error);
	}
	const errors = failure === undefined ? cleanupErrors : [failure, ...cleanupErrors];
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, "MCP server and cleanup failed");
}
