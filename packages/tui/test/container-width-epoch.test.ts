import { describe, expect, it } from "bun:test";
import { type Component, Container, type NativeScrollbackWidthEpoch } from "@oh-my-pi/pi-tui";

class WrappingRows implements Component {
	constructor(readonly text: string) {}

	invalidate(): void {}

	render(width: number): readonly string[] {
		const rows: string[] = [];
		for (let offset = 0; offset < this.text.length; offset += width)
			rows.push(this.text.slice(offset, offset + width));
		return rows;
	}
}

class StableWrappingRows extends WrappingRows {
	getNativeScrollbackWidthEpochRevision(): number {
		return 0;
	}
}

class LogicalBoundary extends WrappingRows implements NativeScrollbackWidthEpoch {
	#rows = 0;

	override render(width: number): readonly string[] {
		const rows = super.render(width);
		this.#rows = rows.length;
		return rows;
	}

	captureNativeScrollbackWidthEpoch(): unknown {
		return {};
	}

	resolveNativeScrollbackWidthEpoch(): number {
		return this.#rows;
	}

	getNativeScrollbackWidthEpochRows(): number {
		return this.#rows;
	}
}

describe("Container width epochs", () => {
	it("resolves through stable leading children whose row count reflows", () => {
		const container = new Container();
		container.addChild(new StableWrappingRows("L".repeat(80)));
		container.addChild(new LogicalBoundary("S".repeat(40)));
		container.render(40);
		const boundary = container.captureNativeScrollbackWidthEpoch();

		const narrow = container.render(20);
		expect(container.resolveNativeScrollbackWidthEpoch(boundary)).toBe(narrow.length);
	});

	it("rejects an unversioned leading child whose physical row count changed", () => {
		const container = new Container();
		container.addChild(new WrappingRows("L".repeat(80)));
		container.addChild(new LogicalBoundary("S".repeat(40)));
		container.render(40);
		const boundary = container.captureNativeScrollbackWidthEpoch();

		container.render(20);
		expect(container.resolveNativeScrollbackWidthEpoch(boundary)).toBeUndefined();
	});
});
