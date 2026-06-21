import { describe, expect, it } from "bun:test";
import { Settings } from "../../config/settings";
import { loadCodemapConfig } from "../config";

const AGENT_DIR = "/fake/agent/.omp";

function makeSettings(overrides: Record<string, unknown> = {}): Settings {
	return Settings.isolated(overrides as never);
}

describe("codemap loadCodemapConfig — defaults", () => {
	it("returns schema defaults when only codemap.enabled is set", () => {
		const config = loadCodemapConfig(makeSettings({ "codemap.enabled": true }), AGENT_DIR);
		expect(config.enabled).toBe(true);
		expect(config.autoInject).toBe(true);
		expect(config.tokenBudget).toBe(8000);
		expect(config.maxResults).toBe(20);
		expect(config.maxSummaryChars).toBe(1000);
		expect(config.embedding.variant).toBe("en");
		expect(config.embedding.dimensions).toBe(768);
		expect(config.embedding.model).toBe("BAAI/bge-base-en-v1.5");
		expect(config.turso.autoProvision).toBe(false);
		expect(config.turso.syncUrl).toBe("");
		expect(config.turso.authToken).toBe("");
	});

	it("respects disabled state", () => {
		const config = loadCodemapConfig(makeSettings({ "codemap.enabled": false }), AGENT_DIR);
		expect(config.enabled).toBe(false);
	});

	it("respects autoInject override", () => {
		const config = loadCodemapConfig(
			makeSettings({ "codemap.enabled": true, "codemap.autoInject": false }),
			AGENT_DIR,
		);
		expect(config.autoInject).toBe(false);
	});
});

import * as nodePath from "node:path";
import { getMemoriesDir } from "@oh-my-pi/pi-utils";

describe("codemap loadCodemapConfig — dbPath", () => {
	it("falls back to memoriesDir/codemap/codemap.db when codemap.dbPath is empty", () => {
		const config = loadCodemapConfig(makeSettings({ "codemap.enabled": true }), AGENT_DIR);
		const expected = nodePath.join(getMemoriesDir(AGENT_DIR), "codemap", "codemap.db");
		expect(config.dbPath).toBe(expected);
	});

	it("uses configured codemap.dbPath when set", () => {
		const config = loadCodemapConfig(
			makeSettings({ "codemap.enabled": true, "codemap.dbPath": "/custom/path.db" }),
			AGENT_DIR,
		);
		expect(config.dbPath).toBe("/custom/path.db");
	});
});

describe("codemap loadCodemapConfig — embedding variant", () => {
	it("maps en variant to 768 dimensions and bge-base-en-v1.5", () => {
		const config = loadCodemapConfig(
			makeSettings({ "codemap.enabled": true, "codemap.embedding.variant": "en" }),
			AGENT_DIR,
		);
		expect(config.embedding.variant).toBe("en");
		expect(config.embedding.dimensions).toBe(768);
		expect(config.embedding.model).toBe("BAAI/bge-base-en-v1.5");
	});

	it("maps multilingual variant to 1024 dimensions and multilingual-e5-large", () => {
		const config = loadCodemapConfig(
			makeSettings({ "codemap.enabled": true, "codemap.embedding.variant": "multilingual" }),
			AGENT_DIR,
		);
		expect(config.embedding.variant).toBe("multilingual");
		expect(config.embedding.dimensions).toBe(1024);
		expect(config.embedding.model).toBe("intfloat/multilingual-e5-large");
	});
});

