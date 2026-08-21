import { describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import type { Component } from "@oh-my-pi/pi-tui";

class WrappedBlock implements Component {
	renderCount = 0;
	constructor(public text: string) {}
	invalidate(): void {}
	render(width: number): readonly string[] {
		this.renderCount++;
		const rows: string[] = [];
		for (let offset = 0; offset < this.text.length; offset += width)
			rows.push(this.text.slice(offset, offset + width));
		return rows;
	}
}

class VersionedBlock extends WrappedBlock {
	version = 0;
	getTranscriptBlockVersion(): number {
		return this.version;
	}
}

class LiveBlock extends WrappedBlock {
	isTranscriptBlockFinalized(): boolean {
		return false;
	}
}

describe("TranscriptContainer width epochs", () => {
	it("resolves across immutable finalized blocks that omit mutation versions", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new WrappedBlock("A".repeat(80)));
		transcript.addChild(new WrappedBlock("B".repeat(40)));
		transcript.render(40);
		const boundary = transcript.captureNativeScrollbackWidthEpoch();
		const narrowRows = transcript.render(20);
		expect(transcript.resolveNativeScrollbackWidthEpoch(boundary)).toBe(narrowRows.length);
	});

	it("bounds replay at a finalized block whose explicit version changed", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new WrappedBlock("S".repeat(40)));
		const mutable = new VersionedBlock("A".repeat(80));
		transcript.addChild(mutable);
		transcript.addChild(new WrappedBlock("B".repeat(40)));
		transcript.render(40);
		const boundary = transcript.captureNativeScrollbackWidthEpoch();
		mutable.version++;
		transcript.render(20);
		expect(transcript.resolveNativeScrollbackWidthEpoch(boundary)).toBe(2);
		expect(transcript.isNativeScrollbackWidthEpochAppendOnly(boundary)).toBeFalse();
	});

	it("rerenders committed blocks when a destructive replay keeps the same width", () => {
		const transcript = new TranscriptContainer();
		const block = new WrappedBlock("A".repeat(80));
		transcript.addChild(block);
		transcript.setNativeScrollbackCommittedRows(transcript.render(40).length);

		transcript.prepareNativeScrollbackReplay();
		expect(transcript.render(40)).toHaveLength(2);
		expect(block.renderCount).toBe(2);
	});

	it("bounds an unresolved live block fallback at that block", () => {
		const transcript = new TranscriptContainer();
		transcript.addChild(new WrappedBlock("A".repeat(80)));
		const live = new LiveBlock("B".repeat(40));
		transcript.addChild(live);
		transcript.render(40);
		const boundary = transcript.captureNativeScrollbackWidthEpoch();

		live.text += "C".repeat(40);
		transcript.render(20);

		expect(transcript.resolveNativeScrollbackWidthEpoch(boundary)).toBe(4);
	});
});
