/**
 * `omp doctor` CLI handler.
 *
 * Reads `~/.omp/state/auto-update.json` (produced by the launchd auto-update
 * job at `~/.omp/patches/update-and-patch.sh`) and renders a Korean-first
 * one-screen status report. Designed for a non-developer operator: the
 * report ends with exactly one concrete next action.
 *
 * This command never mutates state. It does not call git, does not call
 * network, does not modify any file. Safe to run any time.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { APP_NAME, VERSION } from "@oh-my-pi/pi-utils";
import chalk from "chalk";

const STATE_FILE = path.join(process.env.HOME ?? "", ".omp", "state", "auto-update.json");

export interface AutoUpdateState {
	schema_version: number;
	updated_at: string;
	outcome:
		| "up-to-date"
		| "rebased"
		| "skip-dirty"
		| "skip-branch-mismatch"
		| "skip-fetch-failed"
		| "conflict";
	branch: { current: string; expected: string; match: boolean };
	git: { head_before: string; head_after: string; origin_main: string; behind: number; ahead: number };
	dirty: { modified: number; staged: number; untracked: number; any: boolean };
	version: { local_before: string; local_after: string; upstream_main: string };
	wip_snapshot: null | { branch: string; commit: string; pushed_to: string; pushed_at: string };
	conflict: null | { files: string[]; backup_ref: string; rebase_command: string };
	next_recommendation:
		| "none"
		| "wait"
		| "commit-and-clean"
		| "switch-branch"
		| "resolve-conflict"
		| "check-network";
	omp_realpath: string;
}

/**
 * Pretty-print the auto-update state for a non-developer operator. All prose
 * is Korean; only identifiers (paths, branch names, commands) stay English.
 */
