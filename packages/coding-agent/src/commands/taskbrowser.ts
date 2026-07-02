/**
 * `omp taskbrowser` — Task Manager web UI.
 *
 * Server-side rendered HTML + vanilla JS, served via `Bun.serve`.
 * Opens browser via omp's `openPath` from `utils/open.ts`.
 */

import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { Settings, settings } from "../config/settings";
import { Core } from "../task-manager/core";
import { startTaskManagerWebServer } from "../task-manager/web-server";

export default class TaskBrowserCommand extends Command {
	static description = "Open Task Manager web UI";

	static flags = {
		port: Flags.integer({ char: "p", description: "Port for the web server", default: 6420 }),
		"no-open": Flags.boolean({ description: "Do not open browser automatically" }),
	};

	async run(): Promise<void> {
		await Settings.init({ cwd: getProjectDir() });
		if (settings.get("tasks.taskManager") !== true) {
			process.stderr.write("Task Manager is disabled. Enable with: omp config set tasks.taskManager true\n");
			process.exitCode = 1;
			return;
		}

		const { flags } = await this.parse(TaskBrowserCommand);
		const core = new Core(process.cwd());
		await core.ensureConfigLoaded();

		await startTaskManagerWebServer(core, {
			port: flags.port,
			open: !flags["no-open"],
		});

		// Keep the process alive
		await new Promise<void>(resolve => {
			process.on("SIGINT", () => resolve());
			process.on("SIGTERM", () => resolve());
		});
	}
}
