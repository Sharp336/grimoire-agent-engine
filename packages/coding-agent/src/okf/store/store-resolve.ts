/**
 * OKF store resolver — picks the right store adapter based on `okf.store`
 * setting and Hindsight server availability.
 *
 * Resolution order:
 *   - `sqlite` → always use local SQLite FTS5.
 *   - `hindsight` → always use Hindsight (fails if no server configured).
 *   - `auto` → use Hindsight if `hindsight.apiUrl` is set and healthy,
 *     otherwise fall back to SQLite.
 */

import * as path from "node:path";
import type { Settings } from "../../config/settings";
import { createHindsightClient } from "../../hindsight/client";
import { isHindsightConfigured, loadHindsightConfig } from "../../hindsight/config";
import { getBundleRoot } from "../bundle";
import { HindsightOkfStore } from "./store-hindsight";
import { SqliteOkfStore } from "./store-sqlite";
import type { OkfStore } from "./types";

export interface ResolveOkfStoreResult {
	store: OkfStore;
	backend: "sqlite" | "hindsight";
}

/**
 * Resolve the OKF store for a session.
 *
 * @param settings  The session settings.
 * @param cwd       The session's working directory (for deriving the bundle root
 *                  and Hindsight bank scope).
 * @param customBundleDir Optional override for the bundle root.
 */
export async function resolveOkfStore(
	settings: Settings,
	cwd: string,
	customBundleDir?: string,
): Promise<ResolveOkfStoreResult> {
	const choice = settings.get("okf.store") as "auto" | "hindsight" | "sqlite";
	const bundleRoot = path.resolve(customBundleDir ?? getBundleRoot(cwd));

	// Try Hindsight if requested or auto-detected.
	if (choice === "hindsight" || choice === "auto") {
		const hindsightConfig = loadHindsightConfig(settings);
		if (isHindsightConfigured(hindsightConfig)) {
			try {
				const client = createHindsightClient(hindsightConfig);
				// Derive a dedicated OKF bank from the hindsight bank settings.
				const okfBankSetting = settings.get("okf.bankId") as string | undefined;
				const bankPrefix = hindsightConfig.bankIdPrefix ?? "";
				const baseBank = okfBankSetting?.trim() || "okf";
				const bankId = bankPrefix ? `${bankPrefix}-${baseBank}` : baseBank;
				const store = new HindsightOkfStore(client, bankId);

				// Health probe for auto mode.
				if (choice === "auto") {
					const healthy = await probeHealth(store);
					if (healthy) return { store, backend: "hindsight" };
					// Fall through to SQLite.
				} else {
					return { store, backend: "hindsight" };
				}
			} catch {
				// Hindsight client creation failed; fall through to SQLite.
			}
		}
		if (choice === "hindsight") {
			// Explicitly requested but not configured — log and fall back.
			console.warn("[okf] Hindsight store requested but not configured; falling back to SQLite.");
		}
	}

	// Default: SQLite.
	const store = new SqliteOkfStore(path.join(bundleRoot, "okf.db"));
	return { store, backend: "sqlite" };
}

/** Cheap health probe: try to count documents, catch errors. */
async function probeHealth(store: OkfStore): Promise<boolean> {
	try {
		await store.count();
		return true;
	} catch {
		return false;
	}
}
