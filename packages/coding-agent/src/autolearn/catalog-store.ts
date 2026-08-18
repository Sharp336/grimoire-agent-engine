/**
 * Filesystem-authoritative procedure catalog.
 *
 * The managed `SKILL.md` files under `~/.omp/agent/managed-skills` own procedure
 * CONTENT; the SQLite `autolearn_procedures` table is only a search/ranking
 * cache. So this adapter always reconciles toward the filesystem: startup and
 * every skill refresh re-sync the descriptor rows, repairing missing entries and
 * dropping rows for files that are no longer active.
 *
 * Descriptors come from the loaded skill list plus each file's `ompManaged`
 * frontmatter. A managed skill with no block is a legacy procedure: it stays
 * searchable, with its terms derived from name and description.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Skill } from "../extensibility/skills";
import { InternalUrlRouter } from "../internal-urls/router";
import type { AgentStorage } from "../session/agent-storage";
import {
	normalizeMetadataTerms,
	type ProcedureDescriptor,
	type ProcedureDescriptorRow,
	type ProcedureOutcome,
	type ProcedureSearchQuery,
} from "./catalog";
import type { ProcedureCatalog } from "./controller";
import { MANAGED_SKILLS_PROVIDER_ID, readManagedSkillMetadata } from "./managed-skills";

/** Whether a loaded skill is one of the managed procedures this catalog owns. */
function isManagedProcedure(skill: Skill): boolean {
	return skill._source?.provider === MANAGED_SKILLS_PROVIDER_ID;
}

/**
 * Build the descriptor for one managed skill.
 *
 * A legacy skill (no `ompManaged` block) gets an empty match set rather than
 * fabricated terms: the ranker still reaches it through name/description lexical
 * overlap, but it must not claim an exact tool-family match it never declared.
 */
async function toDescriptor(skill: Skill): Promise<ProcedureDescriptor> {
	const metadata = await readManagedSkillMetadata(skill.name).catch(error => {
		logger.debug("Auto-Learn descriptor metadata unreadable", { name: skill.name, error: String(error) });
		return null;
	});
	return {
		name: skill.name,
		description: skill.description,
		scope: metadata?.scope ?? "global",
		projectKey: metadata?.projectKey,
		projectLabel: metadata?.projectLabel,
		toolFamilies: normalizeMetadataTerms(metadata?.toolFamilies),
		platforms: normalizeMetadataTerms(metadata?.platforms),
		triggers: normalizeMetadataTerms(metadata?.triggers),
	};
}

/** Catalog backed by `agent.db` for search/ranking and the managed dir for bodies. */
export class ManagedProcedureCatalog implements ProcedureCatalog {
	readonly #storage: AgentStorage;

	constructor(storage: AgentStorage) {
		this.#storage = storage;
	}

	/**
	 * Reconcile the cache with the currently active managed skills.
	 *
	 * Safe to call repeatedly: it preserves outcome counters, repairs rows lost to
	 * a stale or deleted database, and removes rows whose file is gone.
	 */
	async sync(skills: readonly Skill[]): Promise<void> {
		const managed = skills.filter(isManagedProcedure);
		const descriptors = await Promise.all(managed.map(skill => toDescriptor(skill)));
		this.#storage.syncAutolearnProcedures(descriptors);
	}

	/** Upsert one descriptor immediately after a `manage_skill`/`learn` write. */
	async upsert(skill: Skill): Promise<void> {
		this.#storage.upsertAutolearnProcedure(await toDescriptor(skill));
	}

	search(query: ProcedureSearchQuery): { rows: ProcedureDescriptorRow[]; lexicalRank: Map<string, number> } {
		return this.#storage.searchAutolearnProcedures(query);
	}

	recordOutcome(name: string, outcome: ProcedureOutcome): void {
		this.#storage.recordAutolearnProcedureOutcome(name, outcome);
	}

	/**
	 * Read a procedure body for a capture reference.
	 *
	 * Goes through the `skill://` protocol handler — the ONLY body-read path for a
	 * procedure — so this inherits the active-skill snapshot check plus the
	 * handler's containment and symlink guards. A direct managed-directory read
	 * would bypass all three and let a stale cache row name a file the session no
	 * longer considers an active skill.
	 *
	 * Returns null when the procedure is not resolvable: the cache is allowed to
	 * lag the filesystem, and the next {@link sync} repairs it.
	 */
	async readBody(name: string): Promise<string | null> {
		try {
			const resource = await InternalUrlRouter.instance().resolve(`skill://${name}`);
			return resource.content;
		} catch (error) {
			logger.debug("Auto-Learn procedure body unresolvable", { name, error: String(error) });
			return null;
		}
	}
}
