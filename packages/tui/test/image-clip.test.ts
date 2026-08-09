import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Container, type NativeScrollbackLiveRegion, type RenderScheduler, TUI } from "@oh-my-pi/pi-tui";
import { Image, ImageBudget } from "@oh-my-pi/pi-tui/components/image";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { getKittyGraphics, setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import {
	type CellDimensions,
	encodeKittyDeletePlacement,
	encodeKittyPlacementLine,
	getCellDimensions,
	ImageProtocol,
	parseKittyDirectPlacementLine,
	setCellDimensions,
	TERMINAL,
	wrapTmuxPassthrough,
} from "@oh-my-pi/pi-tui/terminal-capabilities";
import { VirtualTerminal } from "./virtual-terminal";

type MutableTerminalInfo = { id: string; imageProtocol: ImageProtocol | null };
const terminal = TERMINAL as unknown as MutableTerminalInfo;

const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

// Direct-placement contract: a straddling image block must be re-anchored at
// its first visible row with the source rectangle clipped to the visible
// slice, and a placement id whose cells reached native scrollback must never
// be re-used (Kitty replace semantics strip the old placement everywhere,
// scrollback included — the permanently cropped images on WezTerm).

describe("parseKittyDirectPlacementLine", () => {
	it("round-trips the exact line Image renders for a direct placement", () => {
		const originalProtocol = TERMINAL.imageProtocol;
		const originalGraphics = { ...getKittyGraphics() };
		const originalCellDims = getCellDimensions();
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		terminal.imageProtocol = ImageProtocol.Kitty;
		setKittyGraphics({ unicodePlaceholders: false });
		try {
			const budget = new ImageBudget(8, () => {});
			const image = new Image(
				BASE64_ONE_PIXEL_PNG,
				"image/png",
				{ fallbackColor: t => t },
				{ maxWidthCells: 4, maxHeightCells: 6, budget, imageKey: "roundtrip" },
				{ widthPx: 40, heightPx: 60 },
			);
			const imageId = budget.acquireId("roundtrip");
			budget.beginPass();
			const lines = image.render(40);
			budget.endPass();
			expect(lines.length).toBe(6);
			const parsed = parseKittyDirectPlacementLine(lines[lines.length - 1]!);
			expect(parsed).toEqual({ imageId, placementId: imageId, columns: 4, rows: 6 });
		} finally {
			setCellDimensions(originalCellDims);
			terminal.imageProtocol = originalProtocol;
			setKittyGraphics(originalGraphics);
		}
	});

	it("rejects non-placement image lines", () => {
		// Placeholder virtual placement (a=p,U=1 lead) is not a direct placement.
		expect(parseKittyDirectPlacementLine("\x1b_Ga=p,U=1,q=2,i=5,p=5,c=4,r=4\x1b\\")).toBeNull();
		// tmux-wrapped placements stay untouched.
		expect(parseKittyDirectPlacementLine(wrapTmuxPassthrough("\x1b_Ga=p,q=2,C=1,i=5,p=5,c=4,r=4\x1b\\"))).toBeNull();
		// Transmit-and-display and plain text never match.
		expect(parseKittyDirectPlacementLine("\x1b_Ga=T,f=100,q=2,C=1,c=4,r=4;AAAA\x1b\\")).toBeNull();
		expect(parseKittyDirectPlacementLine("plain text")).toBeNull();
	});
});

describe("encodeKittyPlacementLine", () => {
	it("emits the full anchored form when the whole block is visible", () => {
		const line = encodeKittyPlacementLine({
			imageId: 7,
			placementId: 1,
			columns: 4,
			rows: 6,
			screenRow: 9,
			imageHeightPx: 60,
		});
		expect(line).toBe("\x1b7\x1b[5A\x1b_Ga=p,q=2,C=1,i=7,p=1,c=4,r=6\x1b\\\x1b8");
	});

	it("clips the source rectangle to the visible bottom slice when the block straddles the top", () => {
		// 6-row block whose last line is written at viewport row 3: two rows are
		// hidden above, four visible. Source slice starts at 60*2/6 = 20px.
		const line = encodeKittyPlacementLine({
			imageId: 7,
			placementId: 2,
			columns: 4,
			rows: 6,
			screenRow: 3,
			imageHeightPx: 60,
		});
		expect(line).toBe("\x1b7\x1b[3A\x1b_Ga=p,q=2,C=1,i=7,p=2,c=4,r=4,y=20,h=40\x1b\\\x1b8");
	});

	it("anchors without cursor movement when only the last row is visible", () => {
		const line = encodeKittyPlacementLine({
			imageId: 7,
			placementId: 3,
			columns: 4,
			rows: 6,
			screenRow: 0,
			imageHeightPx: 60,
		});
		expect(line).toBe("\x1b_Ga=p,q=2,C=1,i=7,p=3,c=4,r=1,y=50,h=10\x1b\\");
	});
});

describe("ImageBudget placement epochs", () => {
	it("keeps the placement id stable while no covered row has committed", () => {
		const budget = new ImageBudget(8, () => {});
		budget.registerPlacementGeometry(5, 40, 60);
		expect(budget.resolvePlacementEmit(5, 10, 4)).toEqual({ placementId: 1, widthPx: 40, heightPx: 60 });
		expect(budget.resolvePlacementEmit(5, 10, 10)).toEqual({ placementId: 1, widthPx: 40, heightPx: 60 });
	});

	it("advances the epoch once commits pass the last emitted attach top", () => {
		const budget = new ImageBudget(8, () => {});
		budget.registerPlacementGeometry(5, 40, 60);
		expect(budget.resolvePlacementEmit(5, 10, 4)?.placementId).toBe(1);
		// Rows 0..11 committed: the epoch-1 placement (attached from row 10) is archive.
		expect(budget.resolvePlacementEmit(5, 12, 12)?.placementId).toBe(2);
		// No further commits past the new attach top: epoch is stable again.
		expect(budget.resolvePlacementEmit(5, 12, 12)?.placementId).toBe(2);
	});

	it("keeps replacing the same id across rewrites with no commit progression", () => {
		const budget = new ImageBudget(8, () => {});
		budget.registerPlacementGeometry(5, 40, 60);
		// Full placement attached from row 1; rows 0..4 commit afterwards.
		expect(budget.resolvePlacementEmit(5, 1, 0)?.placementId).toBe(1);
		// First clipped re-emit attaches from the window top (row 5): one bump.
		expect(budget.resolvePlacementEmit(5, 5, 5)?.placementId).toBe(2);
		// Repeated rewrites without new commits (overlay show/hide churn) must
		// keep replacing placement 2 in place, not mint 3, 4, ... per frame.
		expect(budget.resolvePlacementEmit(5, 5, 5)?.placementId).toBe(2);
		expect(budget.resolvePlacementEmit(5, 5, 5)?.placementId).toBe(2);
		// Commits progressing past the attach top advance the epoch exactly once.
		expect(budget.resolvePlacementEmit(5, 7, 7)?.placementId).toBe(3);
		expect(budget.resolvePlacementEmit(5, 7, 7)?.placementId).toBe(3);
	});

	it("skips epoch bookkeeping for emits without a frame position", () => {
		const budget = new ImageBudget(8, () => {});
		budget.registerPlacementGeometry(5, 40, 60);
		expect(budget.resolvePlacementEmit(5, 10, 4)?.placementId).toBe(1);
		// Alt-screen/resize emit: unknown position, unknown commits.
		expect(budget.resolvePlacementEmit(5, -1, -1)?.placementId).toBe(1);
		// The unknown emit must not have overwritten the tracked attach top.
		expect(budget.resolvePlacementEmit(5, 10, 12)?.placementId).toBe(2);
	});

	it("returns null for unregistered ids and after a full purge", () => {
		const budget = new ImageBudget(8, () => {});
		expect(budget.resolvePlacementEmit(9, 0, 0)).toBeNull();
		budget.registerPlacementGeometry(9, 40, 60);
		budget.enqueueTransmit(9, "seq");
		expect(budget.resolvePlacementEmit(9, 0, -1)).not.toBeNull();
		budget.takeAllTransmittedIds();
		expect(budget.resolvePlacementEmit(9, 0, -1)).toBeNull();
	});

	it("bumps against the monotonic high-water mark when the commit ledger rewinds", () => {
		const budget = new ImageBudget(8, () => {});
		budget.registerPlacementGeometry(5, 40, 60);
		// Placement 1 attaches from row 100 and physically commits (watermark 120).
		expect(budget.resolvePlacementEmit(5, 100, 120)?.placementId).toBe(1);
		// A divergence recommit rewinds the caller's ledger to 50; the archived
		// cells are still in native scrollback, so the re-emit must NOT re-use
		// placement 1 (Kitty replace would strip the archive).
		expect(budget.resolvePlacementEmit(5, 60, 50)?.placementId).toBe(2);
	});

	it("reports the epochs each image reached when resetting, once", () => {
		const budget = new ImageBudget(8, () => {});
		budget.registerPlacementGeometry(5, 40, 60);
		budget.registerPlacementGeometry(7, 40, 60);
		expect(budget.resolvePlacementEmit(5, 10, 4)?.placementId).toBe(1);
		expect(budget.resolvePlacementEmit(5, 12, 12)?.placementId).toBe(2);
		expect(budget.resolvePlacementEmit(7, 30, 12)?.placementId).toBe(1);
		// Only the image that advanced past epoch 1 has stale registry entries.
		expect(budget.resetPlacementEpochs()).toEqual([{ imageId: 5, lastEpoch: 2 }]);
		// After the reset both images are back at epoch 1 with nothing stale.
		expect(budget.resolvePlacementEmit(5, 10, -1)?.placementId).toBe(1);
		expect(budget.resetPlacementEpochs()).toEqual([]);
	});
});

describe("TUI direct-placement clipping", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	const originalTerminalId = terminal.id;
	const originalGraphics = { ...getKittyGraphics() };
	let originalCellDims: CellDimensions;

	beforeEach(() => {
		originalCellDims = getCellDimensions();
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		terminal.imageProtocol = ImageProtocol.Kitty;
		terminal.id = "wezterm";
		setKittyGraphics({ unicodePlaceholders: false });
	});

	afterEach(() => {
		setCellDimensions(originalCellDims);
		terminal.imageProtocol = originalProtocol;
		terminal.id = originalTerminalId;
		setKittyGraphics(originalGraphics);
	});

	/**
	 * Deterministic render driver: every scheduled callback (immediate and
	 * delayed) queues here and `pump()` drains it to a fixed point, so each
	 * mutation renders exactly once per pump with no wall-clock coalescing.
	 */
	function makeManualScheduler(): { scheduler: RenderScheduler; pump: () => void } {
		let now = 0;
		const queue: Array<{ callback: () => void; canceled: boolean }> = [];
		const enqueue = (callback: () => void) => {
			const entry = { callback, canceled: false };
			queue.push(entry);
			return entry;
		};
		return {
			scheduler: {
				now: () => now,
				scheduleImmediate: (callback: () => void) => {
					enqueue(callback);
				},
				scheduleRender: (callback: () => void, _delayMs: number) => {
					const entry = enqueue(callback);
					return {
						cancel: () => {
							entry.canceled = true;
						},
					};
				},
			},
			pump: () => {
				for (let guard = 0; guard < 20 && queue.length > 0; guard++) {
					const batch = queue.splice(0, queue.length);
					now += 50;
					for (const entry of batch) {
						if (!entry.canceled) entry.callback();
					}
				}
			},
		};
	}

	class PinnedLiveBlock extends Container implements NativeScrollbackLiveRegion {
		finalized = false;
		getNativeScrollbackLiveRegionStart(): number | undefined {
			return this.finalized ? undefined : 0;
		}
		isNativeScrollbackLiveRegionPinned(): boolean {
			return !this.finalized;
		}
	}

	interface CapturedPlacement {
		cuu: number;
		imageId: number;
		placementId: number;
		rows: number;
		srcY: number | undefined;
	}

	function capturePlacements(output: string, imageId: number): CapturedPlacement[] {
		const re = /(?:\x1b7(?:\x1b\[(\d+)A)?)?\x1b_Ga=p,q=2,C=1,i=(\d+),p=(\d+),c=\d+,r=(\d+)(?:,y=(\d+),h=\d+)?\x1b\\/g;
		const captured: CapturedPlacement[] = [];
		for (const m of output.matchAll(re)) {
			if (Number(m[2]) !== imageId) continue;
			captured.push({
				cuu: m[1] !== undefined ? Number(m[1]) : 0,
				imageId: Number(m[2]),
				placementId: Number(m[3]),
				rows: Number(m[4]),
				srcY: m[5] !== undefined ? Number(m[5]) : undefined,
			});
		}
		return captured;
	}

	it("clips re-emitted placements to the visible slice while the block straddles the viewport top", () => {
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});

		const { scheduler, pump } = makeManualScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const block = new PinnedLiveBlock();
		block.addChild(new Text("tool-head", 0, 0));
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 6, budget: tui.imageBudget, imageKey: "clip" },
			{ widthPx: 40, heightPx: 60 },
		);
		block.addChild(image);
		const imageId = tui.imageBudget.acquireId("clip");
		const stream = new Text("", 0, 0);
		tui.addChild(new Text("header", 0, 0));
		tui.addChild(block);
		tui.addChild(stream);

		try {
			tui.start();
			pump();

			// Frame layout: header(1) + tool-head(1) + image block rows 2..7.
			// Stream one line per frame until the frame is 10 rows taller than the
			// viewport — the block walks out of the top of the window and, because
			// the pinned live region blocks commits, every slid frame takes the
			// in-place full-window rewrite that re-emits the placement line.
			const lines: string[] = [];
			for (let n = 1; n <= 20; n++) {
				lines.push(`streaming line ${n}`);
				stream.setText(lines.join("\n"));
				tui.requestRender();
				pump();
			}

			const placements = capturePlacements(writes.join(""), imageId);
			expect(placements.length).toBeGreaterThan(0);
			for (const p of placements) {
				// The anchor CUU never exceeds the rows the placement actually spans —
				// the pre-fix failure shape was cuu=5 with r=6 emitted at a viewport
				// row < 5, which the terminal clamps and re-anchors shifted.
				expect(p.cuu).toBe(p.rows - 1);
				if (p.rows < 6) {
					// Clipped: the source rectangle starts exactly at the hidden slice.
					expect(p.srcY).toBe(Math.floor((60 * (6 - p.rows)) / 6));
				} else {
					expect(p.srcY).toBeUndefined();
				}
			}
			// The walk-out must actually have produced clipped emissions.
			expect(placements.some(p => p.rows < 6)).toBe(true);
			// Pinned region ⇒ nothing committed past the block origin ⇒ the
			// placement id never advances.
			expect(new Set(placements.map(p => p.placementId)).size).toBe(1);
		} finally {
			tui.stop();
		}
	});

	it("advances the placement id when the finalize commit passes the placement origin", () => {
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});

		const { scheduler, pump } = makeManualScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const block = new PinnedLiveBlock();
		block.addChild(new Text("tool-head", 0, 0));
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 6, budget: tui.imageBudget, imageKey: "epoch" },
			{ widthPx: 40, heightPx: 60 },
		);
		block.addChild(image);
		const imageId = tui.imageBudget.acquireId("epoch");
		const stream = new Text("", 0, 0);
		tui.addChild(new Text("header", 0, 0));
		tui.addChild(block);
		tui.addChild(stream);

		try {
			tui.start();
			pump();

			// Stream past the viewport while pinned: commits stay parked at the
			// block start, so every straddling emission replaces placement 1 —
			// safe, since none of its cells have committed.
			const lines: string[] = [];
			for (let n = 1; n <= 20; n++) {
				lines.push(`streaming line ${n}`);
				stream.setText(lines.join("\n"));
				tui.requestRender();
				pump();
			}
			const streamed = capturePlacements(writes.join(""), imageId);
			expect(streamed.length).toBeGreaterThan(0);
			expect(new Set(streamed.map(p => p.placementId))).toEqual(new Set([1]));

			// Finalize the block: the seam rewrite commits its rows through the
			// screen. That commit passes placement 1's origin, so the archive copy
			// written into scrollback must carry a fresh placement id — replacing
			// placement 1 later would strip the committed cells.
			writes.length = 0;
			block.finalized = true;
			tui.invalidate();
			tui.requestRender();
			pump();

			const committed = capturePlacements(writes.join(""), imageId);
			expect(committed.length).toBeGreaterThan(0);
			const archive = committed[committed.length - 1]!;
			expect(archive.placementId).toBeGreaterThan(1);
			// The archive copy is the full image, not a clipped slice.
			expect(archive.rows).toBe(6);
			expect(archive.srcY).toBeUndefined();
		} finally {
			tui.stop();
		}
	});

	it("bumps the epoch when an in-window rewrite re-emits after mid-stream commits passed the origin", () => {
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});

		const { scheduler, pump } = makeManualScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 6, budget: tui.imageBudget, imageKey: "midstream" },
			{ widthPx: 40, heightPx: 60 },
		);
		const imageId = tui.imageBudget.acquireId("midstream");
		const stream = new Text("", 0, 0);
		tui.addChild(new Text("header", 0, 0));
		tui.addChild(image);
		tui.addChild(stream);

		try {
			tui.start();
			pump();

			// Frame layout: header(1) + image rows 1..6. Unpinned streaming:
			// scroll-appends commit rows past the block origin while the
			// placement-1 cells scroll natively (no re-emission).
			const lines: string[] = [];
			for (let n = 1; n <= 10; n++) {
				lines.push(`streaming line ${n}`);
				stream.setText(lines.join("\n"));
				tui.requestRender();
				pump();
			}
			const beforeOverlay = capturePlacements(writes.join(""), imageId);
			expect(new Set(beforeOverlay.map(p => p.placementId))).toEqual(new Set([1]));

			// An overlay frame forces the in-place full-window rewrite — the
			// in-window diff path re-emits the straddling placement line with
			// committedTo = the already-advanced committed row count.
			writes.length = 0;
			const overlay = tui.showOverlay(new Text("OVERLAY", 0, 0), { anchor: "top-left", width: "100%" });
			pump();
			overlay.hide();
			pump();

			const after = capturePlacements(writes.join(""), imageId);
			expect(after.length).toBeGreaterThan(0);
			for (const p of after) {
				// Commits passed the origin before this emit: placement 1 is
				// scrollback archive and must not be replaced.
				expect(p.placementId).toBeGreaterThan(1);
				// The block straddles the window top, so the re-emit is clipped.
				expect(p.rows).toBeLessThan(6);
				expect(p.srcY).toBe(Math.floor((60 * (6 - p.rows)) / 6));
				expect(p.cuu).toBe(p.rows - 1);
			}
			// Show + hide are two rewrites with no commit progression between
			// them: both must replace the SAME advanced id — repeated overlay
			// toggles must not mint a fresh placement per frame (#8057 review).
			expect(new Set(after.map(p => p.placementId)).size).toBe(1);
		} finally {
			tui.stop();
		}
	});

	it("restarts placement epochs on a destructive history clear so replays reuse placement 1", () => {
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});

		const { scheduler, pump } = makeManualScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 6, budget: tui.imageBudget, imageKey: "reset" },
			{ widthPx: 40, heightPx: 60 },
		);
		const imageId = tui.imageBudget.acquireId("reset");
		const stream = new Text("", 0, 0);
		tui.addChild(new Text("header", 0, 0));
		tui.addChild(image);
		tui.addChild(stream);

		try {
			tui.start();
			pump();
			const lines: string[] = [];
			for (let n = 1; n <= 10; n++) {
				lines.push(`streaming line ${n}`);
				stream.setText(lines.join("\n"));
				tui.requestRender();
				pump();
			}

			// Destructive replay: ED3 wipes every placement cell, so the replay
			// must re-place under epoch 1 instead of stranding a stale placement
			// entry per reset (Codex review on #8057).
			writes.length = 0;
			tui.resetDisplay();
			pump();

			const output = writes.join("");
			expect(output).toContain("\x1b[3J");
			const replay = capturePlacements(output, imageId);
			expect(replay.length).toBeGreaterThan(0);
			expect(replay[replay.length - 1]!.placementId).toBe(1);
		} finally {
			tui.stop();
		}
	});

	it("deletes stale higher-epoch placements when a destructive clear resets to epoch 1", () => {
		const term = new VirtualTerminal(40, 12);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});

		const { scheduler, pump } = makeManualScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const image = new Image(
			BASE64_ONE_PIXEL_PNG,
			"image/png",
			{ fallbackColor: t => t },
			{ maxWidthCells: 4, maxHeightCells: 6, budget: tui.imageBudget, imageKey: "stale" },
			{ widthPx: 40, heightPx: 60 },
		);
		const imageId = tui.imageBudget.acquireId("stale");
		const stream = new Text("", 0, 0);
		tui.addChild(new Text("header", 0, 0));
		tui.addChild(image);
		tui.addChild(stream);

		try {
			tui.start();
			pump();
			const lines: string[] = [];
			for (let n = 1; n <= 10; n++) {
				lines.push(`streaming line ${n}`);
				stream.setText(lines.join("\n"));
				tui.requestRender();
				pump();
			}
			// Drive the image to epoch 2: an overlay frame re-emits the straddling
			// placement after commits passed its origin.
			const overlay = tui.showOverlay(new Text("OVERLAY", 0, 0), { anchor: "top-left", width: "100%" });
			pump();
			overlay.hide();
			pump();

			// The destructive replay must delete the terminal's stale epoch-2
			// registry entry (d=i keeps the data) and re-place under epoch 1.
			writes.length = 0;
			tui.resetDisplay();
			pump();

			const output = writes.join("");
			expect(output).toContain("\x1b[3J");
			expect(output).toContain(encodeKittyDeletePlacement(imageId, 2));
			const replay = capturePlacements(output, imageId);
			expect(replay.length).toBeGreaterThan(0);
			expect(replay[replay.length - 1]!.placementId).toBe(1);
		} finally {
			tui.stop();
		}
	});
});
