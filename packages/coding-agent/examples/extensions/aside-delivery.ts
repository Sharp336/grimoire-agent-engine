/**
 * Aside Delivery Extension
 *
 * Demonstrates mid-turn injection via deliverAs: "aside" — folds hidden context
 * at the next agent step boundary without interrupting tools or aborting the stream.
 *
 * Busy-path only: aside does not wake idle or stranded sessions. Use triggerTurn
 * while idle, or followUp / steer, when a model response is required.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const { z } = pi.zod;

	pi.registerTool({
		name: "queue_aside_note",
		label: "Queue Aside Note",
		description: "Queue hidden context for the next agent step boundary (deliverAs: aside)",
		parameters: z.object({
			note: z.string().describe("Hidden context to fold at the next step boundary"),
		}),

		async execute(_toolCallId, params) {
			pi.sendMessage(
				{
					customType: "aside-delivery-demo",
					content: params.note,
					display: false,
				},
				{ deliverAs: "aside" },
			);

			return {
				content: [
					{
						type: "text",
						text: "Queued aside for next agent step boundary (non-interrupting).",
					},
				],
				details: { note: params.note },
			};
		},
	});
}
