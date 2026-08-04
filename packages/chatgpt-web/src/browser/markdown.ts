import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export const CHATGPT_MARKDOWN_MAX_HTML_BYTES = 1_048_576;
export const CHATGPT_MARKDOWN_MAX_OUTPUT_BYTES = 1_048_576;
export const CHATGPT_MARKDOWN_MAX_LINK_TARGET_BYTES = 2_048;
export const CHATGPT_MARKDOWN_MAX_TERMINAL_LABEL_BYTES = 4_096;

const MAX_TERMINAL_LINK_BYTES = 16_384;
const UTF8 = new TextEncoder();
const URL_FORBIDDEN_CHARACTER = /[\u0000-\u0020\u007f-\u009f]/;
const TERMINAL_LABEL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const INVALID_PERCENT_ESCAPE = /%(?![0-9a-f]{2})/i;

export type ChatGptMarkdownErrorCode =
	| "invalid_input"
	| "input_too_large"
	| "output_too_large"
	| "conversion_failed"
	| "transform_failed"
	| "non_append_only"
	| "terminal_label_too_large";

const ERROR_MESSAGES: Record<ChatGptMarkdownErrorCode, string> = {
	invalid_input: "Invalid ChatGPT Markdown input",
	input_too_large: "ChatGPT HTML exceeds the Markdown input limit",
	output_too_large: "ChatGPT Markdown exceeds the output limit",
	conversion_failed: "ChatGPT Markdown conversion failed",
	transform_failed: "ChatGPT Markdown transform failed",
	non_append_only: "ChatGPT Markdown is not append-only",
	terminal_label_too_large: "Terminal link label exceeds the output limit",
};

/** A bounded, package-owned error that never includes browser content or a caught exception. */
export class ChatGptMarkdownError extends Error {
	readonly code: ChatGptMarkdownErrorCode;

	constructor(code: ChatGptMarkdownErrorCode) {
		super(ERROR_MESSAGES[code]);
		this.name = "ChatGptMarkdownError";
		this.code = code;
	}
}

function utf8LengthWithin(value: string, maximum: number): boolean {
	return value.length <= maximum && UTF8.encode(value).byteLength <= maximum;
}

function assertBoundedInput(value: unknown): asserts value is string {
	if (typeof value !== "string") throw new ChatGptMarkdownError("invalid_input");
	if (!utf8LengthWithin(value, CHATGPT_MARKDOWN_MAX_HTML_BYTES)) {
		throw new ChatGptMarkdownError("input_too_large");
	}
}

function assertBoundedMarkdown(value: unknown): asserts value is string {
	if (typeof value !== "string") throw new ChatGptMarkdownError("transform_failed");
	if (!utf8LengthWithin(value, CHATGPT_MARKDOWN_MAX_OUTPUT_BYTES)) {
		throw new ChatGptMarkdownError("output_too_large");
	}
}

