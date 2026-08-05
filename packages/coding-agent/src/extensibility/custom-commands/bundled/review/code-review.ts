import { prompt } from "@oh-my-pi/pi-utils";
import type {
	CustomCommand,
	CustomCommandAPI,
	CustomCommandContext,
} from "../../../../extensibility/custom-commands/types";
import {
	type CodeReviewAnnotation,
	CodeReviewOverlay,
	type CodeReviewOverlayResult,
} from "../../../../modes/components/code-review-overlay";
import codeReviewAnnotationsTemplate from "../../../../prompts/code-review-annotations.md" with { type: "text" };
import { buildHeadlessReviewPrompt } from ".";
import { buildReviewPromptForTarget, resolveLocalReviewTarget, selectLocalReviewKind } from "./shared";

interface AnnotationTemplateEntry extends CodeReviewAnnotation {
	pathLabel: string;
	lineLabel: string;
}

function annotationPathLabel(annotation: CodeReviewAnnotation): string {
	const renamed = annotation.oldPath && annotation.newPath && annotation.oldPath !== annotation.newPath;
	const path = renamed ? `${annotation.oldPath} → ${annotation.newPath}` : annotation.path;
	return annotation.occurrence > 1 ? `${path} (${annotation.occurrence})` : path;
}

function annotationLineLabel(annotation: CodeReviewAnnotation): string {
	if (annotation.oldLine !== undefined && annotation.newLine !== undefined) {
		return `old line ${annotation.oldLine}, new line ${annotation.newLine}`;
	}
	if (annotation.oldLine !== undefined) return `old line ${annotation.oldLine}`;
	if (annotation.newLine !== undefined) return `new line ${annotation.newLine}`;
	return "diff metadata";
}

function annotationTemplateEntries(annotations: readonly CodeReviewAnnotation[]): AnnotationTemplateEntry[] {
	return annotations.map(annotation => ({
		...annotation,
		pathLabel: annotationPathLabel(annotation),
		lineLabel: annotationLineLabel(annotation),
	}));
}

export function formatCodeReviewAnnotations(
	annotations: readonly CodeReviewAnnotation[],
	options: { forReviewer: boolean; supplementalInstructions?: string },
): string | undefined {
	if (annotations.length === 0 && !options.supplementalInstructions?.trim()) return undefined;
	return prompt.render(codeReviewAnnotationsTemplate, {
		forReviewer: options.forReviewer,
		annotations: annotationTemplateEntries(annotations),
		supplementalInstructions: options.supplementalInstructions?.trim(),
	});
}

export class CodeReviewCommand implements CustomCommand {
	name = "code-review";
	description = "Annotate a diff before review";

	constructor(private api: CustomCommandAPI) {}

	async execute(args: string[], ctx: CustomCommandContext): Promise<string | undefined> {
		const supplementalInstructions = args.join(" ").trim() || undefined;
		if (!ctx.hasUI) return buildHeadlessReviewPrompt(supplementalInstructions);

		const kind = await selectLocalReviewKind(ctx.ui);
		if (!kind) return undefined;
		const target = await resolveLocalReviewTarget(kind, this.api.cwd, ctx.ui);
		if (!target) return undefined;
		if (!target.rawDiff.trim()) {
			ctx.ui.notify(target.emptyMessage, "warning");
			return undefined;
		}
		if (target.snapshot.files.length === 0) {
			ctx.ui.notify(target.filteredMessage ?? "No reviewable files (all changes filtered out)", "warning");
			return undefined;
		}

		const result = await ctx.ui.custom<CodeReviewOverlayResult | undefined>(
			(tui, _theme, done) =>
				new CodeReviewOverlay(tui, target.snapshot.files, target.mode, {
					onComplete: done,
					onWarning: message => ctx.ui.notify(message, "warning"),
				}),
			{ overlay: true, fullscreen: true, mouseTracking: false },
		);
		if (!result) return undefined;

		if (result.action === "paste") {
			const formatted = formatCodeReviewAnnotations(result.annotations, { forReviewer: false });
			if (formatted) ctx.ui.pasteToEditor(formatted);
			return undefined;
		}

		const additionalInstructions = formatCodeReviewAnnotations(result.annotations, {
			forReviewer: true,
			supplementalInstructions,
		});
		return buildReviewPromptForTarget(target, ctx.ui, additionalInstructions);
	}
}

export default CodeReviewCommand;