describe("codemap loadCodemapConfig — embedding model override precedence", () => {
	it("explicit codemap.embedding.model overrides variant default", () => {
		const config = loadCodemapConfig(
			makeSettings({
				"codemap.enabled": true,
				"codemap.embedding.model": "custom/model-x",
			}),
			AGENT_DIR,
		);
		expect(config.embedding.model).toBe("custom/model-x");
		// dimensions still driven by variant
		expect(config.embedding.dimensions).toBe(768);
	});

	it("empty-string codemap.embedding.model falls through to variant default", () => {
		const config = loadCodemapConfig(
			makeSettings({ "codemap.enabled": true, "codemap.embedding.model": "   " }),
			AGENT_DIR,
		);
		expect(config.embedding.model).toBe("BAAI/bge-base-en-v1.5");
	});

	it("CODEMAP_EMBEDDING_MODEL env var is used when setting is unset", () => {
		const prev = Bun.env.CODEMAP_EMBEDDING_MODEL;
		Bun.env.CODEMAP_EMBEDDING_MODEL = "env/model";
		try {
			const config = loadCodemapConfig(makeSettings({ "codemap.enabled": true }), AGENT_DIR);
			expect(config.embedding.model).toBe("env/model");
		} finally {
			if (prev === undefined) delete Bun.env.CODEMAP_EMBEDDING_MODEL;
			else Bun.env.CODEMAP_EMBEDDING_MODEL = prev;
		}
	});

	it("explicit setting beats CODEMAP_EMBEDDING_MODEL env var", () => {
		const prev = Bun.env.CODEMAP_EMBEDDING_MODEL;
		Bun.env.CODEMAP_EMBEDDING_MODEL = "env/model";
		try {
			const config = loadCodemapConfig(
				makeSettings({ "codemap.enabled": true, "codemap.embedding.model": "setting/model" }),
				AGENT_DIR,
			);
			expect(config.embedding.model).toBe("setting/model");
		} finally {
			if (prev === undefined) delete Bun.env.CODEMAP_EMBEDDING_MODEL;
			else Bun.env.CODEMAP_EMBEDDING_MODEL = prev;
		}
	});
});

describe("codemap loadCodemapConfig — floor/clamp guards", () => {
	it("clamps tokenBudget below 1000 up to 1000", () => {
		const config = loadCodemapConfig(
			makeSettings({ "codemap.enabled": true, "codemap.tokenBudget": 500 }),
			AGENT_DIR,
		);
		expect(config.tokenBudget).toBe(1000);
	});

	it("floors fractional tokenBudget", () => {
		const config = loadCodemapConfig(
			makeSettings({ "codemap.enabled": true, "codemap.tokenBudget": 8500.7 }),
			AGENT_DIR,
		);
		expect(config.tokenBudget).toBe(8500);
	});

	it("clamps maxResults below 1 up to 1", () => {
		const config = loadCodemapConfig(makeSettings({ "codemap.enabled": true, "codemap.maxResults": 0 }), AGENT_DIR);
		expect(config.maxResults).toBe(1);
	});

	it("clamps maxSummaryChars below 100 up to 100", () => {
		const config = loadCodemapConfig(
			makeSettings({ "codemap.enabled": true, "codemap.maxSummaryChars": 50 }),
			AGENT_DIR,
		);
		expect(config.maxSummaryChars).toBe(100);
	});
});

describe("codemap loadCodemapConfig — turso config", () => {
	it("reads turso syncUrl, authToken, org overrides", () => {
		const config = loadCodemapConfig(
			makeSettings({
				"codemap.enabled": true,
				"codemap.turso.syncUrl": "libsql://example.turso.io",
				"codemap.turso.authToken": "tok-abc",
				"codemap.turso.org": "myorg",
				"codemap.turso.autoProvision": false,
			}),
			AGENT_DIR,
		);
		expect(config.turso.syncUrl).toBe("libsql://example.turso.io");
		expect(config.turso.authToken).toBe("tok-abc");
		expect(config.turso.org).toBe("myorg");
		expect(config.turso.autoProvision).toBe(false);
	});

	it("coerces undefined syncUrl/authToken/org to empty string", () => {
		const config = loadCodemapConfig(makeSettings({ "codemap.enabled": true }), AGENT_DIR);
		expect(config.turso.syncUrl).toBe("");
		expect(config.turso.authToken).toBe("");
		expect(config.turso.org).toBe("");
	});
});
