/** Operational classification of a built-in blob destination. */
export type BlobDestinationStatus = "available" | "requires-account" | "incompatible" | "defunct";

/** Supported value shapes for destination configuration fields. */
export type BlobDestinationFieldType = "string" | "boolean" | "number" | "select";

/** A non-secret configuration field accepted by a destination. */
export interface BlobDestinationOptionDescriptor {
	/** Stable key stored below `images.urls.options`. */
	readonly key: string;
	/** Human-readable field label. */
	readonly label: string;
	/** Shape of the stored value. */
	readonly type: BlobDestinationFieldType;
	/** Whether configuration must provide the field. */
	readonly required?: boolean;
	/** Suggested value when the field is omitted. */
	readonly default?: string | number | boolean;
	/** Allowed values for a select field. */
	readonly choices?: readonly string[];
}

/** A secret or account identifier accepted by a destination. */
export interface BlobDestinationCredentialDescriptor {
	/** Stable key stored below `images.urls.credentials`. */
	readonly key: string;
	/** Human-readable field label. */
	readonly label: string;
	/** Whether the destination cannot operate without the credential. */
	readonly required?: boolean;
	/** Whether the value must be hidden in user interfaces and logs. */
	readonly secret: boolean;
}

/** Static capability and configuration metadata for a built-in destination. */
export interface BlobDestinationMetadata<Id extends string = string> {
	/** Stable registry identifier. */
	readonly id: Id;
	/** Human-readable destination name. */
	readonly label: string;
	/** Broad implementation family used for diagnostics and dispatch. */
	readonly family: string;
	/** Current operational classification. */
	readonly status: BlobDestinationStatus;
	/** Whether a publication URL serves image bytes rather than a viewer page. */
	readonly directImage: boolean;
	/** Explanation for an unavailable or constrained destination. */
	readonly reason?: string;
	/** Non-secret destination settings. */
	readonly options: readonly BlobDestinationOptionDescriptor[];
	/** Account identifiers and secrets required by the destination. */
	readonly credentials: readonly BlobDestinationCredentialDescriptor[];
}

const noFields = [] as const;

/** Complete static registry of built-in blob publication destinations. */
export const BUILTIN_BLOB_DESTINATIONS = {
	"provider-files": {
		id: "provider-files",
		label: "Model provider files",
		family: "provider-files",
		status: "requires-account",
		directImage: false,
		reason: "Provider file references are API-local rather than public image URLs.",
		options: [
			{
				key: "provider",
				label: "Provider",
				type: "select",
				required: true,
				choices: ["openai", "anthropic", "google"],
			},
		],
		credentials: noFields,
	},
	direct: {
		id: "direct",
		label: "Direct public URL",
		family: "local-serving",
		status: "available",
		directImage: true,
		options: [{ key: "publicBaseUrl", label: "Public base URL", type: "string", required: true }],
		credentials: noFields,
	},
	ssh: {
		id: "ssh",
		label: "SSH reverse tunnel",
		family: "tunnel",
		status: "requires-account",
		directImage: true,
		options: [{ key: "host", label: "SSH host", type: "string", required: true }],
		credentials: [{ key: "privateKey", label: "SSH private key", secret: true }],
	},
} as const satisfies Record<string, BlobDestinationMetadata>;

/** Identifier of any built-in blob destination, derived from registry keys. */
export type BlobDestinationId = keyof typeof BUILTIN_BLOB_DESTINATIONS;
