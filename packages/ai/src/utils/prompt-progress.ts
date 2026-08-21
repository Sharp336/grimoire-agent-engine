import { isPromise } from "node:util/types";
import type { Api, Model, PromptProgress, StreamOptions } from "../types";

/** Deliver diagnostic prompt progress without allowing observer failures to affect generation. */
export function notifyPromptProgress(
	observer: StreamOptions["onPromptProgress"] | undefined,
	progress: PromptProgress,
	model?: Model<Api>,
): void {
	if (!observer) return;
	try {
		const result = observer(progress, model) as unknown;
		if (isPromise(result)) void result.catch(() => {});
	} catch {
		// Prompt-progress observers are diagnostic/UI-only.
	}
}
