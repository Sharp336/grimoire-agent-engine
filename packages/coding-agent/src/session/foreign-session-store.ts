import type { SessionManager } from "./session-manager";

/** External coding-agent session source supported by OMP imports. */
export type ForeignSessionSource = "claude" | "codex";

/** Lightweight source metadata used to choose a foreign session before loading its transcript. */
export interface ForeignSessionInfo {
	readonly source: ForeignSessionSource;
	readonly id: string;
	readonly path: string;
	readonly cwd: string;
	readonly title?: string;
	readonly created: Date;
	readonly modified: Date;
	readonly messageCount?: number;
	readonly firstMessage?: string;
}

/** Provenance attached when a converted session is persisted under OMP. */
export interface ForeignSessionProvenance {
	readonly source: string;
	readonly sourceId: string;
	readonly sourcePath: string;
	readonly sourceCwd: string;
}

/** Provenance recorded for a staged Prime session import. */
export interface PrimeSessionProvenance {
	readonly sourceRef: string;
	/** Canonical source file path, distinct from the stable logical sourceRef. */
	readonly sourcePath: string;
	readonly sourceSha256: string;
	readonly snapshotId: string;
	readonly sourceRoot: string;
	readonly sessionRoot: string;
	readonly sourceCwd: string;
	readonly destinationCwd: string;
	readonly title?: string;
	readonly parentSession?: string;
	readonly rlmDepth?: number;
	readonly child: boolean;
}

/** Lists and converts sessions owned by another coding agent. */
export interface ForeignSessionStore {
	readonly source: ForeignSessionSource;
	/** Lists source sessions without parsing complete transcripts. */
	list(): Promise<ForeignSessionInfo[]>;
	/** Converts one source session into a non-persistent OMP session. */
	load(session: ForeignSessionInfo): Promise<SessionManager>;
}
