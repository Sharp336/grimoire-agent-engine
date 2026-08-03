import type {
	Context,
	DeveloperMessage,
	ImageContent,
	Model,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import { providerImageBudget, providerImageByteBudget } from "@oh-my-pi/snapcompact";

const IMAGE_OMISSION: TextContent = {
	type: "text",
	text: "[image omitted: provider image limit]",
};

/**
 * Providers skip blocks that carry nothing and then skip the message itself, so
 * a turn clamped down to no images and no non-blank text vanishes from the wire
 * (an image-only user turn arrives as `[{ type: "text", text: "" }]`).
 */
function withOmissionFallback(content: (TextContent | ImageContent)[]): (TextContent | ImageContent)[] {
	const survives = content.some(part => (part.type === "text" ? part.text.trim().length > 0 : true));
	return survives ? content : [IMAGE_OMISSION];
}

/** Image sizes in message order; assistant images are never dropped, so their bytes are charged as retained. */
function imageStats(context: Context): { droppable: number[]; retainedBytes: number; total: number } {
	const droppable: number[] = [];
	let retainedBytes = 0;
	let total = 0;
	for (const message of context.messages) {
		if (!Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type !== "image") continue;
			total++;
			if (message.role === "assistant") retainedBytes += part.data.length;
			else droppable.push(part.data.length);
		}
	}
	return { droppable, retainedBytes, total };
}

function clampContent(
	content: readonly (TextContent | ImageContent)[],
	state: { remainingDrops: number },
): (TextContent | ImageContent)[] | undefined {
	let changed = false;
	const clamped: (TextContent | ImageContent)[] = [];
	for (const part of content) {
		if (part.type === "image" && state.remainingDrops > 0) {
			state.remainingDrops--;
			changed = true;
			continue;
		}
		clamped.push(part);
	}
	return changed ? clamped : undefined;
}

function clampUserMessage(message: UserMessage, state: { remainingDrops: number }): UserMessage {
	if (!Array.isArray(message.content) || state.remainingDrops <= 0) return message;
	const content = clampContent(message.content, state);
	return content ? { ...message, content: withOmissionFallback(content) } : message;
}

function clampDeveloperMessage(message: DeveloperMessage, state: { remainingDrops: number }): DeveloperMessage {
	if (!Array.isArray(message.content) || state.remainingDrops <= 0) return message;
	const content = clampContent(message.content, state);
	return content ? { ...message, content: withOmissionFallback(content) } : message;
}

function clampToolResultMessage(message: ToolResultMessage, state: { remainingDrops: number }): ToolResultMessage {
	if (state.remainingDrops <= 0) return message;
	const content = clampContent(message.content, state);
	if (!content) return message;
	return { ...message, content: withOmissionFallback(content) };
}

/** Drops oldest transient image blocks so outgoing vision requests fit the active provider's image and byte caps. */
export function clampProviderContextImages(context: Context, model: Model): Context {
	if (!model.input.includes("image")) return context;
	const { droppable, retainedBytes, total } = imageStats(context);
	let drops = Math.max(0, total - providerImageBudget(model.provider, model.api));
	const byteLimit = providerImageByteBudget(model.provider);
	if (byteLimit !== undefined) {
		let kept = retainedBytes;
		for (let index = Math.min(drops, droppable.length); index < droppable.length; index++) {
			kept += droppable[index] ?? 0;
		}
		while (drops < droppable.length && kept > byteLimit) {
			kept -= droppable[drops] ?? 0;
			drops++;
		}
	}
	if (drops === 0) return context;

	const state = { remainingDrops: drops };
	const messages = context.messages.map(message => {
		switch (message.role) {
			case "user":
				return clampUserMessage(message, state);
			case "developer":
				return clampDeveloperMessage(message, state);
			case "toolResult":
				return clampToolResultMessage(message, state);
			case "assistant":
				return message;
		}
		return message;
	});
	return { ...context, messages };
}
