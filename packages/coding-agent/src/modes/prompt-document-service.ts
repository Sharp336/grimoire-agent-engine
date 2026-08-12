import * as path from "node:path";
import { resolveLocalRoot } from "../internal-urls";

export type PromptPasteResolution = "wrapped" | "localFile" | "inline";

export function normalizePromptPaste(text: string): string {
	return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

export function wrapPromptPaste(text: string): string {
	return `<attachment>\n${normalizePromptPaste(text)}\n</attachment>`;
}

/** Shared session-local document writer for TUI and RPC composer paste flows. */
export class PromptDocumentService {
	#counter = 0;

	constructor(private readonly session: { getArtifactsDir(): string | null; getSessionId(): string | null }) {}

	async writeLocalPaste(text: string): Promise<string> {
		const localRoot = resolveLocalRoot({
			getArtifactsDir: () => this.session.getArtifactsDir(),
			getSessionId: () => this.session.getSessionId(),
		});
		let name: string;
		let filePath: string;
		do {
			this.#counter += 1;
			name = `paste-${this.#counter}.md`;
			filePath = path.join(localRoot, name);
		} while (await Bun.file(filePath).exists());
		await Bun.write(filePath, normalizePromptPaste(text));
		return `local://${name}`;
	}
}
