import { describe, expect, it, vi } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";

describe("CommandController.handleExportCommand", () => {
	it("preserves quoted export paths with spaces", async () => {
		const exportToHtml = vi.fn(async () => "/tmp/session export.html");
		const showStatus = vi.fn();
		const showWarning = vi.fn();
		const showError = vi.fn();
		const controller = new CommandController({
			session: { exportToHtml },
			showStatus,
			showWarning,
			showError,
		} as any);

		await controller.handleExportCommand('/export "/tmp/session export.html"');

		expect(exportToHtml).toHaveBeenCalledWith("/tmp/session export.html");
		expect(showStatus).toHaveBeenCalledWith("Session exported to: /tmp/session export.html");
		expect(showWarning).not.toHaveBeenCalled();
		expect(showError).not.toHaveBeenCalled();
	});

	it("preserves single-quoted export paths with spaces", async () => {
		const exportToHtml = vi.fn(async () => "/tmp/session export.html");
		const controller = new CommandController({
			session: { exportToHtml },
			showStatus: vi.fn(),
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as any);

		await controller.handleExportCommand("/export '/tmp/session export.html'");

		expect(exportToHtml).toHaveBeenCalledWith("/tmp/session export.html");
	});

	it("still warns for clipboard aliases", async () => {
		const exportToHtml = vi.fn(async () => "/tmp/ignored.html");
		const showWarning = vi.fn();
		const controller = new CommandController({
			session: { exportToHtml },
			showStatus: vi.fn(),
			showWarning,
			showError: vi.fn(),
		} as any);

		await controller.handleExportCommand("/export copy");

		expect(showWarning).toHaveBeenCalledWith("Use /dump to copy the session to clipboard.");
		expect(exportToHtml).not.toHaveBeenCalled();
	});
});
