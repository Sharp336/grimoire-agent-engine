import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("rpc-process-interactions", {
		description: "Emit process conformance interactions",
		handler: async (_args, ctx) => {
			ctx.ui.setWorkingMessage("process-progress");
			const approval = await ctx.ui.requestApproval?.({
				title: "Process approval",
				toolCallId: "process-tool-call",
				toolName: "process-fixture",
				operation: "write",
				approvalMode: "write",
				resolvedPolicy: "prompt",
				providerSafety: { required: false, checks: [] },
				choices: ["Approve", "Deny"],
				defaultChoice: "Deny",
			});
			const answer = await ctx.ui.askDialog?.([
				{
					id: "process-question",
					question: "Choose",
					options: [{ label: "A" }, { label: "B" }],
				},
			]);
			if (approval?.approved !== true || answer?.kind !== "submit") {
				throw new Error("Host did not settle process interactions");
			}
		},
	});

	pi.registerCommand("rpc-process-large-frame", {
		description: "Emit a large process conformance frame",
		handler: async (_args, ctx) => {
			ctx.ui.notify(`framing-boundary:${"x".repeat(1_200_000)}`);
		},
	});
}
