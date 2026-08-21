import { truncateHeadBytes, truncateTailBytes } from "./streaming-output";

export const PROGRESS_PREVIEW_MAX_BYTES = 3_000;

export interface ProgressPreview {
	text?: string;
	head?: string;
	tail?: string;
	truncated: boolean;
}

const PROGRESS_PREVIEW_HEAD_BYTES = Math.floor(PROGRESS_PREVIEW_MAX_BYTES / 2);
const PROGRESS_PREVIEW_TAIL_BYTES = PROGRESS_PREVIEW_MAX_BYTES - PROGRESS_PREVIEW_HEAD_BYTES;

/** Build one UTF-8-safe head/tail preview shared by broker transport and model delivery. */
export function buildProgressPreview(text: string, sourceTruncated = false): ProgressPreview {
	const fullBytes = Buffer.byteLength(text, "utf8");
	if (!sourceTruncated && fullBytes <= PROGRESS_PREVIEW_MAX_BYTES) {
		return { text, truncated: false };
	}
	const retainedBytes = Math.min(fullBytes, PROGRESS_PREVIEW_MAX_BYTES);
	const headBytes = Math.floor(retainedBytes / 2);
	const tailBytes = retainedBytes - headBytes;
	return {
		head: truncateHeadBytes(text, headBytes).text,
		tail: truncateTailBytes(text, tailBytes).text,
		truncated: true,
	};
}

/**
 * Incrementally retains one bounded progress preview. Once the byte budget is
 * exceeded, the prefix is fixed and only the rolling suffix changes, so a
 * chatty 200 ms window never needs to materialize its complete inline text.
 */
export class ProgressPreviewAccumulator {
	#text = "";
	#head = "";
	#tail = "";
	#truncated = false;
	#sourceTruncated = false;

	append(text: string, sourceTruncated = false): void {
		if (text.length === 0) return;
		const chunk = this.#hasOutput() ? `\n${text}` : text;
		this.#sourceTruncated ||= sourceTruncated;
		if (this.#truncated) {
			this.#tail = truncateTailBytes(`${this.#tail}${chunk}`, PROGRESS_PREVIEW_TAIL_BYTES).text;
			return;
		}

		const combined = `${this.#text}${chunk}`;
		if (Buffer.byteLength(combined, "utf8") <= PROGRESS_PREVIEW_MAX_BYTES) {
			this.#text = combined;
			return;
		}

		this.#head = truncateHeadBytes(combined, PROGRESS_PREVIEW_HEAD_BYTES).text;
		this.#tail = truncateTailBytes(combined, PROGRESS_PREVIEW_TAIL_BYTES).text;
		this.#text = "";
		this.#truncated = true;
	}

	appendPreview(preview: ProgressPreview): void {
		this.append(preview.text ?? `${preview.head ?? ""}${preview.tail ?? ""}`, preview.truncated);
	}

	take(): ProgressPreview | undefined {
		if (!this.#hasOutput()) return undefined;
		const preview = this.#truncated
			? { head: this.#head, tail: this.#tail, truncated: true }
			: buildProgressPreview(this.#text, this.#sourceTruncated);
		this.clear();
		return preview;
	}

	clear(): void {
		this.#text = "";
		this.#head = "";
		this.#tail = "";
		this.#truncated = false;
		this.#sourceTruncated = false;
	}

	#hasOutput(): boolean {
		return this.#text.length > 0 || this.#head.length > 0 || this.#tail.length > 0;
	}
}

/** Merge two already-bounded windows while retaining only their outer head and tail. */
export function mergeProgressPreviews(left: ProgressPreview, right: ProgressPreview): ProgressPreview {
	const accumulator = new ProgressPreviewAccumulator();
	accumulator.appendPreview(left);
	accumulator.appendPreview(right);
	return accumulator.take()!;
}
