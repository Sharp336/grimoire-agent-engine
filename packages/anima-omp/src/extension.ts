import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { type ActiveInvocation, AnimaExecutorController } from "./executor";
import { getSharedControlClient } from "./protocol";

const AGENT_ROOT = path.resolve(import.meta.dir, "../agents");

function configuredAgentNames(): string[] {
	return (process.env.ANIMA_OMP_AGENT_NAMES ?? "")
		.split(",")
		.map(name => name.trim())
		.filter(Boolean);
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

async function handleCommand(
	args: string,
	ctx: ExtensionCommandContext,
	controller: AnimaExecutorController,
): Promise<void> {
	const [command = "status", requestId] = args.trim().split(/\s+/, 2);
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
	ctx.ui.notify("Usage: /anima [status [task-id] | attach <task-id> | cancel <task-id> | release <task-id>]", "error");
}

export default function animaExtension(pi: ExtensionAPI): void {
	pi.setLabel("Anima Claude executor");
	const controller = new AnimaExecutorController({
		client: getSharedControlClient(),
		agentRoot: AGENT_ROOT,
		allowAgentNames: configuredAgentNames(),
	});
	pi.registerSubagentExecutor(controller.executor);
	pi.registerCommand("anima", {
		description: "Inspect and control Anima-managed Claude task agents",
		handler: (args, ctx) => handleCommand(args, ctx, controller),
	});
}
