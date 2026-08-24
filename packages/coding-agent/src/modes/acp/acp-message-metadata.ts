import type { Meta } from "@oh-my-pi/pi-utils/acp";

/** OMP extension carrying a message's authoritative Unix-epoch timestamp. */
export const ACP_MESSAGE_TIMESTAMP_META_KEY = "omp.sh/messageTimestamp";
/** Capability wire-format identifier for a numeric Unix-millisecond value. */
export const ACP_MESSAGE_TIMESTAMP_FORMAT = "unix-ms";

/**
 * ACP v1 has no standard per-message timestamp. Keep OMP's source timestamp in
 * namespaced metadata so clients can preserve it across live updates and replay.
 */
export function toAcpMessageTimestampMeta({ timestamp }: { timestamp: number | undefined }): Meta {
	if (timestamp === undefined || !Number.isFinite(timestamp)) return {};
	return { _meta: { [ACP_MESSAGE_TIMESTAMP_META_KEY]: timestamp } };
}
