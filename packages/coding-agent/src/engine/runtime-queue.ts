import { type EngineInboxItem, EngineTargetError } from "./contracts";
import { type RuntimeAccess, runtimeLimits, validateRuntimeValue } from "./runtime-protocol";

export interface RuntimeQueueRequest extends RuntimeAccess {
	agentInstanceRef: string;
	queueId?: string;
	cursor?: string;
	limit?: number;
}

type QueueField = "deliveryPayload" | "annotation" | "sender";

type QueueText = Partial<Record<QueueField, string>> & { deliveryPayload: string };

type QueueBytes = Record<QueueField, number>;

type PublicQueueFields = Pick<
	EngineInboxItem,
	| "queueId"
	| "sourceType"
	| "sourceEventId"
	| "sender"
	| "deliveryPayload"
	| "annotation"
	| "deliverAt"
	| "wakeIntent"
	| "position"
	| "disposition"
	| "revision"
	| "createdAt"
	| "updatedAt"
>;

const fields = ["deliveryPayload", "annotation", "sender"] as const;

const resourceKeys = {
	deliveryPayload: "resource",
	annotation: "annotationResource",
	sender: "senderResource",
} as const;

function utf8Prefix(bytes: Uint8Array, maximum = bytes.length): string {
	let end = Math.min(maximum, bytes.length);
	const decoder = new TextDecoder("utf-8", { fatal: true });
	for (let removed = 0; removed < 4; removed++, end--) {
		try {
			return decoder.decode(bytes.subarray(0, end));
		} catch {
			if (end === 0) break;
		}
	}
	throw new EngineTargetError("invalid_request", "Stored queue text is not UTF-8");
}

function prefix(text: string, maximum: number): string {
	let end = Math.min(maximum, text.length);
	const last = text.charCodeAt(end - 1);
	if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
	return utf8Prefix(Buffer.from(text.slice(0, end)), maximum);
}

/** A public projection only; canonical queue source/body and delivery semantics are retained. */
export function publicRuntimeQueueItem(
	agentInstanceRef: string,
	item: PublicQueueFields,
	lengths?: QueueBytes,
): Record<string, unknown> {
	const text: QueueText = { deliveryPayload: item.deliveryPayload };
	if (item.annotation !== undefined) text.annotation = item.annotation;
	if (item.sender !== undefined) text.sender = item.sender;
	const bytes = lengths ?? {
		deliveryPayload: Buffer.byteLength(text.deliveryPayload),
		annotation: Buffer.byteLength(text.annotation ?? ""),
		sender: Buffer.byteLength(text.sender ?? ""),
	};
	const result: Record<string, unknown> = {
		queueId: item.queueId,
		sourceType: item.sourceType,
		...(item.sourceEventId ? { sourceEventId: item.sourceEventId } : {}),
		...(item.deliverAt !== undefined ? { deliverAt: item.deliverAt } : {}),
		wakeIntent: item.wakeIntent,
		position: item.position,
		disposition: item.disposition,
		revision: item.revision,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
	};
	const truncated = fields.some(field => Buffer.byteLength(text[field] ?? "") < bytes[field]);
	if (
		truncated ||
		fields.reduce((sum, field) => sum + bytes[field], 0) > runtimeLimits.liveChangeBytes ||
		Buffer.byteLength(JSON.stringify({ ...result, ...text, partial: false })) >
			runtimeLimits.liveChangeBytes - 2 * runtimeLimits.bulkPreviewBytes
	) {
		for (const field of fields)
			if (text[field] !== undefined)
				text[field] = prefix(text[field]!, Math.floor(runtimeLimits.bulkPreviewBytes / 3));
		while (Buffer.byteLength(JSON.stringify(text)) > runtimeLimits.bulkPreviewBytes) {
			const longest = fields.reduce((left, right) =>
				(text[left]?.length ?? 0) > (text[right]?.length ?? 0) ? left : right,
			);
			text[longest] = prefix(text[longest]!, Math.floor(Buffer.byteLength(text[longest]!) / 2));
		}
	}
	Object.assign(result, text, { partial: Buffer.byteLength(text.deliveryPayload) < bytes.deliveryPayload });
	for (const field of fields) {
		if (Buffer.byteLength(text[field] ?? "") >= bytes[field]) continue;
		result[resourceKeys[field]] = {
			kind: "queue_item",
			agentInstanceRef,
			queueId: item.queueId,
			revision: item.revision,
			field,
			mediaType: "text/plain; charset=utf-8",
			bytes: bytes[field],
		};
	}
	validateRuntimeValue("queueItem", result);
	return result;
}
