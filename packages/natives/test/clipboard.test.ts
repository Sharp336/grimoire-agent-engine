import { afterEach, beforeEach, describe, expect, mock, test, vi } from "bun:test";

const nativeReadImageFromClipboardMock = vi.fn();
const photonParseMock = vi.fn();
const clipboardModulePath = `${import.meta.dir}/../src/clipboard/index.ts`;
const nativeModulePath = `${import.meta.dir}/../src/native.ts`;
const imageModulePath = `${import.meta.dir}/../src/image/index.ts`;

const ORIGINAL_WAYLAND_DISPLAY = process.env.WAYLAND_DISPLAY;
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const BMP_BYTES = new Uint8Array([0x42, 0x4d, 0x01, 0x00]);

async function importClipboardModule() {
	mock.module(nativeModulePath, () => ({
		native: {
			readImageFromClipboard: nativeReadImageFromClipboardMock,
		},
	}));
	mock.module(imageModulePath, () => ({
		ImageFormat: {
			PNG: 0,
		},
		PhotonImage: {
			parse: photonParseMock,
		},
	}));
	return import(clipboardModulePath);
}

describe("readImageFromClipboard", () => {
	beforeEach(() => {
		process.env.WAYLAND_DISPLAY = "wayland-0";
		nativeReadImageFromClipboardMock.mockReset();
		photonParseMock.mockReset();
	});

	afterEach(() => {
		if (ORIGINAL_WAYLAND_DISPLAY === undefined) {
			delete process.env.WAYLAND_DISPLAY;
		} else {
			process.env.WAYLAND_DISPLAY = ORIGINAL_WAYLAND_DISPLAY;
		}
		vi.restoreAllMocks();
	});

	test("returns native clipboard image without invoking fallback", async () => {
		nativeReadImageFromClipboardMock.mockResolvedValue({ data: PNG_BYTES, mimeType: "image/png" });
		const spawnSpy = vi.spyOn(Bun, "spawnSync");
		const { readImageFromClipboard } = await importClipboardModule();

		const image = await readImageFromClipboard();

		expect(image).toEqual({ data: PNG_BYTES, mimeType: "image/png" });
		expect(spawnSpy).not.toHaveBeenCalled();
	});

	test("falls back to wl-paste and normalizes image bytes to png", async () => {
		nativeReadImageFromClipboardMock.mockResolvedValue(null);
		photonParseMock.mockResolvedValue({
			encode: vi.fn().mockResolvedValue(PNG_BYTES),
		});
		const spawnSpy = vi.spyOn(Bun, "spawnSync");
		spawnSpy
			.mockReturnValueOnce({
				exitCode: 0,
				stdout: Buffer.from("image/gif\ntext/plain\n"),
				stderr: Buffer.alloc(0),
			} as never)
			.mockReturnValueOnce({ exitCode: 0, stdout: BMP_BYTES, stderr: Buffer.alloc(0) } as never);
		const { readImageFromClipboard } = await importClipboardModule();

		const image = await readImageFromClipboard();

		expect(spawnSpy).toHaveBeenNthCalledWith(1, ["wl-paste", "--list-types"], { stdout: "pipe", stderr: "pipe" });
		expect(spawnSpy).toHaveBeenNthCalledWith(2, ["wl-paste", "--type", "image/gif", "--no-newline"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(photonParseMock).toHaveBeenCalledWith(BMP_BYTES);
		expect(image).toEqual({ data: PNG_BYTES, mimeType: "image/png" });
	});
});
