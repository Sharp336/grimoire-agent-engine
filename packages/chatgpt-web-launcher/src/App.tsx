import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { type TranslationKey, t } from "./i18n";
import { AlertIcon, BrowserIcon, CheckIcon, LinkIcon, OmpMark, RestartIcon, RuntimeIcon } from "./icons";
import type {
	LauncherFailureCode,
	LauncherLoginStatus,
	LauncherMcpStatus,
	LauncherMode,
	LauncherPublicState,
	LauncherRuntimeStatus,
	LauncherSetupStatus,
} from "./types";

type Tone = "idle" | "working" | "healthy" | "attention";
type PendingAction = "login" | "mode" | "restart" | "autostart" | null;

const UNAVAILABLE_STATE: LauncherPublicState = Object.freeze({
	revision: 0,
	setup: "failed",
	login: "unknown",
	mode: "browser-only",
	runtime: "failed",
	activeTurns: 0,
	mcp: "disabled",
	autoStart: false,
	failure: Object.freeze({ code: "internal", recoverable: true }),
});

const SETUP_COPY: Record<LauncherSetupStatus, TranslationKey> = {
	checking: "setupChecking",
	ready: "setupReady",
	"login-required": "setupLoginRequired",
	failed: "setupFailed",
};

const LOGIN_COPY: Record<LauncherLoginStatus, TranslationKey> = {
	unknown: "loginUnknown",
	required: "loginRequired",
	"in-progress": "loginInProgress",
	authenticated: "loginAuthenticated",
	failed: "loginFailed",
};

const RUNTIME_COPY: Record<LauncherRuntimeStatus, TranslationKey> = {
	stopped: "runtimeStopped",
	starting: "runtimeStarting",
	ready: "runtimeReady",
	degraded: "runtimeDegraded",
	restarting: "runtimeRestarting",
	failed: "runtimeFailed",
};

const MCP_COPY: Record<LauncherMcpStatus, TranslationKey> = {
	disabled: "mcpDisabled",
	waiting: "mcpWaiting",
	connected: "mcpConnected",
	failed: "mcpFailed",
};

const FAILURE_COPY: Record<LauncherFailureCode, TranslationKey> = {
	configuration: "failureConfiguration",
	authentication: "failureAuthentication",
	browser: "failureBrowser",
	runtime: "failureRuntime",
	mcp: "failureMcp",
	"restart-limit": "failureRestartLimit",
	internal: "failureInternal",
};

function setupTone(status: LauncherSetupStatus): Tone {
	if (status === "ready") return "healthy";
	if (status === "checking") return "working";
	return "attention";
}

function loginTone(status: LauncherLoginStatus): Tone {
	if (status === "authenticated") return "healthy";
	if (status === "unknown" || status === "in-progress") return "working";
	return "attention";
}

function runtimeTone(status: LauncherRuntimeStatus): Tone {
	if (status === "ready") return "healthy";
	if (status === "starting" || status === "restarting") return "working";
	if (status === "degraded" || status === "failed") return "attention";
	return "idle";
}

function mcpTone(status: LauncherMcpStatus): Tone {
	if (status === "connected") return "healthy";
	if (status === "waiting") return "working";
	if (status === "failed") return "attention";
	return "idle";
}

function StatusRow({
	icon,
	label,
	value,
	tone,
	last = false,
}: {
	readonly icon: ReactNode;
	readonly label: string;
	readonly value: string;
	readonly tone: Tone;
	readonly last?: boolean;
}) {
	return (
		<li className="signal-row" data-tone={tone} data-last={last || undefined}>
			<span className="signal-node" aria-hidden="true">
				{tone === "healthy" ? <CheckIcon /> : icon}
			</span>
			<span className="signal-copy">
				<span className="signal-label">{label}</span>
				<span className="signal-value">{value}</span>
			</span>
		</li>
	);
}

function ModeOption({
	mode,
	current,
	title,
	description,
	disabled,
	onSelect,
}: {
	readonly mode: LauncherMode;
	readonly current: LauncherMode;
	readonly title: string;
	readonly description: string;
	readonly disabled: boolean;
	readonly onSelect: (mode: LauncherMode) => void;
}) {
	const selected = mode === current;
	return (
		<button
			type="button"
			className="mode-option"
			role="radio"
			aria-checked={selected}
			data-selected={selected || undefined}
			disabled={disabled}
			onClick={() => onSelect(mode)}
		>
			<span className="mode-radio" aria-hidden="true">
				<span />
			</span>
			<span>
				<strong>{title}</strong>
				<small>{description}</small>
			</span>
		</button>
	);
}

