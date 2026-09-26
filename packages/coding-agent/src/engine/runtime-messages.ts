import { EngineTargetError } from "./contracts";
import { runtimeLimits } from "./runtime-protocol";

export function utf8Tail(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text);
	let start = Math.max(0, bytes.length - maxBytes);
	while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
	return bytes.subarray(start).toString("utf8");
}

export function* utf8Chunks(text: string, maxBytes = runtimeLimits.bulkPreviewBytes): Generator<string> {
	// Encode bounded windows, not a second buffer and an array for the complete provider burst.
	for (let start = 0; start < text.length; ) {
		let end = Math.min(text.length, start + maxBytes);
		if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
		if (end <= start)
			throw new EngineTargetError("invalid_request", "Text chunk budget cannot contain one UTF-8 codepoint");
		const bytes = Buffer.from(text.slice(start, end).toWellFormed());
		for (let offset = 0; offset < bytes.length; ) {
			let take = Math.min(bytes.length, offset + maxBytes);
			while (take < bytes.length && (bytes[take] & 0xc0) === 0x80) take--;
			if (take === offset)
				throw new EngineTargetError("invalid_request", "Text chunk budget cannot contain one UTF-8 codepoint");
			yield bytes.subarray(offset, take).toString("utf8");
			offset = take;
		}
		start = end;
	}
}
