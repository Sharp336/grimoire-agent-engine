import { describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { formatRepoDiffDisplayPath } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

function createRuntimeHarness(options?: {
	handleDiffCommand?: InteractiveModeContext["handleDiffCommand"];
	handleSessionCommand?: InteractiveModeContext["handleSessionCommand"];
	handleSessionDeleteCommand?: InteractiveModeContext["handleSessionDeleteCommand"];
}) {
	const setText = vi.fn();
	const handleSessionCommand =
		options?.handleSessionCommand ??
		vi.fn(async () => {
			return;
		});
	const handleSessionDeleteCommand =
		options?.handleSessionDeleteCommand ??
		vi.fn(async () => {
			return;
		});
	const handleDiffCommand =
		options?.handleDiffCommand ??
		vi.fn(async () => {
			return;
		});

	return {
		setText,
		handleSessionCommand,
		handleSessionDeleteCommand,
		handleDiffCommand,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				handleSessionCommand,
				handleSessionDeleteCommand,
				handleDiffCommand,
			} as InteractiveModeContext,
			handleBackgroundCommand: () => {},
		},
	};
}

describe("/session slash command", () => {
	it("awaits session info before resolving the default command", async () => {
		const deferred = Promise.withResolvers<void>();
		const handleSessionCommand = vi.fn(() => deferred.promise);
		const harness = createRuntimeHarness({ handleSessionCommand });

		let settled = false;
		const execution = executeBuiltinSlashCommand("/session", harness.runtime).then(result => {
			settled = true;
			return result;
		});

		await Promise.resolve();

		expect(handleSessionCommand).toHaveBeenCalledTimes(1);
		expect(harness.handleSessionDeleteCommand).not.toHaveBeenCalled();
		expect(harness.setText).not.toHaveBeenCalled();
		expect(settled).toBe(false);

		deferred.resolve();

		expect(await execution).toBe(true);
		expect(settled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("propagates session info failures through executeBuiltinSlashCommand", async () => {
		const infoError = new Error("info failed");
		const handleSessionCommand = vi.fn(async () => {
			throw infoError;
		});
		const harness = createRuntimeHarness({ handleSessionCommand });

		await expect(executeBuiltinSlashCommand("/session info", harness.runtime)).rejects.toBe(infoError);
		expect(handleSessionCommand).toHaveBeenCalledTimes(1);
		expect(harness.handleSessionDeleteCommand).not.toHaveBeenCalled();
		expect(harness.setText).not.toHaveBeenCalled();
	});

	it("awaits session deletion before resolving the builtin command", async () => {
		const deferred = Promise.withResolvers<void>();
		const handleSessionDeleteCommand = vi.fn(() => deferred.promise);
		const harness = createRuntimeHarness({ handleSessionDeleteCommand });

		let settled = false;
		const execution = executeBuiltinSlashCommand("/session delete", harness.runtime).then(result => {
			settled = true;
			return result;
		});

		await Promise.resolve();

		expect(handleSessionDeleteCommand).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(settled).toBe(false);

		deferred.resolve();

		expect(await execution).toBe(true);
		expect(settled).toBe(true);
	});

	it("propagates session deletion failures through executeBuiltinSlashCommand", async () => {
		const deleteError = new Error("delete failed");
		const handleSessionDeleteCommand = vi.fn(async () => {
			throw deleteError;
		});
		const harness = createRuntimeHarness({ handleSessionDeleteCommand });

		await expect(executeBuiltinSlashCommand("/session delete", harness.runtime)).rejects.toBe(deleteError);
		expect(handleSessionDeleteCommand).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("awaits diff commands before clearing editor", async () => {
		const deferred = Promise.withResolvers<void>();
		const handleDiffCommand = vi.fn(() => deferred.promise);
		const harness = createRuntimeHarness({ handleDiffCommand });

		let settled = false;
		const execution = executeBuiltinSlashCommand("/diff snapshot baseline", harness.runtime).then(result => {
			settled = true;
			return result;
		});

		await Promise.resolve();

		expect(handleDiffCommand).toHaveBeenCalledWith("snapshot baseline");
		expect(harness.setText).not.toHaveBeenCalled();
		expect(settled).toBe(false);

		deferred.resolve();

		expect(await execution).toBe(true);
		expect(settled).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("shortens and normalizes repository paths for diff markdown panels", () => {
		const home = os.homedir();
		const displayPath = formatRepoDiffDisplayPath(path.join(home, "repo\twith-tab"));

		expect(displayPath.startsWith("~")).toBe(true);
		expect(displayPath).not.toContain(home);
		expect(displayPath).not.toContain("\t");
	});
});
