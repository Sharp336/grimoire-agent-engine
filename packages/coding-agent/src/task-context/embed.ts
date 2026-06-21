import { logger } from "@oh-my-pi/pi-utils";
import { MnemopiEmbedClient, type MnemopiSubprocessEmbeddingModel } from "../mnemopi/embed-client";
import type { CodemapEmbeddingConfig } from "./config";

/**
 * Decoupled embedding client for codemap. Creates an independent
 * MnemopiEmbedClient instance — NOT the mnemopi singleton — so codemap
 * embeddings work regardless of whether memory.backend is mnemopi, off,
 * or anything else.
 *
 * Embedding is lazy: the subprocess is spawned only when embed() is first
 * called, and the model is loaded only on first use. set_file_summary writes
 * do NOT trigger embedding — embeddings are generated on retrieval.
 */
let codemapEmbedClient: MnemopiEmbedClient | null = null;
let codemapEmbedModel: MnemopiSubprocessEmbeddingModel | null = null;
let codemapEmbedModelKey = "";

function getEmbedClient(): MnemopiEmbedClient {
	codemapEmbedClient ??= new MnemopiEmbedClient();
	return codemapEmbedClient;
}

async function ensureModel(config: CodemapEmbeddingConfig): Promise<MnemopiSubprocessEmbeddingModel | null> {
	const key = `${config.model}:${config.apiUrl ?? "local"}`;
	if (codemapEmbedModel && key === codemapEmbedModelKey) return codemapEmbedModel;
	codemapEmbedModelKey = key;
	codemapEmbedModel = null; // Reset on model change

	const client = getEmbedClient();
	codemapEmbedModel = await client.initialize(config.model, undefined);
	if (!codemapEmbedModel) {
		logger.warn("codemap: embedding model initialization failed", { model: config.model });
	}
	return codemapEmbedModel;
}

/**
 * Embed a single text string into a vector.
 * Returns null if embeddings are unavailable (model not installed, subprocess failure).
 */
export async function embedText(text: string, config: CodemapEmbeddingConfig): Promise<number[] | null> {
	const model = await ensureModel(config);
	if (!model) return null;
	try {
		const vectors: number[][] = [];
		for await (const batch of model.embed([text], 1)) {
			vectors.push(...batch);
		}
		return vectors[0] ?? null;
	} catch (err) {
		logger.debug("codemap: embedding generation failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/**
 * Embed multiple text strings in a single batch.
 * Returns null array element per text if embeddings are unavailable.
 */
export async function embedBatch(texts: string[], config: CodemapEmbeddingConfig): Promise<(number[] | null)[]> {
	const model = await ensureModel(config);
	if (!model) return texts.map(() => null);
	try {
		const vectors: number[][] = [];
		for await (const batch of model.embed(texts, 32)) {
			vectors.push(...batch);
		}
		// Map results back to input texts
		return texts.map((_, i) => vectors[i] ?? null);
	} catch (err) {
		logger.debug("codemap: batch embedding generation failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		return texts.map(() => null);
	}
}

/** Shutdown the codemap embedding subprocess. Called on agent shutdown. */
export async function shutdownCodemapEmbedClient(): Promise<void> {
	codemapEmbedModel = null;
	codemapEmbedModelKey = "";
	if (codemapEmbedClient) {
		await codemapEmbedClient.terminate();
		codemapEmbedClient = null;
	}
}
