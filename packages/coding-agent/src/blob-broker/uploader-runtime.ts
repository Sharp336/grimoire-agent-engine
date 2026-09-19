import type { BlobDestinationId } from "./destinations";
/** Non-secret value accepted by a destination option record. */
export type DestinationOptionValue = string | number | boolean;

/** Fetch input accepted by destination HTTP requests. */
export type FetchInput = string | URL | Request;

/** Fetch implementation used for destination HTTP requests. */
export type FetchImpl = (input: FetchInput, init?: RequestInit) => Promise<Response>;

/** Runtime settings supplied to a built-in destination uploader. */
export interface DestinationRuntimeConfig {
	/** Non-secret, destination-specific settings. */
	readonly options: Readonly<Record<string, DestinationOptionValue>>;
	/** Destination credentials; values must never be included in errors or logs. */
	readonly credentials: Readonly<Record<string, string>>;
	/** Optional request implementation, primarily for embedding and isolation. */
	readonly fetch?: FetchImpl;
}

/** Explicit failure used for destinations that cannot be contacted safely. */
export class DestinationUnavailableError extends Error {
	/** Destination that is unavailable. */
	readonly destination: BlobDestinationId;

	constructor(destination: BlobDestinationId, reason: string) {
		super(`${destination} is unavailable: ${reason}`);
		this.name = "DestinationUnavailableError";
		this.destination = destination;
	}
}