function authorityContainsUserInfo(target: string): boolean {
	const schemeEnd = target.indexOf(":");
	const remainder = schemeEnd < 0 ? target : target.slice(schemeEnd + 1);
	if (!remainder.startsWith("//")) return false;
	const authority = remainder.slice(2).split(/[/?#]/, 1)[0] ?? "";
	return authority.includes("@");
}

/**
 * Return a link target only when it is a bounded, unambiguous absolute web or mail URL.
 * Unsafe targets deliberately become plain text at the caller rather than being repaired.
 */
export function sanitizeLinkTarget(target: string | null | undefined): string | null {
	if (typeof target !== "string" || target.length === 0) return null;
	if (!utf8LengthWithin(target, CHATGPT_MARKDOWN_MAX_LINK_TARGET_BYTES)) return null;
	if (URL_FORBIDDEN_CHARACTER.test(target) || target.includes("\\") || INVALID_PERCENT_ESCAPE.test(target)) {
		return null;
	}

	let parsed: URL;
	try {
		parsed = new URL(target);
	} catch {
		return null;
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:" && parsed.protocol !== "mailto:") return null;
	if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !/^https?:\/\//i.test(target)) return null;
	if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length === 0) return null;
	if (parsed.protocol === "mailto:" && parsed.pathname.length === 0) return null;
	if (parsed.username.length > 0 || parsed.password.length > 0 || authorityContainsUserInfo(target)) return null;

	return target;
}

function markdownDestination(target: string): string {
	return target.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

type TurndownElement = {
	nodeName: string;
	parentNode: TurndownElement | null;
	nextSibling: unknown;
	children: ArrayLike<unknown>;
	getAttribute(name: string): string | null;
};

const turndown = new TurndownService({
	headingStyle: "atx",
	bulletListMarker: "-",
	codeBlockStyle: "fenced",
	fence: "```",
	emDelimiter: "*",
	strongDelimiter: "**",
	linkStyle: "inlined",
});

turndown.use(gfm);
turndown.remove(["button", "input", "select", "textarea", "option", "optgroup", "datalist", "script", "style"]);
turndown.addRule("removeImages", {
	filter: node => ["IMG", "PICTURE", "SOURCE"].includes(node.nodeName.toUpperCase()),
	replacement: () => "",
});
turndown.addRule("removeSvg", {
	filter: node => node.nodeName.toUpperCase() === "SVG",
	replacement: () => "",
});
turndown.addRule("safeLinks", {
	filter: "a",
	replacement: (content, node) => {
		const target = sanitizeLinkTarget((node as unknown as TurndownElement).getAttribute("href"));
		return target ? `[${content}](${markdownDestination(target)})` : content;
	},
});
turndown.addRule("compactListItem", {
	filter: "li",
	replacement: (content, node, options) => {
		const element = node as unknown as TurndownElement;
		const parent = element.parentNode;
		let prefix = `${options.bulletListMarker} `;
		if (parent?.nodeName.toUpperCase() === "OL") {
			const startValue = parent.getAttribute("start") ?? "1";
			const start = Number(startValue);
			const index = Array.prototype.indexOf.call(parent.children, node) as number;
			prefix = `${Number.isSafeInteger(start) ? start + index : 1 + index}. `;
		}
		const normalized = content.replace(/^\n+|\n+$/g, "").replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
		return `${prefix}${normalized}${element.nextSibling ? "\n" : ""}`;
	},
});

export function chatGptHtmlToMarkdown(html: string): string {
	assertBoundedInput(html);
	if (!html.trim()) return "";

	let markdown: string;
	try {
		markdown = turndown.turndown(html).trim();
	} catch (error) {
		if (error instanceof ChatGptMarkdownError) throw error;
		throw new ChatGptMarkdownError("conversion_failed");
	}
	assertBoundedMarkdown(markdown);
	return markdown;
}

function sanitizeTerminalLabel(label: unknown): string {
	if (typeof label !== "string") throw new ChatGptMarkdownError("invalid_input");
	if (!utf8LengthWithin(label, CHATGPT_MARKDOWN_MAX_TERMINAL_LABEL_BYTES)) {
		throw new ChatGptMarkdownError("terminal_label_too_large");
	}
	return label.replace(TERMINAL_LABEL_CONTROL, "�");
}

/** Emit OSC 8 only for a safe target; otherwise return the same control-free visible label. */
export function safeTerminalLink(label: string, target: string | null | undefined): string {
	const visibleLabel = sanitizeTerminalLabel(label);
	const safeTarget = sanitizeLinkTarget(target);
	if (!safeTarget) return visibleLabel;

	const linked = `\x1b]8;;${safeTarget}\x1b\\${visibleLabel}\x1b]8;;\x1b\\`;
	return utf8LengthWithin(linked, MAX_TERMINAL_LINK_BYTES) ? linked : visibleLabel;
}

/**
 * Converts append-only rendered ChatGPT blocks into text deltas. A candidate prefix must be
 * observed twice before it is committed; finish emits the remaining unstable suffix once.
 */
export class ChatGptMarkdownStream {
	private candidate = "";
	private committed = "";

	constructor(private readonly transform: (markdown: string) => string = markdown => markdown) {}

	private convert(html: string): string {
		const markdown = chatGptHtmlToMarkdown(html);
		let transformed: unknown;
		try {
			transformed = this.transform(markdown);
		} catch {
			throw new ChatGptMarkdownError("transform_failed");
		}
		assertBoundedMarkdown(transformed);
		return transformed;
	}

	observeStableHtml(html: string): string {
		const next = this.convert(html);
		if (!next.startsWith(this.committed)) throw new ChatGptMarkdownError("non_append_only");
		if (next !== this.candidate) {
			this.candidate = next;
			return "";
		}
		const delta = next.slice(this.committed.length);
		this.committed = next;
		return delta;
	}

	finish(html: string): { markdown: string; delta: string } {
		const markdown = this.convert(html);
		if (!markdown.startsWith(this.committed)) throw new ChatGptMarkdownError("non_append_only");
		const delta = markdown.slice(this.committed.length);
		this.committed = markdown;
		this.candidate = markdown;
		return { markdown, delta };
	}
}
