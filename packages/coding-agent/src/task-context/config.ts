import * as path from "node:path";
import { getMemoriesDir } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";

export interface CodemapTursoConfig {
	syncUrl: string;
	authToken: string;
	autoProvision: boolean;
	org: string;
}

export interface CodemapEmbeddingConfig {
	model: string;
	variant: "en" | "multilingual";
	apiUrl: string | undefined;
	apiKey: string | undefined;
	dimensions: number;
}

export interface CodemapConfig {
	enabled: boolean;
	autoInject: boolean;
	dbPath: string;
	tokenBudget: number;
	maxResults: number;
	maxSummaryChars: number;
	turso: CodemapTursoConfig;
	embedding: CodemapEmbeddingConfig;
}

export function loadCodemapConfig(settings: Settings, agentDir: string): CodemapConfig {
	const configuredDbPath = settings.get("codemap.dbPath");
	const dbPath = configuredDbPath || path.join(getMemoriesDir(agentDir), "codemap", "codemap.db");
	const embeddingVariant = settings.get("codemap.embedding.variant");
	const embeddingOverride = settings.get("codemap.embedding.model");
	const variantModel =
		embeddingVariant === "multilingual" ? "intfloat/multilingual-e5-large" : "BAAI/bge-base-en-v1.5";
	const embeddingModel = embeddingOverride?.trim() || Bun.env.CODEMAP_EMBEDDING_MODEL?.trim() || variantModel;
	const dimensions = embeddingVariant === "multilingual" ? 1024 : 768;
	return {
		enabled: settings.get("codemap.enabled"),
		autoInject: settings.get("codemap.autoInject"),
		dbPath,
		tokenBudget: Math.max(1000, Math.floor(settings.get("codemap.tokenBudget"))),
		maxResults: Math.max(1, Math.floor(settings.get("codemap.maxResults"))),
		maxSummaryChars: Math.max(100, Math.floor(settings.get("codemap.maxSummaryChars"))),
		turso: {
			syncUrl: settings.get("codemap.turso.syncUrl") ?? "",
			authToken: settings.get("codemap.turso.authToken") ?? "",
			autoProvision: settings.get("codemap.turso.autoProvision"),
			org: settings.get("codemap.turso.org") ?? "",
		},
		embedding: {
			model: embeddingModel,
			variant: embeddingVariant,
			apiUrl: settings.get("codemap.embedding.apiUrl"),
			apiKey: settings.get("codemap.embedding.apiKey"),
			dimensions,
		},
	};
}
