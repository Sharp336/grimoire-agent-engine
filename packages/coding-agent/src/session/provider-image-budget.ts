import type { Context, ImageContent, Model, TextContent } from "@oh-my-pi/pi-ai";
import { getOpenAIResponsesHistoryItems } from "@oh-my-pi/pi-ai/utils";
import { PROVIDER_IMAGE_BYTES_BUDGET, providerImageBudget } from "@oh-my-pi/snapcompact";

const TOOL_RESULT_IMAGE_OMISSION: TextContent = {
	type: "text",
	text: "[image omitted: provider image limit]",
};

const TRANSPORT_IMAGE_OMISSION: TextContent = {
	type: "text",
	text: "[image omitted: transport image budget]",
};

/**
 * Minimal 1×1 transparent PNG standing in for a native image (computer
 * screenshot or replay `input_image`) shed under the transport byte budget.
 * Those slots are opaque metadata/payload fields that cannot carry a text
 * placeholder, so they collapse to this tiny data URL instead — keeping the
 * surrounding `computer_call_output` / replay item structurally valid while
 * shedding the elided image's bytes.
 */
const ELIDED_IMAGE_DATA_URL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

type ProviderMessage = Context["messages"][number];

type ImageSlotKind = "content" | "screenshot" | "replay";

interface ImageSlot {
	messageIndex: number;
	kind: ImageSlotKind;
	/** content: index into message.content; screenshot: 0 (one per message); replay: index into providerPayload.items. */
	partIndex: number;
	/** replay only: index into a `message` item's nested content array, or -1 for a top-level `input_image` item. */
	nestedIndex: number;
	bytes: number;
	/** Assistant content images are counted toward the cap but never rewritten. */
	droppable: boolean;
}

/** Per-image elision plan resolved from one shared traversal. */
interface ImageBudgetPlan {
	/** Oldest → newest, carrying each image's decoded byte size. */
	slots: ImageSlot[];
	/** Indices into {@link ImageBudgetPlan.slots} dropped so the count fits the provider cap. */
	countElided: Set<number>;
	/** Indices into {@link ImageBudgetPlan.slots} elided under the aggregate byte budget. */
	byteElided: Set<number>;
}

interface ReplayElision {
	itemIndex: number;
	nestedIndex: number;
}

/** Decoded byte size of a base64 string, subtracting `=` padding so the budget
 *  measures decoded bytes rather than approximating from the encoded length
 *  (canonical padded base64 overstates the decoded size by one byte per `=`). */
function decodedBase64Bytes(base64: string): number {
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	return Math.floor((base64.length * 3) / 4) - padding;
}

/** Decoded byte size of an image reference: a `data:<mime>;base64,<payload>` URL
 *  (native screenshot / replay `input_image`) or a raw base64 string (ImageContent.data). */
function imageDataBytes(value: string): number {
	const comma = value.indexOf(",");
	return decodedBase64Bytes(value.startsWith("data:") && comma >= 0 ? value.slice(comma + 1) : value);
}

function isInputImage(record: Record<string, unknown>): record is Record<string, unknown> & { type: "input_image" } {
	return record.type === "input_image";
}

/** Decoded byte size of an `input_image` reference: embedded `data:` URLs occupy
 *  the transport budget; remote/file references (`https://…`, `file_id`) resolve
 *  provider-side and carry no payload bytes, so they count toward the image cap
 *  but never the byte budget. */
function inputImageBytes(record: Record<string, unknown>): number {
	return typeof record.image_url === "string" && record.image_url.startsWith("data:")
		? imageDataBytes(record.image_url)
		: 0;
}

/** Replay `input_image` slots carried by a message's native history payload. */
function replayImageSlots(messageIndex: number, items: Array<Record<string, unknown>>): ImageSlot[] {
	const slots: ImageSlot[] = [];
	for (let ii = 0; ii < items.length; ii++) {
		const item = items[ii];
		if (isInputImage(item)) {
			slots.push({
				messageIndex,
				kind: "replay",
				partIndex: ii,
				nestedIndex: -1,
				bytes: inputImageBytes(item),
				droppable: true,
			});
			continue;
		}
		if (item.type === "message" && Array.isArray(item.content)) {
			const content = item.content as Array<Record<string, unknown>>;
			for (let ci = 0; ci < content.length; ci++) {
				const part = content[ci];
				if (part && isInputImage(part)) {
					slots.push({
						messageIndex,
						kind: "replay",
						partIndex: ii,
						nestedIndex: ci,
						bytes: inputImageBytes(part),
						droppable: true,
					});
				}
			}
		}
	}
	return slots;
}

