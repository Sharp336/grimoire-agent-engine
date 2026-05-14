import type { AssistantMessage, ImageContent, Usage } from "@oh-my-pi/pi-ai";
import { Container, Image, type ImageBudget, ImageProtocol, Markdown, Spacer, TERMINAL, Text } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { settings } from "../../config/settings";
import type { AssistantThinkingRenderer } from "../../extensibility/extensions/types";
import { getMarkdownTheme, theme } from "../../modes/theme/theme";
import { isSilentAbort } from "../../session/messages";
import { resolveImageOptions } from "../../tools/render-utils";

/**
 * Renders a slice of an assistant message — either the whole message (default) or a segment
 * of `content[startIndex..endIndex)`. Segments interleave assistant text with tool execution
 * components when the model emits tool calls mid-message, so chatContainer siblings appear
 * in the order the model emitted them.
 *
 * Footer (usage, error/abort suffix) renders only on the final segment so it lands once at
 * the end of the message, regardless of how many segments precede it.
 */
export class AssistantMessageComponent extends Container {
	#contentContainer: Container;
	#lastMessage?: AssistantMessage;
	#toolImagesByCallId = new Map<string, ImageContent[]>();
	#usageInfo?: Usage;
	#convertedKittyImages = new Map<string, ImageContent>();
	#kittyConversionsInFlight = new Set<string>();
	#transcriptBlockFinalized: boolean;
	/**
	 * When true, the turn-ending `Error: …` line for `stopReason === "error"` is
	 * suppressed because the same error is currently shown in the pinned banner
	 * above the editor (see `EventController` + `ErrorBannerComponent`). Avoids
	 * rendering the identical error twice (inline + banner) at the error moment.
	 * Restored to `false` when the banner is cleared at the next turn so the
	 * transcript keeps the error in history.
	 */
	#errorPinned = false;
	#startIndex: number;
	#endIndex: number | undefined;
	#isFinalSegment: boolean;

