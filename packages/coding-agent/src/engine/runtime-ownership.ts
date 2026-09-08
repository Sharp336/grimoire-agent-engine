import { EngineTargetError } from "./contracts";
import type { RuntimeSql } from "./runtime-projection";
import { runtimeLimits } from "./runtime-protocol";

export const RUNTIME_OWNERSHIP_SCHEMA = [
	"CREATE INDEX engine_commands_start_owner_idx ON engine_commands(agent_instance_id,device_id,engine_id,agent_instance_ref,received_at,command_id) WHERE operation='start'",
	"ALTER TABLE engine_agent_identity ADD COLUMN ownership_proof_command_id TEXT",
] as const;

interface OwnershipIdentity {
	agentInstanceRef: string;
	agentInstanceId: string;
	authorityGeneration: number;
}

export interface LegacyStartOwnershipCandidate extends OwnershipIdentity {
	kind?: undefined;
	sourceCommandId: string;
	attemptId: string;
	executionId: string;
}

export interface CanonicalOwnershipCandidate extends OwnershipIdentity {
	kind: "canonical_agi";
}

export type LegacyOwnershipCandidate = LegacyStartOwnershipCandidate | CanonicalOwnershipCandidate;

interface OwnershipProofResult {
	agentInstanceRef: string;
	status: "verified" | "missing" | "conflict" | "deferred";
	principalId?: string;
	reason?: string;
	proofSource?: "canonical_agi" | "retained_job";
}

export type LegacyOwnershipProof = OwnershipProofResult &
	(
		| { kind?: undefined; sourceCommandId: string }
		| { kind: "canonical_agi"; agentInstanceId: string; authorityGeneration: number }
	);

export function ownershipProofMatches(candidate: LegacyOwnershipCandidate, proof: LegacyOwnershipProof): boolean {
	if (candidate.kind === "canonical_agi")
		return (
			proof.kind === "canonical_agi" &&
			proof.agentInstanceId === candidate.agentInstanceId &&
			proof.authorityGeneration === candidate.authorityGeneration &&
			(proof.status !== "verified" || proof.proofSource === "canonical_agi")
		);
	return proof.kind === undefined && proof.sourceCommandId === candidate.sourceCommandId;
}

interface LegacyIdentity {
	agent_instance_id: string;
	agent_instance_ref: string;
	parent_agent_instance_id: string | null;
	principal_id: string;
	authority_generation: number;
}

export interface LegacyOwnershipPage {
	candidates: LegacyOwnershipCandidate[];
	inherited: Array<{ agentInstanceId: string; agentInstanceRef: string; principalId: string }>;
	unresolved: string[];
	nextCursor: string | null;
}

export async function legacyOwnershipPage(
	sql: RuntimeSql,
	deviceId: string,
	engineId: string,
	after = "",
): Promise<LegacyOwnershipPage> {
	const rows = (await sql.unsafe(
		`SELECT agent_instance_id,agent_instance_ref,parent_agent_instance_id,principal_id,authority_generation
		FROM engine_agent_identity WHERE principal_id='' AND agent_instance_id>? ORDER BY agent_instance_id LIMIT ?`,
		[after, runtimeLimits.httpPageRecords + 1],
	)) as LegacyIdentity[];
	const result: LegacyOwnershipPage = { candidates: [], inherited: [], unresolved: [], nextCursor: null };
	for (const row of rows.slice(0, runtimeLimits.httpPageRecords)) {
		if (!row.agent_instance_ref) {
			result.unresolved.push(row.agent_instance_id);
			continue;
		}
		const parent = row.parent_agent_instance_id ? await identity(sql, row.parent_agent_instance_id) : undefined;
		if (parent?.principal_id) {
			result.inherited.push({
				agentInstanceId: row.agent_instance_id,
				agentInstanceRef: row.agent_instance_ref,
				principalId: parent.principal_id,
			});
			continue;
		}
		const commands = (await sql.unsafe(
			`SELECT command_id,attempt_id,execution_id,authority_generation FROM engine_commands
			WHERE agent_instance_id=? AND device_id=? AND engine_id=? AND operation='start'
			AND agent_instance_ref=? ORDER BY received_at,command_id LIMIT 1`,
			[row.agent_instance_id, deviceId, engineId, row.agent_instance_ref],
		)) as Array<{
			command_id: string;
			attempt_id: string | null;
			execution_id: string | null;
			authority_generation: number;
		}>;
		const command = commands[0];
		if (!command?.attempt_id || !command.execution_id) {
			result.candidates.push({
				kind: "canonical_agi",
				agentInstanceRef: row.agent_instance_ref,
				agentInstanceId: row.agent_instance_id,
				authorityGeneration: Number(row.authority_generation),
			});
			continue;
		}
		result.candidates.push({
			agentInstanceRef: row.agent_instance_ref,
			agentInstanceId: row.agent_instance_id,
			sourceCommandId: command.command_id,
			attemptId: command.attempt_id,
			executionId: command.execution_id,
			authorityGeneration: Number(command.authority_generation),
		});
	}
	if (rows.length > runtimeLimits.httpPageRecords)
		result.nextCursor = rows[runtimeLimits.httpPageRecords - 1].agent_instance_id;
	return result;
}

async function identity(sql: RuntimeSql, agentId: string): Promise<LegacyIdentity | undefined> {
	const rows = (await sql.unsafe(
		"SELECT agent_instance_id,agent_instance_ref,parent_agent_instance_id,principal_id,authority_generation FROM engine_agent_identity WHERE agent_instance_id=?",
		[agentId],
	)) as LegacyIdentity[];
	return rows[0];
}

export async function claimLegacyOwnership(
	sql: RuntimeSql,
	agentId: string,
	agentRef: string,
	principalId: string,
	proof?: LegacyOwnershipCandidate,
): Promise<"enrolled" | "known" | "missing" | "conflict" | "parent_pending"> {
	if (!principalId.trim() || principalId.length > runtimeLimits.bulkPreviewBytes)
		throw new EngineTargetError("invalid_request", "Ownership proof must name a bounded principal");
	const row = await identity(sql, agentId);
	if (!row) return "missing";
	if (row.agent_instance_ref !== agentRef) return "conflict";
	if (proof?.kind === "canonical_agi") {
		if (Number(row.authority_generation) !== proof.authorityGeneration) return "conflict";
	} else if (proof) {
		const commands = await sql.unsafe(
			`SELECT command_id FROM engine_commands WHERE command_id=? AND operation='start'
			AND agent_instance_id=? AND agent_instance_ref=? AND attempt_id=? AND execution_id=? AND authority_generation=?`,
			[proof.sourceCommandId, agentId, agentRef, proof.attemptId, proof.executionId, proof.authorityGeneration],
		);
		if (!commands.length) return "conflict";
	}
	if (row.principal_id) return row.principal_id === principalId ? "known" : "conflict";
	if (row.parent_agent_instance_id) {
		const parent = await identity(sql, row.parent_agent_instance_id);
		if (!parent?.principal_id) return "parent_pending";
		if (parent.principal_id !== principalId) return "conflict";
	} else if (!proof) return "conflict";
	await sql.unsafe(
		`UPDATE engine_agent_identity SET principal_id=?,ownership_proof_command_id=?,summary_json=NULL,
		membership_revision=0,updated_at=? WHERE agent_instance_id=? AND principal_id=''`,
		[principalId, proof?.kind === "canonical_agi" ? null : (proof?.sourceCommandId ?? null), Date.now(), agentId],
	);
	return "enrolled";
}
