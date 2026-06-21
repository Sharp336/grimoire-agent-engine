import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { CodemapConfig, CodemapTursoConfig } from "./config";

/**
 * Turso platform API endpoint for database management.
 */
const TURSO_API_BASE = "https://api.turso.tech/v1";

/**
 * Auto-provision a Turso database when autoProvision is enabled and
 * TURSO_API_TOKEN + org are available, but no syncUrl is set yet.
 *
 * Steps:
 *   1. POST to Turso platform API to create a database.
 *   2. Generate a full-access JWT for the database.
 *   3. Derive syncUrl = 'libsql://' + db.Hostname.
 *   4. Persist back via settings.set() so subsequent starts skip provisioning.
 *
 * Idempotent: no-op if syncUrl is already set.
 */
export async function autoProvisionTurso(config: CodemapTursoConfig, settings: Settings): Promise<CodemapTursoConfig> {
	// Skip if already configured
	if (config.syncUrl && config.authToken) return config;
	// Skip if auto-provisioning is disabled
	if (!config.autoProvision) return config;

	const apiToken = Bun.env.TURSO_API_TOKEN?.trim();
	const org = config.org || Bun.env.TURSO_ORG?.trim();
	if (!apiToken || !org) {
		logger.debug("codemap: Turso auto-provision skipped — missing TURSO_API_TOKEN or org");
		return config;
	}

	try {
		// 1. Create database
		const dbName = `codemap-${Date.now()}`;
		const createResp = await fetch(`${TURSO_API_BASE}/organizations/${org}/databases`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ name: dbName, group: "default" }),
		});
		if (!createResp.ok) {
			const body = await createResp.text();
			throw new Error(`Turso API create DB failed: ${createResp.status} ${body}`);
		}
		const created = (await createResp.json()) as { Hostname: string };
		const syncUrl = `libsql://${created.Hostname}`;

		// 2. Generate auth token for the database
		const tokenResp = await fetch(`${TURSO_API_BASE}/organizations/${org}/databases/${dbName}/auth/tokens`, {
			method: "POST",
			headers: { Authorization: `Bearer ${apiToken}` },
		});
		if (!tokenResp.ok) {
			const body = await tokenResp.text();
			throw new Error(`Turso API create token failed: ${tokenResp.status} ${body}`);
		}
		const tokenData = (await tokenResp.json()) as { jwt: string };
		const authToken = tokenData.jwt;

		// 3. Persist back via settings.set() — triggers #queueSave → config.yml
		await settings.set("codemap.turso.syncUrl", syncUrl);
		await settings.set("codemap.turso.authToken", authToken);

		logger.info("codemap: Turso database auto-provisioned", { syncUrl, dbName });

		return {
			...config,
			syncUrl,
			authToken,
		};
	} catch (err) {
		logger.warn("codemap: Turso auto-provision failed, falling back to local-only", {
			error: err instanceof Error ? err.message : String(err),
		});
		return config;
	}
}

/**
 * Resolve the effective Turso connection config, running auto-provisioning if needed.
 * Returns the updated config (with syncUrl+authToken if provisioned).
 */
export async function resolveTursoConfig(config: CodemapConfig, settings: Settings): Promise<CodemapConfig> {
	const updatedTurso = await autoProvisionTurso(config.turso, settings);
	return { ...config, turso: updatedTurso };
}