export function renderDoctorReport(state: AutoUpdateState | undefined): string {
	const lines: string[] = [];
	const h = (s: string) => chalk.bold(s);
	const dim = (s: string) => chalk.dim(s);
	const ok = (s: string) => chalk.green(s);
	const warn = (s: string) => chalk.yellow(s);
	const bad = (s: string) => chalk.red(s);

	lines.push(h(`${APP_NAME} doctor`));
	lines.push(dim(`현재 omp 버전: ${VERSION}`));
	lines.push("");

	if (!state) {
		lines.push(warn("자동 업데이트 상태 파일을 아직 찾지 못했어요."));
		lines.push(dim(`경로: ${STATE_FILE}`));
		lines.push("");
		lines.push("→ 다음 launchd cycle(최대 10분 이내)이 돌면 파일이 생깁니다.");
		lines.push(`  지금 바로 돌리고 싶으면: ${chalk.cyan(`launchctl kickstart gui/$(id -u)/com.leo.omp-update`)}`);
		return lines.join("\n");
	}

	// ── status block ───────────────────────────────────────────────────────
	const outcomeLabel: Record<AutoUpdateState["outcome"], string> = {
		"up-to-date": ok("정상 — 최신 upstream과 일치"),
		rebased: ok("정상 — 방금 upstream 위로 rebase 성공"),
		"skip-dirty": warn("대기 중 — 작업 중인 파일이 있어 rebase 건너뜀 (WIP은 fork에 백업됨)"),
		"skip-branch-mismatch": warn("대기 중 — 기대한 브랜치가 아니라 rebase 건너뜀"),
		"skip-fetch-failed": bad("문제 — upstream fetch 실패 (네트워크 확인 필요)"),
		conflict: bad("문제 — rebase 충돌, 자동화 중단. 사용자 조치 필요"),
	};
	lines.push(h("상태"));
	lines.push(`  ${outcomeLabel[state.outcome] ?? state.outcome}`);
	lines.push(dim(`  마지막 cycle: ${state.updated_at}`));
	lines.push("");

	// ── version block ──────────────────────────────────────────────────────
	lines.push(h("버전"));
	if (state.version.local_before === state.version.upstream_main) {
		lines.push(`  로컬 dev tree: ${state.version.local_before}  (= upstream)`);
	} else {
		lines.push(
			`  로컬 dev tree: ${state.version.local_before}  ${dim("→")}  ` +
				`upstream/main: ${state.version.upstream_main}  ${dim(`(${state.git.behind} commits behind)`)}`,
		);
	}
	if (state.version.local_after && state.version.local_after !== state.version.local_before) {
		lines.push(ok(`  이번 cycle에 ${state.version.local_before} → ${state.version.local_after}로 올라옴.`));
	}
	lines.push("");

	// ── git block ──────────────────────────────────────────────────────────
	lines.push(h("git"));
	const branchOK = state.branch.match ? "" : warn(` (기대값: ${state.branch.expected})`);
	lines.push(`  현재 브랜치: ${state.branch.current}${branchOK}`);
	lines.push(`  HEAD: ${state.git.head_before}  ${dim(`upstream/main: ${state.git.origin_main}`)}`);
	if (state.git.behind > 0 || state.git.ahead > 0) {
		lines.push(dim(`  behind ${state.git.behind} / ahead ${state.git.ahead}`));
	}
	const dirtyParts: string[] = [];
	if (state.dirty.modified > 0) dirtyParts.push(`수정 ${state.dirty.modified}`);
	if (state.dirty.staged > 0) dirtyParts.push(`staged ${state.dirty.staged}`);
	if (state.dirty.untracked > 0) dirtyParts.push(`새 파일 ${state.dirty.untracked}`);
	if (dirtyParts.length > 0) {
		lines.push(`  작업 중인 파일: ${warn(dirtyParts.join(", "))}`);
	} else {
		lines.push(`  작업 중인 파일: ${ok("없음 (clean)")}`);
	}
	lines.push("");

	// ── wip backup block ───────────────────────────────────────────────────
	if (state.wip_snapshot) {
		lines.push(h("WIP 백업"));
		lines.push(
			ok(`  ${state.wip_snapshot.pushed_to}/${state.wip_snapshot.branch}`) +
				dim(` (${state.wip_snapshot.commit.slice(0, 12)}, ${state.wip_snapshot.pushed_at})`),
		);
		lines.push(dim("  작업 잃을 위험 없음. 디스크 손실에도 fork에서 복구 가능."));
		lines.push("");
	} else if (state.dirty.any) {
		lines.push(h("WIP 백업"));
		lines.push(bad("  실패 — 백업이 안 됐어요. fork push 권한을 확인하세요."));
		lines.push("");
	}

	// ── conflict block ─────────────────────────────────────────────────────
	if (state.conflict) {
		lines.push(h("충돌 상세"));
		lines.push(`  충돌 파일: ${state.conflict.files.join(", ") || "(없음)"}`);
		lines.push(dim(`  backup ref: ${state.conflict.backup_ref}`));
		lines.push(dim(`  시도한 명령: ${state.conflict.rebase_command}`));
		lines.push("");
	}

	// ── next action — exactly one ─────────────────────────────────────────
	lines.push(h("다음에 할 일"));
	const nextActionLabel: Record<AutoUpdateState["next_recommendation"], string[]> = {
		none: ["없음. 새 omp 세션을 열면 최신 상태로 시작됩니다."],
		wait: ["없음. 다음 cycle(최대 10분 이내)을 기다리면 됩니다."],
		"commit-and-clean": [
			"작업 중인 파일을 commit하거나 정리하면 그 다음 cycle에 rebase가 자동 진행됩니다.",
			"가장 빠른 방법:",
			`  cd ${state.omp_realpath.replace(/\/packages\/.+$/, "")}`,
			'  git add -A && git commit -m "wip: 작업 중간 저장"',
			"또는 commit이 부담이면 일단 그대로 두세요. fork 백업이 매 cycle 갱신됩니다.",
		],
		"switch-branch": [
			`기대 브랜치 ${chalk.cyan(state.branch.expected)}가 아니에요.`,
			`다시 그 브랜치로 옮기려면: ${chalk.cyan(`git switch ${state.branch.expected}`)} (dev tree에서)`,
			`다른 브랜치를 계속 쓰려면: ${chalk.cyan(`launchctl setenv OMP_UPDATE_BRANCH ${state.branch.current}`)}`,
		],
		"resolve-conflict": [
			"충돌 자동 해결 안 함. 직접 봐주세요.",
			`  cd ${state.omp_realpath.replace(/\/packages\/.+$/, "")}`,
			`  ${state.conflict?.rebase_command ?? "git rebase origin/main"}`,
			"  ... (충돌 파일을 편집, git add, git rebase --continue)",
			`만약 망쳤다면 복구: ${chalk.cyan(`git reset --hard ${state.conflict?.backup_ref ?? "<backup_ref>"}`)}`,
		],
		"check-network": [
			"upstream fetch 자체가 실패했어요. 네트워크 또는 origin remote 권한을 확인하세요.",
			"  git -C <dev tree> fetch origin   # 직접 실행해 보면 원인 보임",
		],
	};
	const next = nextActionLabel[state.next_recommendation] ?? [
		`(알 수 없는 추천: ${state.next_recommendation})`,
	];
	for (const line of next) {
		lines.push(`  ${line}`);
	}

	return lines.join("\n");
}

/**
 * Load the state file. Returns undefined when missing (first-run case).
 * Surfaces parse errors to the caller — we never silently swallow a corrupt
 * state file because that would mask real problems.
 */
export function loadAutoUpdateState(stateFile = STATE_FILE): AutoUpdateState | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(stateFile, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
	return JSON.parse(raw) as AutoUpdateState;
}

export async function runDoctorCommand(opts: { json: boolean }): Promise<void> {
	let state: AutoUpdateState | undefined;
	try {
		state = loadAutoUpdateState();
	} catch (err) {
		console.error(chalk.red(`state 파일을 읽지 못했어요: ${err}`));
		console.error(chalk.dim(`경로: ${STATE_FILE}`));
		process.exit(1);
	}

	if (opts.json) {
		if (!state) {
			console.log("null");
			return;
		}
		console.log(JSON.stringify(state, null, 2));
		return;
	}

	console.log(renderDoctorReport(state));
}