export function App() {
	const [state, setState] = useState<LauncherPublicState | null>(null);
	const [pending, setPending] = useState<PendingAction>(null);
	const [actionFailed, setActionFailed] = useState(false);
	const acceptState = useCallback((next: LauncherPublicState) => {
		setState(current => (current && current.revision > next.revision ? current : next));
	}, []);

	useEffect(() => {
		let mounted = true;
		let unsubscribe = () => {};
		try {
			const api = window.ompChatGptWeb;
			unsubscribe = api.subscribeState(next => {
				if (mounted) acceptState(next);
			});
			void api.getState().then(
				next => {
					if (mounted) acceptState(next);
				},
				() => {
					if (mounted) setState(current => current ?? UNAVAILABLE_STATE);
				},
			);
		} catch {
			setState(UNAVAILABLE_STATE);
		}
		return () => {
			mounted = false;
			unsubscribe();
		};
	}, [acceptState]);

	const runAction = useCallback(
		async (kind: Exclude<PendingAction, null>, action: () => Promise<void>) => {
			setPending(kind);
			setActionFailed(false);
			try {
				await action();
				const next = await window.ompChatGptWeb.getState();
				acceptState(next);
			} catch {
				setActionFailed(true);
			} finally {
				setPending(null);
			}
		},
		[acceptState],
	);

	const failed = state?.failure ?? null;
	const overallHealthy =
		state?.setup === "ready" && state.login === "authenticated" && state.runtime === "ready" && !failed;
	const overallCopy = useMemo(() => (overallHealthy ? t("statusReady") : t("statusAttention")), [overallHealthy]);

	if (!state) {
		return (
			<main className="loading-shell" aria-busy="true">
				<OmpMark className="loading-mark" />
				<p>{t("loading")}</p>
			</main>
		);
	}

	const isBusy = pending !== null;
	return (
		<div className="app-shell">
			<header className="app-header">
				<div className="brand-lockup">
					<span className="brand-mark">
						<OmpMark />
					</span>
					<span>
						<strong>{t("appName")}</strong>
						<small>{t("appDescription")}</small>
					</span>
				</div>
				<div className="overall-status" data-healthy={overallHealthy || undefined} role="status" aria-live="polite">
					<span aria-hidden="true" />
					{overallCopy}
				</div>
			</header>

			<main className="dashboard" aria-busy={isBusy}>
				<section className="status-stage" aria-labelledby="health-heading">
					<div className="section-heading">
						<h1 id="health-heading">{t("healthTitle")}</h1>
						<p>{state.activeTurns === 0 ? t("activeTurnsEmpty") : `${t("activeTurns")}: ${state.activeTurns}`}</p>
					</div>
					<ol className="signal-rail" aria-label={t("healthTitle")}>
						<StatusRow
							icon={<RuntimeIcon />}
							label={t("setupTitle")}
							value={t(SETUP_COPY[state.setup])}
							tone={setupTone(state.setup)}
						/>
						<StatusRow
							icon={<BrowserIcon />}
							label={t("browserTitle")}
							value={t(LOGIN_COPY[state.login])}
							tone={loginTone(state.login)}
						/>
						<StatusRow
							icon={<RuntimeIcon />}
							label={t("healthTitle")}
							value={t(RUNTIME_COPY[state.runtime])}
							tone={runtimeTone(state.runtime)}
						/>
						<StatusRow
							icon={<LinkIcon />}
							label={t("mcpTitle")}
							value={t(MCP_COPY[state.mcp])}
							tone={mcpTone(state.mcp)}
							last
						/>
					</ol>
					<div className="turn-meter" aria-label={`${t("activeTurns")}: ${state.activeTurns}`}>
						<span>{t("activeTurns")}</span>
						<div className="turn-slots" aria-hidden="true">
							{[0, 1, 2, 3, 4].map(index => (
								<i key={index} data-active={index < state.activeTurns || undefined} />
							))}
						</div>
						<strong>{state.activeTurns}/5</strong>
					</div>
				</section>

				<section className="control-stage" aria-labelledby="mode-heading">
					<div className="section-heading compact">
						<h2 id="mode-heading">{t("modeTitle")}</h2>
						<p>{t("modeDescription")}</p>
					</div>
					<div className="mode-switch" role="radiogroup" aria-labelledby="mode-heading">
						<ModeOption
							mode="browser-only"
							current={state.mode}
							title={t("browserOnly")}
							description={t("browserOnlyDescription")}
							disabled={isBusy}
							onSelect={mode => void runAction("mode", () => window.ompChatGptWeb.setMode(mode))}
						/>
						<ModeOption
							mode="full"
							current={state.mode}
							title={t("fullMode")}
							description={t("fullModeDescription")}
							disabled={isBusy}
							onSelect={mode => void runAction("mode", () => window.ompChatGptWeb.setMode(mode))}
						/>
					</div>

					{failed && (
						<div className="failure-panel" role="alert">
							<AlertIcon />
							<div>
								<h2>{t("failureTitle")}</h2>
								<p>{t(FAILURE_COPY[failed.code])}</p>
								<small>{t(failed.recoverable ? "failureRecoverable" : "failureTerminal")}</small>
							</div>
						</div>
					)}

					{actionFailed && (
						<p className="action-error" role="alert">
							{t("actionUnavailable")}
						</p>
					)}

					<div className="action-cluster">
						{(state.login === "required" || state.login === "failed" || state.setup === "login-required") && (
							<button
								type="button"
								className="primary-action"
								disabled={isBusy}
								onClick={() => void runAction("login", () => window.ompChatGptWeb.requestLogin())}
							>
								<BrowserIcon />
								{pending === "login" ? t("openingLogin") : t("requestLogin")}
							</button>
						)}
						<button
							type="button"
							className="secondary-action"
							disabled={isBusy}
							onClick={() => void runAction("restart", () => window.ompChatGptWeb.restartRuntime())}
						>
							<RestartIcon />
							{pending === "restart" ? t("restartingRuntime") : t("restartRuntime")}
						</button>
					</div>

					<label className="autostart-control">
						<input
							type="checkbox"
							checked={state.autoStart}
							disabled={isBusy}
							onChange={event =>
								void runAction("autostart", () =>
									window.ompChatGptWeb.setAutoStart(event.currentTarget.checked),
								)
							}
						/>
						<span aria-hidden="true">
							<i />
						</span>
						<strong>{t("autoStart")}</strong>
					</label>
				</section>
			</main>
		</div>
	);
}
