import { EngineTargetError } from "./contracts";
import type { RuntimeSql } from "./runtime-projection";
import { runtimeLimits } from "./runtime-protocol";

/** One control transaction's work, including discarded reads and serialized writes. */
export class BranchControlWork {
	readonly #started = performance.now();
	#rows = 0;
	#bytes = 0;

	check(): void {
		const reason =
			this.#rows > runtimeLimits.branchControlScannedRows
				? "scan"
				: this.#bytes > runtimeLimits.branchControlMaterializedBytes
					? "materialization"
					: performance.now() - this.#started > runtimeLimits.bootstrapTimeoutMs
						? "deadline"
						: undefined;
		if (reason)
			throw new EngineTargetError(
				"restore_budget",
				`Branch control ${reason} budget exceeded; no branch intent was applied`,
			);
	}

	materialize(value: unknown): void {
		this.materializeBytes(Buffer.byteLength(JSON.stringify(value) ?? ""));
	}

	materializeBytes(bytes: number): void {
		this.#bytes += bytes;
		this.check();
	}

	get remainingBytes(): number {
		return Math.max(0, runtimeLimits.branchControlMaterializedBytes - this.#bytes);
	}

	/** Existing helpers all use unsafe+await; no connection or transaction is created here. */
	bind(sql: RuntimeSql): RuntimeSql {
		return new Proxy(sql, {
			get: (target, key) => {
				if (key !== "unsafe") return Reflect.get(target, key);
				return (...args: Parameters<RuntimeSql["unsafe"]>) => {
					this.check();
					this.materialize(args[1]);
					return target.unsafe(...args).then((rows: Record<string, unknown>[]) => {
						this.#rows += rows.length;
						this.materialize(rows);
						return rows;
					});
				};
			},
		});
	}
}

export async function runtimeAncestorIds(sql: RuntimeSql, agentId: string): Promise<string[]> {
	// A parent chain has one successor. The limit is INSIDE recursion, before any join/sort.
	const rows = (await sql.unsafe(
		`WITH RECURSIVE ancestors(id) AS (SELECT ? UNION SELECT i.parent_agent_instance_id
		 FROM engine_agent_identity i JOIN ancestors a ON i.agent_instance_id=a.id
		 WHERE i.parent_agent_instance_id IS NOT NULL LIMIT ?)
		 SELECT id FROM ancestors`,
		[agentId, runtimeLimits.ancestorRecords + 1],
	)) as Array<{ id: string }>;
	if (rows.length > runtimeLimits.ancestorRecords)
		throw new EngineTargetError("restore_budget", "AgentInstance ancestor read exceeds the finite operation budget");
	return rows.map(row => row.id);
}

export interface RuntimeHoldRow {
	source_agent_instance_id: string;
	agent_instance_ref: string;
	command_id: string;
	generation: number;
	kind: "pause" | "stop" | "recovery";
}

export async function runtimeHoldRows(sql: RuntimeSql, agentId: string, limit: number): Promise<RuntimeHoldRow[]> {
	const ancestors = await runtimeAncestorIds(sql, agentId);
	// At most three canonical kinds per source. Read/count even omitted metadata;
	// fetch long public refs only for the selected bounded preview.
	const metadata = (await sql.unsafe(
		`SELECT source_agent_instance_id,kind FROM engine_branch_holds
		 WHERE source_agent_instance_id IN (${ancestors.map(() => "?").join(",")})
		 ORDER BY created_at,source_agent_instance_id,kind`,
		ancestors,
	)) as Array<{ source_agent_instance_id: string; kind: string }>;
	if (!metadata.length) return [];
	const selected = metadata.slice(0, limit);
	return (await sql.unsafe(
		`SELECT h.source_agent_instance_id,i.agent_instance_ref,h.command_id,h.generation,h.kind
		 FROM engine_branch_holds h JOIN engine_agent_identity i ON i.agent_instance_id=h.source_agent_instance_id
		 WHERE ${selected.map(() => "(h.source_agent_instance_id=? AND h.kind=?)").join(" OR ")}
		 ORDER BY h.created_at,h.source_agent_instance_id,h.kind`,
		selected.flatMap(row => [row.source_agent_instance_id, row.kind]),
	)) as RuntimeHoldRow[];
}

export async function runtimeBranchIds(sql: RuntimeSql, agentId: string): Promise<string[]> {
	const ids = [agentId];
	const seen = new Set(ids);
	// Read a finite child prefix before expanding the next parent; recursive SQL breadth
	// expansion can otherwise fill an unbounded frontier before its outer LIMIT applies.
	for (let parent = 0; parent < ids.length; parent++) {
		const children = (await sql.unsafe(
			"SELECT agent_instance_id FROM engine_agent_identity INDEXED BY engine_agent_parent_idx WHERE parent_agent_instance_id=? LIMIT ?",
			[ids[parent], runtimeLimits.branchControlRecords - ids.length + 1],
		)) as Array<{ agent_instance_id: string }>;
		if (ids.length + children.length > runtimeLimits.branchControlRecords)
			throw new EngineTargetError("restore_budget", "Branch control exceeds the finite affected-record budget");
		for (const child of children) {
			if (seen.has(child.agent_instance_id))
				throw new EngineTargetError("invalid_request", "AgentInstance ancestry cycle");
			seen.add(child.agent_instance_id);
			ids.push(child.agent_instance_id);
		}
	}
	return ids;
}