/**
 * Single traversal collecting both the total image count and per-image slots
 * (oldest → newest) carrying their decoded byte size. Shared by the count and
 * byte clamps so neither re-walks the context. Covers every image a provider
 * actually serializes: content-array blocks, native computer screenshots
 * (toolResult metadata, uploaded directly as `computer_call_output`), and native
 * replay `input_image`s (providerPayload.items, uploaded unchanged when the
 * payload's provider matches) — on both user/developer turns and same-model
 * assistant snapshot turns, which the Responses serializer replays verbatim.
 * Assistant content images are counted toward the image cap but contribute zero
 * bytes — provider serializers never re-upload them — so they cannot force
 * elision of real uploaded images. A native computer result carries the same
 * screenshot in both `content` and `providerMetadata.screenshot`; only the
 * representation the active serializer uploads is collected, so the screenshot
 * is never double-budgeted.
 */
function collectImageStats(context: Context, model: Model): { count: number; slots: ImageSlot[] } {
	const provider = model.provider;
	// Only these serializers replay openaiResponsesHistory payloads; a matching
	// provider alone is insufficient after an in-session API switch.
	const replaysNativeResponsesHistory =
		model.api === "openai-responses" ||
		model.api === "openai-codex-responses" ||
		model.api === "azure-openai-responses";
	const nativeComputerUse = model.supportsComputerUse === true;
	let count = 0;
	const slots: ImageSlot[] = [];
	for (let mi = 0; mi < context.messages.length; mi++) {
		const message = context.messages[mi];
		// A native computer result duplicates its screenshot in `content` and in
		// `providerMetadata.screenshot`. The Responses serializer uploads the
		// screenshot (as `computer_call_output`) and drops the content image on
		// computer-capable models; every other serializer uploads the content
		// image and stringifies the screenshot to text. Budget only the one the
		// active serializer uploads so a single screenshot is never counted twice.
		const computerScreenshotSerialized =
			message.role === "toolResult" && message.providerMetadata?.type === "computer" && nativeComputerUse;
		if (Array.isArray(message.content)) {
			const droppable = message.role !== "assistant";
			for (let pi = 0; pi < message.content.length; pi++) {
				const part = message.content[pi];
				if (part.type !== "image") continue;
				if (computerScreenshotSerialized) continue; // content copy is dropped by the serializer
				count++;
				slots.push({
					messageIndex: mi,
					kind: "content",
					partIndex: pi,
					nestedIndex: -1,
					// Assistant image blocks are never re-serialized, so their bytes
					// do not count toward the transport budget (only the image cap).
					bytes: droppable ? imageDataBytes(part.data) : 0,
					droppable,
				});
			}
		}
		if (message.role === "toolResult") {
			const screenshot = message.providerMetadata?.screenshot;
			if (
				nativeComputerUse &&
				screenshot &&
				typeof screenshot.image_url === "string" &&
				screenshot.image_url.startsWith("data:")
			) {
				count++;
				slots.push({
					messageIndex: mi,
					kind: "screenshot",
					partIndex: 0,
					nestedIndex: -1,
					bytes: imageDataBytes(screenshot.image_url),
					droppable: true,
				});
			}
		}
		if (message.role === "user" || message.role === "developer" || message.role === "assistant") {
			// The Responses serializer only replays a same-model assistant snapshot,
			// passing the assistant's own provider as the payload fallback; mirror
			// that gate so foreign-model snapshots (re-encoded, not replayed) are not
			// collected, while still catching historical input_images a full snapshot
			// splices back into the request.
			const items =
				message.role === "assistant"
					? message.api === model.api && message.model === model.id
						? getOpenAIResponsesHistoryItems(message.providerPayload, provider, message.provider)
						: undefined
					: replaysNativeResponsesHistory
						? getOpenAIResponsesHistoryItems(message.providerPayload, provider)
						: undefined;
			if (items) {
				const replaySlots = replayImageSlots(mi, items);
				count += replaySlots.length;
				slots.push(...replaySlots);
			}
		}
	}
	return { count, slots };
}

/** Resolve the count + byte elision sets from one set of slots. The count clamp
 *  drops the oldest droppable images until the retained total fits the provider
 *  cap; assistant images count toward the total but are never rewritten, so
 *  extra droppable images are dropped to compensate (upstream parity). The byte
 *  clamp walks the survivors newest → oldest, always retaining the newest; each
 *  older droppable image is elided — and its bytes skipped — once retaining it
 *  would cross the budget, so dropping one large image can let smaller older
 *  images fit again rather than cascading elision past them. */
