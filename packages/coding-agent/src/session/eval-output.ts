import type { ArtifactAllocationContext, ArtifactDescriptor, ArtifactManager, ArtifactReference } from "./artifacts";
import { truncateTailBytes } from "./streaming-output";

/** Default byte budget for inline eval output sent to a transport. */
export const DEFAULT_EVAL_INLINE_PREVIEW_BYTES = 256 * 1024;

export interface EvalOutputMaterializationOptions {
	/** Maximum UTF-8 bytes returned in the inline tail preview. */
	previewBytes?: number;
	/** Provenance attached when a new eval artifact is allocated. */
	related?: ArtifactAllocationContext;
	/** Artifact filename/tool provenance segment. */
	toolType?: string;
	/** Existing complete artifact to reference instead of allocating from the inline preview. */
	artifactId?: string;
}

/** Bounded eval output presented inline while the complete bytes remain readable. */
export interface EvalOutputPreview {
	text: string;
	byteLength: number;
	totalBytes: number;
	truncated: boolean;
	direction: "none" | "tail";
}

/** Complete eval output plus its bounded transport preview and artifact reference. */
export interface EvalOutputMaterialization {
	preview: EvalOutputPreview;
	artifact: ArtifactDescriptor;
	artifactRef: ArtifactReference;
}

function resolvePreviewBytes(previewBytes: number | undefined): number {
	const resolved = previewBytes ?? DEFAULT_EVAL_INLINE_PREVIEW_BYTES;
	if (!Number.isSafeInteger(resolved) || resolved < 0) {
		throw new RangeError("Eval inline preview byte limit must be a non-negative safe integer");
	}
	return resolved;
}

function previewFromBytes(output: string | Uint8Array, totalBytes: number, previewBytes: number): EvalOutputPreview {
	const preview = truncateTailBytes(output, previewBytes);
	const truncated = totalBytes > preview.bytes;
	return {
		text: preview.text,
		byteLength: preview.bytes,
		totalBytes,
		truncated,
		direction: truncated ? "tail" : "none",
	};
}

/**
 * Materializes complete eval bytes in the session artifact store and derives a
 * bounded UTF-8-safe tail preview for transport. Each call owns its preview
 * state, so a rolling-tail reset from a previous eval cannot leak into a later
 * result.
 */
export async function materializeEvalOutput(
	manager: ArtifactManager,
	output: string | Uint8Array,
	options: EvalOutputMaterializationOptions = {},
): Promise<EvalOutputMaterialization> {
	const previewBytes = resolvePreviewBytes(options.previewBytes);
	if (options.artifactId !== undefined) {
		const descriptor = await manager.describe(options.artifactId);
		if (descriptor.lifecycle !== "available" || descriptor.byteLength === null) {
			throw new Error(`Eval output artifact did not become available: ${options.artifactId}`);
		}
		return {
			preview: previewFromBytes(output, descriptor.byteLength, previewBytes),
			artifact: descriptor,
			artifactRef: `artifact://${descriptor.id}`,
		};
	}
	const allocation = await manager.allocatePath(options.toolType ?? "eval", options.related ?? {});
	try {
		await Bun.write(allocation.path, output);
	} catch (cause) {
		await manager.cancel(allocation.id, "eval_output_materialization_failed").catch(() => undefined);
		throw cause;
	}

	let descriptor: ArtifactDescriptor;
	try {
		descriptor = await manager.describe(allocation.id);
	} catch (cause) {
		await manager.cancel(allocation.id, "eval_output_materialization_failed").catch(() => undefined);
		throw cause;
	}
	if (descriptor.lifecycle !== "available" || descriptor.byteLength === null) {
		await manager.cancel(allocation.id, "eval_output_materialization_failed").catch(() => undefined);
		throw new Error(`Eval output artifact did not become available: ${allocation.id}`);
	}
	return {
		preview: previewFromBytes(output, descriptor.byteLength, previewBytes),
		artifact: descriptor,
		artifactRef: `artifact://${descriptor.id}`,
	};
}
