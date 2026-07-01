import { describe, expect, it } from "bun:test";
import { findCommittedPrefixResync } from "@oh-my-pi/pi-tui/tui";

describe("findCommittedPrefixResync", () => {
	it("re-anchors at the earliest audited mismatch when a later forced-overflow row also changed", () => {
		const prefix = ["finalized-old", "stable-1", "durable-drift", "forced-old", "tail"];
		const frame = ["finalized-new", "stable-1", "durable-drift-next", "forced-new", "tail"];

		// Row 2 is a durable-snapshot exemption window. Row 3 is a formerly
		// forced-overflow row that became permanent this frame, so its mismatch must
		// defeat the one-row tail tolerance. The resync point is still row 0: the
		// earliest audited mismatch, not the later forced-overflow one.
		expect(findCommittedPrefixResync(frame, prefix, prefix.length, 2, 3, 4)).toBe(0);
	});
});