function planImageBudget(slots: ImageSlot[], limit: number): ImageBudgetPlan {
	const countElided = new Set<number>();
	const dropCount = Math.max(0, slots.length - limit);
	let drops = 0;
	for (let i = 0; i < slots.length; i++) {
		if (drops >= dropCount) break;
		const slot = slots[i];
		if (!slot.droppable) continue;
		// Screenshots cannot be cleanly removed without breaking the
		// computer_call/computer_call_output pairing the Responses grammar
		// requires, and shrinking one to a placeholder does not reduce the image
		// count the cap measures. Skip them in the count clamp so droppable
		// content/replay images absorb the overflow instead.
		if (slot.kind === "screenshot") continue;
		countElided.add(i);
		drops++;
	}

	const byteElided = new Set<number>();
	let accumulated = 0;
	let seenNewest = false;
	for (let i = slots.length - 1; i >= 0; i--) {
		if (countElided.has(i)) continue;
		const slot = slots[i];
		// Non-serialized images (assistant content blocks, bytes 0) are never
		// uploaded, so they neither occupy the byte budget nor claim the
		// unconditional newest-retention slot — otherwise a trailing assistant
		// display image would let the real newest uploaded image be elided.
		if (slot.bytes === 0) continue;
		if (!seenNewest) {
			// The newest surviving uploaded image is always retained.
			accumulated += slot.bytes;
			seenNewest = true;
			continue;
		}
		if (slot.droppable && accumulated + slot.bytes > PROVIDER_IMAGE_BYTES_BUDGET) {
			byteElided.add(i);
			continue; // Elided bytes are not accumulated.
		}
		accumulated += slot.bytes;
	}

	return { slots, countElided, byteElided };
}

/** Rewrite one content array per the elision plan. Count-dropped images are
 *  removed; byte-dropped images collapse into a single transport placeholder. */
function clampContentBudget(
	content: readonly (TextContent | ImageContent)[],
	entry: { count: Set<number>; byte: Set<number> },
): (TextContent | ImageContent)[] | undefined {
	let changed = false;
	const clamped: (TextContent | ImageContent)[] = [];
	for (let i = 0; i < content.length; i++) {
		const part = content[i];
		if (part.type === "image") {
			if (entry.count.has(i)) {
				changed = true;
				continue;
			}
			if (entry.byte.has(i)) {
				changed = true;
				if (clamped[clamped.length - 1] !== TRANSPORT_IMAGE_OMISSION) {
					clamped.push(TRANSPORT_IMAGE_OMISSION);
				}
				continue;
			}
		}
		clamped.push(part);
	}
	return changed ? clamped : undefined;
}

/** Apply the content-array elision plan to a content-bearing message. */
function applyContentClamp(message: ProviderMessage, count: Set<number>, byte: Set<number>): ProviderMessage {
	if (message.role === "toolResult") {
		if (count.size === 0 && byte.size === 0) return message;
		const content = clampContentBudget(message.content, { count, byte });
		if (!content) return message;
		// All blocks dropped by the count clamp — keep the result meaningful.
		return { ...message, content: content.length > 0 ? content : [TOOL_RESULT_IMAGE_OMISSION] };
	}
	if (message.role === "user" || message.role === "developer") {
		if (!Array.isArray(message.content) || (count.size === 0 && byte.size === 0)) return message;
		const content = clampContentBudget(message.content, { count, byte });
		return content ? { ...message, content } : message;
	}
	return message;
}

/** Replace a native computer screenshot with the elision placeholder. */
function applyScreenshotElide(message: ProviderMessage): ProviderMessage {
	if (message.role !== "toolResult" || message.providerMetadata?.type !== "computer") return message;
	return {
		...message,
		providerMetadata: {
			...message.providerMetadata,
			screenshot: { type: "computer_screenshot", image_url: ELIDED_IMAGE_DATA_URL },
		},
	};
}

/** Rewrite a message's native replay payload. Count-dropped `input_image`s are
 *  removed — top-level items dropped, nested parts filtered out — so the
 *  provider image-count cap is actually enforced rather than merely shrinking
 *  the image to a placeholder that still counts. Byte-dropped `input_image`s
 *  collapse to the elision placeholder, keeping the surrounding item
 *  structurally valid. Every matching elision is applied: one `message` item can
 *  carry several nested `input_image` parts, all of which may be selected. */
