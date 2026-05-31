import * as fs from "node:fs";
import * as path from "node:path";

export interface JjRepository {
	jjDir: string;
	repoRoot: string;
	workingCopyPath: string;
}

export interface JjStatusSummary {
	staged: number;
	unstaged: number;
	untracked: number;
}

export interface JjWorkingCopy {
	bookmarks: string[];
	changeId: string;
	commitId: string;
	description: string;
}

function commandExists(command: string): boolean {
	const pathValue = process.env.PATH;
	if (!pathValue) return false;
	const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
	for (const dir of pathValue.split(path.delimiter)) {
		for (const ext of extensions) {
			const candidate = path.join(dir || ".", `${command}${ext}`);
			if (fs.existsSync(candidate)) return true;
		}
	}
	return false;
}

export function available(): boolean {
	return commandExists("jj");
}

export function resolveSync(cwd: string): JjRepository | null {
	let dir = path.resolve(cwd);
	while (true) {
		const jjDir = path.join(dir, ".jj");
		if (fs.existsSync(jjDir)) {
			return {
				jjDir,
				repoRoot: dir,
				workingCopyPath: path.join(jjDir, "working_copy", "checkout"),
			};
		}
		if (fs.existsSync(path.join(dir, ".git"))) return null;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

async function runText(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string | null> {
	if (!available()) return null;
	const child = Bun.spawn(["jj", "--no-pager", ...args], {
		cwd,
		signal,
		stdout: "pipe",
		stderr: "ignore",
		windowsHide: true,
	});
	if (!child.stdout) return null;
	const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
	return exitCode === 0 ? stdout : null;
}

export function parseStatus(text: string): JjStatusSummary {
	let unstaged = 0;
	let untracked = 0;
	let section: "changes" | "untracked" | null = null;
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trimEnd();
		if (!line) continue;
		if (line === "Working copy changes:") {
			section = "changes";
			continue;
		}
		if (line === "Untracked paths:") {
			section = "untracked";
			continue;
		}
		if (line === "The working copy is clean") {
			section = null;
			continue;
		}
		if (line.startsWith("Working copy ") || line.startsWith("Parent commit ")) {
			section = null;
			continue;
		}
		if (section === "changes") {
			if (line.startsWith("? ")) untracked += 1;
			else unstaged += 1;
		} else if (section === "untracked" && line.startsWith("? ")) {
			untracked += 1;
		}
	}
	return { staged: 0, unstaged, untracked };
}

export function parseWorkingCopy(text: string): JjWorkingCopy | null {
	const [changeId = "", commitId = "", description = "", bookmarks = ""] = text.trimEnd().split("\n");
	if (!changeId) return null;
	return {
		bookmarks: bookmarks.split(" ").filter(Boolean),
		changeId,
		commitId,
		description,
	};
}

export const status = {
	async summary(cwd: string, signal?: AbortSignal): Promise<JjStatusSummary | null> {
		const output = await runText(cwd, ["status", "--color", "never"], signal);
		return output === null ? null : parseStatus(output);
	},
};

export async function workingCopy(cwd: string, signal?: AbortSignal): Promise<JjWorkingCopy | null> {
	const output = await runText(
		cwd,
		[
			"log",
			"-r",
			"@",
			"--no-graph",
			"--color",
			"never",
			"-T",
			'change_id.shortest(8) ++ "\\n" ++ commit_id.shortest(8) ++ "\\n" ++ description.first_line() ++ "\\n" ++ bookmarks.join(" ")',
		],
		signal,
	);
	return output === null ? null : parseWorkingCopy(output);
}
