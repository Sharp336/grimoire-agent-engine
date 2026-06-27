/**
 * `paste.pathPaste` setting: menu (ask), literal, attach, and smart-paste integration.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	InputController,
	PATH_PASTE_MENU_ATTACH,
	PATH_PASTE_MENU_LITERAL,
} from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

const ONE_PX_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
	"base64",
);

type PathPasteMode = "ask" | "literal" | "attach";

function createContext(options?: {
	pathPaste?: PathPasteMode;
	menuChoice?: string;
}) {
	const pasteText = vi.fn();
	const insertText = vi.fn();
	const requestRender = vi.fn();
	const showStatus = vi.fn();
	const pendingImages: ImageContent[] = [];
	const pendingImageLinks: (string | undefined)[] = [];
	const showHookSelector = vi.fn(async () => options?.menuChoice);
	const pathPaste = options?.pathPaste ?? "ask";
	const ctx = {
		editor: {
			pasteText,
			insertText,
			imageLinks: undefined,
			pendingImages,
			pendingImageLinks,
		} as unknown as InteractiveModeContext["editor"],
		ui: { requestRender, getFocused: () => null } as unknown as InteractiveModeContext["ui"],
		settings: {
			get: (key: string) => {
				if (key === "paste.pathPaste") return pathPaste;
				return undefined;
			},
		} as unknown as InteractiveModeContext["settings"],
		sessionManager: {
			getCwd: () => process.cwd(),
			putBlob: async () => ({ hash: "h", path: "/tmp/h.png", displayPath: "/tmp/h.png" }),
		} as unknown as InteractiveModeContext["sessionManager"],
		showHookSelector: showHookSelector as unknown as InteractiveModeContext["showHookSelector"],
		showStatus,
	} as unknown as InteractiveModeContext;
	return {
		ctx,
		spies: { pasteText, insertText, requestRender, showStatus, showHookSelector, pendingImages },
	};
}

describe("InputController.presentPathPasteMenu", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns attach when the user chooses Attach file", async () => {
		const { ctx } = createContext({ menuChoice: PATH_PASTE_MENU_ATTACH });
		const controller = new InputController(ctx);

		const action = await controller.presentPathPasteMenu("/tmp/shot.png");

		expect(action).toBe("attach");
	});

	it("returns literal when the user chooses Keep path as text", async () => {
		const { ctx } = createContext({ menuChoice: PATH_PASTE_MENU_LITERAL });
		const controller = new InputController(ctx);

		const action = await controller.presentPathPasteMenu("/tmp/shot.png");

		expect(action).toBe("literal");
	});

	it("returns cancel when the menu is dismissed (undefined choice)", async () => {
		const { ctx } = createContext({ menuChoice: undefined });
		const controller = new InputController(ctx);

		const action = await controller.presentPathPasteMenu("/tmp/shot.png");

		expect(action).toBe("cancel");
	});
});

describe("InputController.handleImagePathPaste (paste.pathPaste)", () => {
	let tmpDir: string;
	let imgPath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "path-paste-"));
		imgPath = path.join(tmpDir, "screenshot.png");
		await fs.writeFile(imgPath, ONE_PX_PNG);
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "images.autoResize": false } });
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it('paste.pathPaste "literal" pastes the path as text without attaching', async () => {
		const { ctx, spies } = createContext({ pathPaste: "literal" });
		const controller = new InputController(ctx);

		await controller.handleImagePathPaste(imgPath);

		expect(spies.pasteText).toHaveBeenCalledWith(imgPath);
		expect(spies.pendingImages.length).toBe(0);
		expect(spies.insertText).not.toHaveBeenCalled();
	});

	it('paste.pathPaste "attach" loads the image from disk', async () => {
		const { ctx, spies } = createContext({ pathPaste: "attach" });
		const controller = new InputController(ctx);

		await controller.handleImagePathPaste(imgPath);

		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.pendingImages.length).toBe(1);
		expect(spies.pendingImages[0]?.type).toBe("image");
	});

	it('paste.pathPaste "ask" with literal choice pastes the path as text', async () => {
		const { ctx, spies } = createContext({ pathPaste: "ask", menuChoice: PATH_PASTE_MENU_LITERAL });
		const controller = new InputController(ctx);

		await controller.handleImagePathPaste(imgPath);

		expect(spies.pasteText).toHaveBeenCalledWith(imgPath);
		expect(spies.pendingImages.length).toBe(0);
	});

	it('paste.pathPaste "ask" with cancel does not paste or insert', async () => {
		const { ctx, spies } = createContext({ pathPaste: "ask", menuChoice: undefined });
		const controller = new InputController(ctx);

		await controller.handleImagePathPaste(imgPath);

		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(spies.insertText).not.toHaveBeenCalled();
		expect(spies.pendingImages.length).toBe(0);
	});
});

describe("InputController.handleImagePaste with paste.pathPaste literal", () => {
	let tmpDir: string;
	let imgPath: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "path-paste-smart-"));
		imgPath = path.join(tmpDir, "screenshot.png");
		await fs.writeFile(imgPath, ONE_PX_PNG);
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "images.autoResize": false } });
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
		resetSettingsForTest();
		vi.restoreAllMocks();
	});

	it("inserts full clipboard text when pathPaste is literal (no attach)", async () => {
		const clipboardText = `  ${imgPath}  `;
		const { ctx, spies } = createContext({ pathPaste: "literal" });
		const attachSpy = vi.spyOn(InputController.prototype, "handleImagePathPaste");
		const controller = new InputController(ctx, {
			readImage: async () => null,
			readText: async () => clipboardText,
		});

		const result = await controller.handleImagePaste();

		expect(result).toBe(true);
		expect(spies.insertText).toHaveBeenCalledWith(clipboardText);
		expect(spies.pasteText).not.toHaveBeenCalled();
		expect(attachSpy).not.toHaveBeenCalled();
		expect(spies.pendingImages.length).toBe(0);
		attachSpy.mockRestore();
	});
});
