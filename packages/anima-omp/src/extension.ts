import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { type ActiveInvocation, AnimaExecutorController } from "./executor";
import { AnimaPeerBridge, type PeerBus } from "./peer-bridge";
import { type AnimaControl, StdioControlClient } from "./protocol";

const AGENT_ROOT = path.resolve(import.meta.dir, "../agents");

function configuredAgentNames(): string[] {
	return (process.env.ANIMA_OMP_AGENT_NAMES ?? "")
		.split(",")
		.map(name => name.trim())
		.filter(Boolean);
}

function configuredRetention(): "park" | "keep" {
	const configured = process.env.ANIMA_OMP_RETENTION;
	if (configured === undefined) return "park";
	const retention = configured.trim();
	if (retention === "park" || retention === "keep") return retention;
	throw new Error(
		`Invalid ANIMA_OMP_RETENTION ${JSON.stringify(configured)}; expected ${JSON.stringify("park")} or ${JSON.stringify("keep")}`,
	);
}

function formatStatus(invocation: ActiveInvocation): string {
	const fields = [
		`${invocation.requestId}: ${invocation.agentName} → anima`,
		`state=${invocation.state}`,
		invocation.sessionName ? `session=${invocation.sessionName}` : undefined,
		invocation.detail ? `detail=${invocation.detail}` : undefined,
		invocation.attachRef ? `attach=${invocation.attachRef}` : undefined,
		invocation.historyRef ? `history=${invocation.historyRef}` : undefined,
	];
	return fields.filter(Boolean).join(" · ");
}

export async function handleAnimaCommand(
	args: string,
	ctx: ExtensionCommandContext,
	controller: AnimaExecutorController,
): Promise<void> {
	const trimmedArgs = args.trim();
	const [command = "status", requestId] = trimmedArgs.split(/\s+/, 2);
	if (command === "status") {
		if (requestId) {
			try {
				ctx.ui.notify(formatStatus(await controller.observe(requestId)), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
			return;
		}
		const invocations = controller.list();
		ctx.ui.notify(invocations.length > 0 ? invocations.map(formatStatus).join("\n") : "No Anima invocations", "info");
		return;
	}
	if (command === "message") {
		const match = /^message(?:\s+(\S+))?(?:\s+([\s\S]+))?$/.exec(trimmedArgs);
		const messageRequestId = match?.[1];
		const text = match?.[2]?.trim();
		if (!messageRequestId || !text) {
			ctx.ui.notify("Usage: /anima message <task-id> <text...>", "error");
			return;
		}
		try {
			const messageId = await controller.message(messageRequestId, text);
			ctx.ui.notify(`${messageRequestId}: message ${messageId} delivered`, "info");
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
		return;
	}
	if (!requestId) {
		ctx.ui.notify(`Usage: /anima ${command} <task-id>`, "error");
		return;
	}
	if (command === "attach") {
		const invocation = controller.list().find(item => item.requestId === requestId);
		if (!invocation) {
			ctx.ui.notify(`Unknown Anima invocation ${JSON.stringify(requestId)}`, "error");
			return;
		}
		if (!invocation.sessionName) {
			ctx.ui.notify("The Anima session has not spawned yet", "warning");
			return;
		}
		ctx.ui.notify(`Open another terminal and run: an attach ${invocation.sessionName}`, "info");
		return;
	}
	if (command === "cancel" || command === "release") {
		const confirmed = await ctx.ui.confirm(
			`${command === "cancel" ? "Cancel" : "Release"} Anima worker?`,
			`${requestId} will be ${command === "cancel" ? "interrupted" : "parked"}.`,
		);
		if (!confirmed) return;
		try {
			if (command === "cancel") await controller.cancel(requestId);
			else await controller.release(requestId);
			ctx.ui.notify(`${requestId}: ${command} acknowledged`, "info");
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
		return;
	}
	ctx.ui.notify(
		"Usage: /anima [status [task-id] | attach <task-id> | message <task-id> <text...> | cancel <task-id> | release <task-id>]",
		"error",
	);
}

export interface AnimaExtensionDependencies {
	createClient?: () => AnimaControl;
	bus?: PeerBus;
}

interface SharedRuntime {
	readonly key: string;
	readonly controller: AnimaExecutorController;
	readonly bridge: AnimaPeerBridge;
	started: Promise<void>;
	references: number;
	closing?: Promise<void>;
}

let sharedRuntime: SharedRuntime | undefined;

async function releaseSharedRuntime(runtime: SharedRuntime): Promise<void> {
	if (sharedRuntime !== runtime || runtime.references <= 0) return;
	runtime.references -= 1;
	if (runtime.references > 0) return;
	runtime.closing ??= (async () => {
		await runtime.controller.shutdown();
		await runtime.bridge.stop();
	})().finally(() => {
		if (sharedRuntime === runtime) sharedRuntime = undefined;
	});
	await runtime.closing;
}

async function acquireSharedRuntime(
	retention: "park" | "keep",
	allowAgentNames: readonly string[],
	dependencies: AnimaExtensionDependencies,
): Promise<{ controller: AnimaExecutorController; release(): Promise<void> }> {
	if (sharedRuntime?.references === 0) {
		await sharedRuntime.closing;
		return acquireSharedRuntime(retention, allowAgentNames, dependencies);
	}
	const key = JSON.stringify({ retention, allowAgentNames: [...allowAgentNames].sort() });
	if (sharedRuntime && sharedRuntime.key !== key) {
		throw new Error("Anima extension instances in one process must use the same retention and agent allowlist");
	}
	if (!sharedRuntime) {
		const client = dependencies.createClient?.() ?? new StdioControlClient();
		const ready = Promise.withResolvers<void>();
		const controller = new AnimaExecutorController({
			client,
			agentRoot: AGENT_ROOT,
			allowAgentNames,
			retention,
			ready: ready.promise,
		});
		const bridge = new AnimaPeerBridge({ client, controller, bus: dependencies.bus });
		const started = bridge.start().then(
			() => ready.resolve(),
			error => {
				ready.reject(error);
				throw error;
			},
		);
		void ready.promise.catch(() => undefined);
		void started.catch(() => undefined);
		sharedRuntime = {
			key,
			controller,
			bridge,
			started,
			references: 0,
		};
	}
	const runtime = sharedRuntime;
	runtime.references += 1;
	let released = false;
	return {
		controller: runtime.controller,
		release: async () => {
			if (released) return;
			released = true;
			await releaseSharedRuntime(runtime);
		},
	};
}

export async function registerAnimaExtension(
	pi: ExtensionAPI,
	dependencies: AnimaExtensionDependencies = {},
): Promise<void> {
	const retention = configuredRetention();
	const runtime = await acquireSharedRuntime(retention, configuredAgentNames(), dependencies);
	const { controller } = runtime;

	pi.setLabel("Anima Claude executor");
	pi.registerSubagentExecutor(controller.executor);
	pi.registerCommand("anima", {
		description: "Inspect and control Anima-managed Claude task agents",
		handler: (args, ctx) => handleAnimaCommand(args, ctx, controller),
	});
	pi.on("session_shutdown", runtime.release);
}

export default async function animaExtension(pi: ExtensionAPI): Promise<void> {
	await registerAnimaExtension(pi);
}