	constructor(
		message?: AssistantMessage,
		private hideThinkingBlock = false,
		private readonly onImageUpdate?: () => void,
		private readonly thinkingRenderers: readonly AssistantThinkingRenderer[] = [],
		private readonly imageBudget?: ImageBudget,
		options?: { startIndex?: number; endIndex?: number; isFinalSegment?: boolean },
	) {
		super();
		this.#transcriptBlockFinalized = message !== undefined;

		this.#startIndex = options?.startIndex ?? 0;
		this.#endIndex = options?.endIndex;
		this.#isFinalSegment = options?.isFinalSegment ?? true;

		// Container for text/thinking content
		this.#contentContainer = new Container();
		this.addChild(this.#contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	setContentRange(startIndex: number, endIndex: number | undefined): void {
		this.#startIndex = startIndex;
		this.#endIndex = endIndex;
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage);
		}
	}

	setIsFinalSegment(isFinal: boolean): void {
		this.#isFinalSegment = isFinal;
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
	}

	/**
	 * Toggle suppression of the inline `Error: …` line while the same error is
	 * pinned in the banner above the editor. Re-renders so the change is visible.
	 */
	setErrorPinned(pinned: boolean): void {
		if (this.#errorPinned === pinned) return;
		this.#errorPinned = pinned;
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage);
		}
	}

	isTranscriptBlockFinalized(): boolean {
		return this.#transcriptBlockFinalized;
	}

	/**
	 * Assistant text/thinking streams in append-only: earlier rendered rows never
	 * re-layout, new content only grows the block at the bottom. The transcript
	 * reports this so the renderer may commit scrolled-off head rows of a long
	 * streamed reply to native scrollback instead of dropping them (see
	 * `NativeScrollbackLiveRegion#getNativeScrollbackCommitSafeEnd`). Volatile
	 * blocks (tool previews that collapse) intentionally do not implement this.
	 */
	isTranscriptBlockAppendOnly(): boolean {
		return true;
	}

	markTranscriptBlockFinalized(): void {
		this.#transcriptBlockFinalized = true;
	}

	setToolResultImages(toolCallId: string, images: ImageContent[]): void {
		if (!toolCallId) return;
		const validImages = images.filter(img => img.type === "image" && img.data && img.mimeType);
		for (const key of Array.from(this.#convertedKittyImages.keys())) {
			if (key.startsWith(`${toolCallId}:`)) {
				this.#convertedKittyImages.delete(key);
			}
		}
		for (const key of Array.from(this.#kittyConversionsInFlight)) {
			if (key.startsWith(`${toolCallId}:`)) {
				this.#kittyConversionsInFlight.delete(key);
			}
		}
		if (validImages.length === 0) {
			this.#toolImagesByCallId.delete(toolCallId);
		} else {
			this.#toolImagesByCallId.set(toolCallId, validImages);
			this.#convertToolImagesForKitty(toolCallId, validImages);
		}
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage);
		}
	}

	#convertToolImagesForKitty(toolCallId: string, images: ImageContent[]): void {
		if (TERMINAL.imageProtocol !== ImageProtocol.Kitty) return;
		for (let index = 0; index < images.length; index++) {
			const image = images[index];
			if (!image || image.mimeType === "image/png") continue;
			const key = `${toolCallId}:${index}`;
			if (this.#convertedKittyImages.has(key) || this.#kittyConversionsInFlight.has(key)) continue;
			this.#kittyConversionsInFlight.add(key);
			new Bun.Image(Buffer.from(image.data, "base64"))
				.png()
				.toBase64()
				.then(data => {
					this.#kittyConversionsInFlight.delete(key);
					this.#convertedKittyImages.set(key, {
						type: "image",
						data,
						mimeType: "image/png",
					});
					if (this.#lastMessage) {
						this.updateContent(this.#lastMessage);
					}
					this.onImageUpdate?.();
				})
				.catch(() => {
					this.#kittyConversionsInFlight.delete(key);
				});
		}
	}

	setUsageInfo(usage: Usage): void {
		this.#usageInfo = usage;
		if (this.#lastMessage) {
			this.updateContent(this.#lastMessage);
		}
	}

	#renderToolImages(): void {
		const imageEntries = Array.from(this.#toolImagesByCallId.entries()).flatMap(([toolCallId, images]) =>
			images.map((image, index) => ({ image, key: `${toolCallId}:${index}` })),
		);
		if (imageEntries.length === 0) return;

		this.#contentContainer.addChild(new Spacer(1));
		for (const { image, key } of imageEntries) {
			const displayImage =
				TERMINAL.imageProtocol === ImageProtocol.Kitty && image.mimeType !== "image/png"
					? this.#convertedKittyImages.get(key)
					: image;
			if (TERMINAL.imageProtocol && displayImage) {
				this.#contentContainer.addChild(
					new Image(
						displayImage.data,
						displayImage.mimeType,
						{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
						{ ...resolveImageOptions(), budget: this.imageBudget, imageKey: key },
					),
				);
				continue;
			}
			this.#contentContainer.addChild(new Text(theme.fg("toolOutput", `[Image: ${image.mimeType}]`), 1, 0));
		}
	}

	#appendThinkingExtensions(contentIndex: number, thinkingIndex: number, text: string): void {
		for (const renderer of this.thinkingRenderers) {
			try {
				const component = renderer(
					{
						contentIndex,
						thinkingIndex,
						text,
						requestRender: () => this.onImageUpdate?.(),
					},
					theme,
				);
				if (component) {
					this.#contentContainer.addChild(component);
				}
			} catch {
				// Ignore extension renderer failures and keep the original thinking block visible.
			}
		}
	}

	updateContent(message: AssistantMessage): void {
		this.#lastMessage = message;

		// Clear content container
		this.#contentContainer.clear();

		const end = this.#endIndex ?? message.content.length;
		const slice = message.content.slice(this.#startIndex, end);

		const hasVisibleContent = slice.some(
			c => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.#contentContainer.addChild(new Spacer(1));
		}

		// Render text/thinking blocks within this segment's slice in order.
		// Tool calls are rendered as siblings of this component in the parent chatContainer.
		// Keep the thinking ordinal message-global (like the absolute contentIndex passed to
		// #appendThinkingExtensions) so extension renderers see stable indices across segments.
		let thinkingIndex = 0;
		for (let j = 0; j < this.#startIndex; j++) {
			const prior = message.content[j];
			if (prior.type === "thinking" && prior.thinking.trim()) thinkingIndex += 1;
		}
		for (let i = 0; i < slice.length; i++) {
			const content = slice[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.#contentContainer.addChild(new Markdown(content.text.trim(), 1, 0, getMarkdownTheme()));
			} else if (content.type === "thinking" && content.thinking.trim()) {
				// Add spacing only when another visible block follows WITHIN this segment.
				// A tool call after the segment renders as a sibling below — no extra spacer needed.
				const hasVisibleContentAfter = slice
					.slice(i + 1)
					.some(c => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				if (this.hideThinkingBlock) {
					// Show static "Thinking..." label when hidden
					this.#contentContainer.addChild(new Text(theme.italic(theme.fg("thinkingText", "Thinking...")), 1, 0));
					if (hasVisibleContentAfter) {
						this.#contentContainer.addChild(new Spacer(1));
					}
				} else {
					const thinkingText = content.thinking.trim();
					// Thinking traces in thinkingText color, italic
					this.#contentContainer.addChild(
						new Markdown(thinkingText, 1, 0, getMarkdownTheme(), {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						}),
					);
					this.#appendThinkingExtensions(this.#startIndex + i, thinkingIndex, thinkingText);
					thinkingIndex += 1;
					if (hasVisibleContentAfter) {
						this.#contentContainer.addChild(new Spacer(1));
					}
				}
			}
		}

		this.#renderToolImages();
		// Footer (abort/error suffix, usage line) is owned by the final segment so it lands once
		// at the end of the message rather than after each intermediate segment.
		if (!this.#isFinalSegment) return;

		const appendErrorLine = (line: string): void => {
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("error", line), 1, 0));
		};
		// Tool calls render their own error UI, so the message-level abort/error suffix is
		// suppressed when present — except for the stopReason-mismatch case (errorMessage set
		// with a non-error/non-abort stopReason), which is unusual enough to always surface.
		const hasToolCalls = message.content.some(c => c.type === "toolCall");
		if (message.stopReason === "aborted" && !isSilentAbort(message.errorMessage)) {
			if (!hasToolCalls) {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				appendErrorLine(abortMessage);
			}
		} else if (message.stopReason === "error") {
			if (!hasToolCalls && !this.#errorPinned) appendErrorLine(`Error: ${message.errorMessage || "Unknown error"}`);
		} else if (message.errorMessage && !isSilentAbort(message.errorMessage)) {
			appendErrorLine(`Error: ${message.errorMessage}`);
		}

		// Token usage metadata
		if (settings.get("display.showTokenUsage") && this.#usageInfo) {
			const usage = this.#usageInfo;
			const totalInput = usage.input + usage.cacheWrite;
			const parts: string[] = [];
			parts.push(`${theme.icon.input} ${formatNumber(totalInput)}`);
			parts.push(`${theme.icon.output} ${formatNumber(usage.output)}`);
			if (usage.cacheRead > 0) {
				parts.push(`cache: ${formatNumber(usage.cacheRead)}`);
			}
			this.#contentContainer.addChild(new Spacer(1));
			this.#contentContainer.addChild(new Text(theme.fg("dim", parts.join("  ")), 1, 0));
		}
	}
}
