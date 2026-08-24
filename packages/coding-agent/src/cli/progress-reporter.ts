import { formatBytes } from "@oh-my-pi/pi-utils";

const BAR_WIDTH = 16;

/** Minimal output contract used by the interactive progress reporter. */
export interface ProgressOutput {
	isTTY?: boolean;
	write(text: string): boolean;
}

/** Renders completed units of work on one transient terminal line. */
export interface ProgressReporter {
	readonly interactive: boolean;
	start(total: number): void;
	complete(): void;
	finish(): void;
}

/**
 * Create a TTY-only completion bar labelled `label`, e.g. `Repairing [████░░░░] 4/8`.
 *
 * Non-interactive output disables rendering entirely, so callers can print plain
 * per-item lines instead by checking {@link ProgressReporter.interactive}.
 */
export function createProgressReporter(label: string, output: ProgressOutput = process.stdout): ProgressReporter {
	const interactive = output.isTTY === true;
	let total = 0;
	let completed = 0;
	let rendered = false;

	const render = (): void => {
		if (!interactive || total === 0) return;
		const ratio = Math.min(completed / total, 1);
		const filled = Math.round(ratio * BAR_WIDTH);
		const bar = `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
		output.write(`\r${label} [${bar}] ${completed}/${total}\x1b[K`);
		rendered = true;
	};

	return {
		interactive,
		start(nextTotal) {
			total = Math.max(nextTotal, 0);
			completed = 0;
			render();
		},
		complete() {
			completed = Math.min(completed + 1, total);
			render();
		},
		finish() {
			if (!rendered) return;
			output.write("\n");
			rendered = false;
		},
	};
}

const DOWNLOAD_BAR_WIDTH = 20;
const DOWNLOAD_PROGRESS_INTERVAL_MS = 1_000;

export interface DownloadProgressReporter {
	update(received: number): void;
	finish(): void;
}

function formatDownloadProgress(label: string, received: number, total: number, elapsedMs: number): string {
	const ratio = total > 0 ? Math.min(received / total, 1) : 0;
	const filled = Math.round(ratio * DOWNLOAD_BAR_WIDTH);
	const bar = `${"█".repeat(filled)}${"░".repeat(DOWNLOAD_BAR_WIDTH - filled)}`;
	const percent = `${Math.floor(ratio * 100)
		.toString()
		.padStart(3, " ")}%`;
	const rate = elapsedMs > 0 ? formatBytes((received * 1_000) / elapsedMs) : "0B";
	return `${label} [${bar}] ${percent} ${formatBytes(received)} / ${formatBytes(total)} ${rate}/s`;
}

export function createDownloadProgressReporter(
	label: string,
	total: number,
	output: ProgressOutput = process.stdout,
	now: () => number = Date.now,
): DownloadProgressReporter {
	const interactive = output.isTTY === true;
	const boundedTotal = Math.max(total, 0);
	const startedAt = now();
	let lastRenderedAt = Number.NEGATIVE_INFINITY;
	let received = 0;
	let rendered = false;

	const render = (force = false): void => {
		const currentTime = now();
		if (!force && currentTime - lastRenderedAt < DOWNLOAD_PROGRESS_INTERVAL_MS) return;
		const line = formatDownloadProgress(label, received, boundedTotal, currentTime - startedAt);
		output.write(interactive ? `\r${line}\x1b[K` : `${line}\n`);
		lastRenderedAt = currentTime;
		rendered = true;
	};

	return {
		update(nextReceived) {
			received = Math.max(received, Math.min(nextReceived, boundedTotal));
			render(received >= boundedTotal);
		},
		finish() {
			if (interactive && rendered) output.write("\n");
		},
	};
}
