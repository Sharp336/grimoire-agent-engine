import * as fs from "node:fs/promises";
import * as path from "node:path";
import { decodeReencodedPasteControls } from "@oh-my-pi/pi-tui/bracketed-paste";

export const PASTE_MARKER_LINE_LIMIT = 10;
export const PASTE_MARKER_CHAR_LIMIT = 1_000;
export const LARGE_PASTE_CHOICES = ["wrapped", "localFile", "inline"] as const;

export type PasteChoice = (typeof LARGE_PASTE_CHOICES)[number];

export interface PendingPasteChoice {
	id: string;
	lineCount: number;
	text: string;
}

export type PasteInsertResult =
	| { kind: "inserted"; text: string; lineCount: number; marker: boolean }
	| { kind: "pending-choice"; pending: PendingPasteChoice };

export interface ResolvedPasteResult {
	text: string;
	lineCount: number;
	marker: boolean;
	localFile?: string;
	fallback?: boolean;
}

export interface PromptDocumentServiceOptions {
	getLocalRoot?: () => string;
}

/**
 * Host-neutral prompt-document handling shared by terminal and RPC composers.
 *
 * The service owns paste marker content and pending large-paste choices. Hosts
 * only insert the returned text and expand the returned editor text at submit;
 * no client needs to understand marker syntax or create local files.
 */
export class PromptDocumentService {
	readonly #getLocalRoot?: () => string;
	readonly #pastes = new Map<number, string>();
	readonly #pending = new Map<string, PendingPasteChoice>();
	#pasteCounter = 0;
	#pendingCounter = 0;
	#fileCounter = 0;

	constructor(options: PromptDocumentServiceOptions = {}) {
		this.#getLocalRoot = options.getLocalRoot;
	}

	normalizePastedText(text: string): string {
		const decodedText = decodeReencodedPasteControls(text);
		const cleanText = decodedText.replace(/\r\n?/g, "\n").normalize("NFC");
		return cleanText.replace(/\t/g, "   ").replace(/[\x00-\x09\x0B-\x1F]/g, "");
	}

	wrapPaste(content: string): string {
		return `<attachment>\n${content}\n</attachment>`;
	}

	insertPastedText(rawText: string, largeMenuThreshold = 0): PasteInsertResult {
		const text = this.normalizePastedText(rawText);
		const lineCount = text.split("\n").length;
		if (largeMenuThreshold > 0 && lineCount >= largeMenuThreshold) {
			const pending: PendingPasteChoice = {
				id: `paste-choice-${++this.#pendingCounter}`,
				lineCount,
				text,
			};
			this.#pending.set(pending.id, pending);
			return { kind: "pending-choice", pending };
		}
		return {
			kind: "inserted",
			text: this.#collapseIfNeeded(text, lineCount),
			lineCount,
			marker: this.#isMarkerSized(text, lineCount),
		};
	}

	resolvePasteChoice(pendingId: string, choice?: PasteChoice): Promise<ResolvedPasteResult> {
		const pending = this.#pending.get(pendingId);
		if (!pending) throw new Error("Paste choice is stale or unknown");
		this.#pending.delete(pendingId);
		const selected = choice ?? "inline";
		if (selected === "localFile") {
			return this.#storeLocalFile(pending.text, pending.lineCount).then(
				localFile => ({
					text: `${localFile} `,
					lineCount: pending.lineCount,
					marker: false,
					localFile,
				}),
				() => ({
					text: this.createPasteMarker(pending.text, pending.lineCount),
					lineCount: pending.lineCount,
					marker: true,
					fallback: true,
				}),
			);
		}
		const content = selected === "wrapped" ? this.wrapPaste(pending.text) : pending.text;
		return Promise.resolve({
			text: this.createPasteMarker(content, pending.lineCount),
			lineCount: pending.lineCount,
			marker: true,
		});
	}

	expandPasteMarkers(text: string): string {
		let expanded = text;
		for (const [id, content] of this.#pastes) {
			const marker = new RegExp(`\\[Paste #${id}(?:, (?:\\+\\d+ lines|\\d+ chars))?\\]`, "g");
			expanded = expanded.replace(marker, () => content);
		}
		return expanded;
	}

	async storeLocalFile(text: string): Promise<string> {
		return this.#storeLocalFile(text, text.split("\n").length);
	}
	createPasteMarker(content: string, lineCount = content.split("\n").length): string {
		const id = ++this.#pasteCounter;
		this.#pastes.set(id, content);
		return lineCount > PASTE_MARKER_LINE_LIMIT
			? `[Paste #${id}, +${lineCount} lines]`
			: `[Paste #${id}, ${content.length} chars]`;
	}

	clear(): void {
		this.#pastes.clear();
		this.#pending.clear();
		this.#pasteCounter = 0;
		this.#pendingCounter = 0;
		this.#fileCounter = 0;
	}

	#isMarkerSized(text: string, lineCount: number): boolean {
		return lineCount > PASTE_MARKER_LINE_LIMIT || text.length > PASTE_MARKER_CHAR_LIMIT;
	}

	#collapseIfNeeded(text: string, lineCount: number): string {
		return this.#isMarkerSized(text, lineCount) ? this.createPasteMarker(text, lineCount) : text;
	}

	async #storeLocalFile(text: string, lineCount: number): Promise<string> {
		if (!this.#getLocalRoot) throw new Error("Local paste storage is unavailable");
		const localRoot = this.#getLocalRoot();
		await fs.mkdir(localRoot, { recursive: true });
		for (;;) {
			const name = `paste-${++this.#fileCounter}.md`;
			const target = path.join(localRoot, name);
			try {
				await fs.access(target);
				continue;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const temporary = `${target}.${process.pid}.${this.#fileCounter}.tmp`;
			try {
				await fs.writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
				await fs.rename(temporary, target);
				void lineCount;
				return `local://${name}`;
			} catch (error) {
				await fs.rm(temporary, { force: true }).catch(() => undefined);
				if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
				throw error;
			}
		}
	}
}

export function expandPromptPasteMarkers(text: string, service: PromptDocumentService): string {
	return service.expandPasteMarkers(text);
}
