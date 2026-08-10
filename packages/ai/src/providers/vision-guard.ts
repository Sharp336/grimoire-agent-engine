import { isDashscopeCompatibleModeUrl } from "@oh-my-pi/pi-catalog/hosts";
import { isQwenModelId } from "@oh-my-pi/pi-catalog/identity";

import type { ImageContent, Model, TextContent } from "../types";

export const NON_VISION_IMAGE_PLACEHOLDER = "[image omitted: model does not support vision]";

export function partitionVisionContent(
	content: ReadonlyArray<TextContent | ImageContent>,
	supportsImages: boolean,
): {
	textBlocks: TextContent[];
	imageBlocks: ImageContent[];
	omittedImages: boolean;
} {
	const textBlocks = content.filter((block): block is TextContent => block.type === "text");
	const imageBlocks = content.filter((block): block is ImageContent => block.type === "image");
	return {
		textBlocks,
		imageBlocks: supportsImages ? imageBlocks : [],
		omittedImages: !supportsImages && imageBlocks.length > 0,
	};
}

/**
 * Append one content block to a wire `blocks` array in its original position,
 * substituting the non-vision placeholder in place for unsupported images so
 * interleaved `text → image → text` prompts keep their order on the wire.
 * `toText` may return `null` to drop a block (e.g. skip empty text). This is
 * the order-preserving counterpart to `partitionVisionContent`, which exists
 * for providers whose wire format is inherently flat (a single string plus an
 * images array) and cannot represent interleaving.
 */
export function appendVisionWireBlock<const T>(
	blocks: T[],
	block: TextContent | ImageContent,
	supportsImages: boolean,
	toText: (text: string) => T | null,
	toImage: (block: ImageContent) => T,
): void {
	if (block.type === "text") {
		const wire = toText(block.text);
		if (wire) blocks.push(wire);
	} else if (supportsImages) {
		blocks.push(toImage(block));
	} else {
		const wire = toText(NON_VISION_IMAGE_PLACEHOLDER);
		if (wire) blocks.push(wire);
	}
}

export function joinTextWithImagePlaceholder(text: string, omittedImages: boolean): string {
	const parts: string[] = [];
	if (text.length > 0) {
		parts.push(text);
	}
	if (omittedImages) {
		parts.push(NON_VISION_IMAGE_PLACEHOLDER);
	}
	return parts.join("\n");
}

/**
 * Detect known text-only Qwen models served via Alibaba DashScope's consumer
 * `compatible-mode` endpoint that the upstream chat-completions API rejects
 * multimodal content arrays for. The compatible-mode endpoint also serves
 * multimodal Qwen SKUs without `vl` in the id (e.g. `qwen3.7-plus`), so this
 * guard only covers families verified to be text-only for issue #1859:
 * `qwen*-max` and `qwen*-coder*`.
 *
 * Used as a defensive override in `convertMessages` so a misconfigured custom
 * provider (issue #1859) can't drive the request into an unrecoverable 400.
 */
export function isDashscopeCompatibleModeTextOnlyQwen(model: Model<"openai-completions">): boolean {
	if (!isDashscopeCompatibleModeUrl(model.baseUrl)) {
		return false;
	}
	const id = model.id.toLowerCase();
	if (!isQwenModelId(model.id)) return false;
	return /\bqwen(?:[\d.]+)?-max\b/.test(id) || /\bqwen(?:[\d.]+)?-coder\b/.test(id);
}
