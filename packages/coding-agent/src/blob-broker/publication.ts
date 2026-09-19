import type { BlobDestinationId } from "./destinations";

/** A replayable HTTP request that removes a remotely published blob. */
export interface RemoteDeleteAction {
	/** HTTP method required by the destination. */
	method: "DELETE" | "GET" | "POST";
	/** Absolute deletion endpoint. */
	url: string;
	/** Destination-specific request headers. */
	headers?: Readonly<Record<string, string>>;
	/** Destination-specific request body. */
	body?: string;
}

/** The durable result of publishing a blob to a destination. */
export interface BlobPublication {
	/** Public URL of the uploaded bytes. */
	url: string;
	/** Registry destination that produced the publication. */
	destination: BlobDestinationId;
	/** Number of bytes uploaded. */
	bytes: number;
	/** Unix epoch milliseconds after which the publication may be unavailable. */
	expiresAt?: number;
	/** Replayable action for removing the remote object. */
	delete?: RemoteDeleteAction;
	/** Provider-assigned object identifier. */
	remoteId?: string;
}