function applyReplayElide(
	message: ProviderMessage,
	countElisions: ReplayElision[],
	byteElisions: ReplayElision[],
): ProviderMessage {
	if (
		(message.role !== "user" && message.role !== "developer" && message.role !== "assistant") ||
		!message.providerPayload
	) {
		return message;
	}
	const payload = message.providerPayload;
	const removedTopLevel = new Set<number>();
	const removedNested = new Map<number, Set<number>>();
	const shrunkTopLevel = new Set<number>();
	const shrunkNested = new Map<number, Set<number>>();
	const index = (table: Map<number, Set<number>>, itemIndex: number, nestedIndex: number): void => {
		let set = table.get(itemIndex);
		if (!set) {
			set = new Set();
			table.set(itemIndex, set);
		}
		set.add(nestedIndex);
	};
	for (const e of countElisions) {
		if (e.nestedIndex < 0) removedTopLevel.add(e.itemIndex);
		else index(removedNested, e.itemIndex, e.nestedIndex);
	}
	for (const e of byteElisions) {
		if (e.nestedIndex < 0) shrunkTopLevel.add(e.itemIndex);
		else index(shrunkNested, e.itemIndex, e.nestedIndex);
	}

	let changed = false;
	const items = payload.items
		.map((item, ii): Record<string, unknown> | undefined => {
			if (removedTopLevel.has(ii)) {
				changed = true;
				return undefined; // whole input_image item dropped (count cap)
			}
			const removedParts = removedNested.get(ii);
			const shrunkParts = shrunkNested.get(ii);
			if (shrunkTopLevel.has(ii)) {
				changed = true;
				return { ...item, image_url: ELIDED_IMAGE_DATA_URL };
			}
			if (!removedParts && !shrunkParts) return item;
			if (item.type !== "message" || !Array.isArray(item.content)) return item;
			const content = item.content as Array<Record<string, unknown>>;
			let rewrote = false;
			const nextContent: Array<Record<string, unknown>> = [];
			for (let ci = 0; ci < content.length; ci++) {
				const part = content[ci];
				if (removedParts?.has(ci)) {
					rewrote = true; // nested input_image filtered out (count cap)
					continue;
				}
				if (shrunkParts?.has(ci)) {
					rewrote = true;
					nextContent.push({ ...part, image_url: ELIDED_IMAGE_DATA_URL });
					continue;
				}
				nextContent.push(part);
			}
			if (!rewrote) return item;
			changed = true;
			// A message item emptied of every image by the count clamp carries no
			// content; drop it rather than emit an empty message item.
			return nextContent.length > 0 ? { ...item, content: nextContent } : undefined;
		})
		.filter((item): item is Record<string, unknown> => item !== undefined);
	return changed ? { ...message, providerPayload: { ...payload, items } } : message;
}

/** Drops oldest transient image blocks so outgoing vision requests fit the
 *  active provider's image cap, then enforces an aggregate decoded-image-byte
 *  budget on the remaining images. Both clamps share a single traversal that
 *  accounts for every image a provider serializes: content-array blocks, native
 *  computer screenshots, and native replay `input_image`s. The session history
 *  is untouched — only the throwaway provider view is rewritten. */
export function clampProviderContextImages(context: Context, model: Model): Context {
	if (!model.input.includes("image")) return context;
	const limit = providerImageBudget(model.provider);
	const { count, slots } = collectImageStats(context, model);
	// 0-1 images: the byte budget always retains the newest and has nothing
	// older to elide, and a single image never reaches a provider count cap (>=1).
	if (count <= 1) return context;

	const { countElided, byteElided } = planImageBudget(slots, limit);
	if (countElided.size === 0 && byteElided.size === 0) return context;

	// Group elided slot indices by message, then partition by kind so each
	// rewrite targets the exact field the provider serializes for that image.
	const elidedByMessage = new Map<number, number[]>();
	const addElided = (index: number) => {
		const mi = slots[index].messageIndex;
		const list = elidedByMessage.get(mi);
		if (list) list.push(index);
		else elidedByMessage.set(mi, [index]);
	};
	for (const index of countElided) addElided(index);
	for (const index of byteElided) addElided(index);

	const messages = context.messages.map((message, mi) => {
		const indices = elidedByMessage.get(mi);
		if (!indices) return message;
		const contentCount = new Set<number>();
		const contentByte = new Set<number>();
		let screenshotElided = false;
		const replayCount: ReplayElision[] = [];
		const replayByte: ReplayElision[] = [];
		for (const index of indices) {
			const slot = slots[index];
			switch (slot.kind) {
				case "content":
					if (countElided.has(index)) contentCount.add(slot.partIndex);
					else contentByte.add(slot.partIndex);
					break;
				case "screenshot":
					screenshotElided = true;
					break;
				case "replay":
					(countElided.has(index) ? replayCount : replayByte).push({
						itemIndex: slot.partIndex,
						nestedIndex: slot.nestedIndex,
					});
					break;
			}
		}
		let next: ProviderMessage = message;
		if (contentCount.size > 0 || contentByte.size > 0) next = applyContentClamp(next, contentCount, contentByte);
		if (screenshotElided) next = applyScreenshotElide(next);
		if (replayCount.length > 0 || replayByte.length > 0) next = applyReplayElide(next, replayCount, replayByte);
		return next;
	});
	return { ...context, messages };
}
