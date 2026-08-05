// Desktop notification delivery for BEL-only terminals: D-Bus on Linux,
// WinRT toasts (via PowerShell) on Windows.
//
// Several terminal families — most notably the VTE-based stack (Ptyxis,
// GNOME Terminal, Tilix, Terminator) but also Alacritty and bare xterm — have
// `notifyProtocol === Bell`, which means `formatNotification()` emits only a
// raw BEL. BEL alone never surfaces an arbitrary-text toast on those hosts
// (see #3685): Ptyxis hooks BEL to a CSS visual-bell flash, GNOME Terminal
// rings the audible bell. None of OSC 9 (ConEmu progress in VTE), OSC 99
// (unimplemented), or OSC 777 (only `notify;Command completed` → unused
// shell-postexec termprop in current VTE) produce a desktop notification.
//
// The freedesktop `org.freedesktop.Notifications` D-Bus service is the only
// path that consistently delivers toasts on those terminals across Wayland
// and X11. We invoke it out-of-process via `notify-send` (the canonical
// libnotify CLI present on every modern Linux desktop) and fall back to
// `gdbus call` when libnotify is absent but GLib is installed.
//
// On Windows (#7272) no console host maps BEL to a toast either, and there is
// no session bus. The only dependency-free path to a native toast for an
// unpackaged console app is the WinRT `ToastNotificationManager`, which
// Windows PowerShell 5.1 (always present at `%SystemRoot%\System32\
// WindowsPowerShell\v1.0\powershell.exe`) can project in-process. We spawn it
// hidden with an `-EncodedCommand` (UTF-16LE base64) so title/body never pass
// through cmd-style argv quoting, and reuse PowerShell's registered
// AppUserModelId so the toast works without app registration or packaging.
//
// Delivery is fire-and-forget: a failed spawn or missing binary is treated as
// a silent no-op so terminals that already deliver toasts in-band (Kitty,
// iTerm2, WezTerm, …) keep working unchanged and the BEL emission still fires
// for tmux `monitor-bell`, X11 urgency hints, and audible-bell handlers.

import * as fs from "node:fs";
import * as path from "node:path";
import { $which } from "@oh-my-pi/pi-utils";
import type { TerminalId, TerminalNotification } from "./terminal-capabilities";

/** Application name surfaced as the notification source. */
const APP_NAME = "Oh My Pi";

/** Resolved notifier binary used to fan a notification out of process. */
export type DesktopNotifierKind = "notify-send" | "gdbus" | "powershell";

export interface DesktopNotifier {
	kind: DesktopNotifierKind;
	path: string;
}

/**
 * Whether the current process can reach a freedesktop notification daemon:
 * Linux platform + a session bus address in env. Caller is still responsible
 * for resolving a delivery binary via {@link resolveDesktopNotifier}.
 */
export function hasLinuxDesktopSession(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = Bun.env,
): boolean {
	if (platform !== "linux") return false;
	return Boolean(env.DBUS_SESSION_BUS_ADDRESS);
}

/**
 * Whether the current process can surface a native Windows toast: win32
 * platform, an interactive logon session (`SESSIONNAME` is set for console
 * and RDP sessions but not for services / session-0 hosts, the analog of the
 * `DBUS_SESSION_BUS_ADDRESS` gate on Linux), and not an SSH session (a toast
 * on a remote host the user is not looking at is noise; the BEL still
 * reaches the local terminal in-band).
 */
export function hasWindowsDesktopSession(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = Bun.env,
): boolean {
	if (platform !== "win32") return false;
	if (!env.SESSIONNAME) return false;
	return !env.SSH_CONNECTION && !env.SSH_CLIENT && !env.SSH_TTY;
}

/**
 * Whether `sendNotification` should also dispatch a desktop toast for this
 * terminal. Returns true only when (1) the chosen `notifyProtocol` is BEL,
 * which cannot carry arbitrary toast text, (2) the host exposes a Linux or
 * Windows desktop session, and (3) the user has not opted out via
 * `PI_NO_DESKTOP_NOTIFY=1`. Terminals that genuinely speak OSC 9 / OSC 99
 * pass `notifyProtocolIsBell=false` and are filtered before the fallback can
 * run. Pure helper for tests and the singleton path.
 */
export function shouldDeliverDesktopNotification(
	_terminalId: TerminalId,
	notifyProtocolIsBell: boolean,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = Bun.env,
): boolean {
	if (!notifyProtocolIsBell) return false;
	if (env.PI_NO_DESKTOP_NOTIFY === "1") return false;
	return hasLinuxDesktopSession(platform, env) || hasWindowsDesktopSession(platform, env);
}

let cachedNotifier: DesktopNotifier | null | undefined;

/** Reset the cached notifier resolution. Tests only. */
export function resetDesktopNotifierCache(): void {
	cachedNotifier = undefined;
}

/**
 * Locate a libnotify-compatible delivery binary on `PATH`, preferring
 * `notify-send` (one-shot, no marshalling) and falling back to `gdbus call`
 * for hosts where libnotify is not installed but GLib is. Result is cached so
 * repeated notifications do not hit `$which` again.
 */
export function resolveDesktopNotifier(platform: NodeJS.Platform = process.platform): DesktopNotifier | null {
	if (cachedNotifier !== undefined) return cachedNotifier;
	if (platform === "win32") {
		// Windows PowerShell 5.1 only: it ships with every Windows 10/11 install
		// and projects WinRT types in-process. pwsh (PowerShell 7+) cannot load
		// `Windows.UI.Notifications` without the Microsoft.Windows.SDK.NET
		// assemblies, so it is not a usable fallback.
		const onPath = $which("powershell.exe") ?? $which("powershell");
		if (onPath) {
			cachedNotifier = { kind: "powershell", path: onPath };
			return cachedNotifier;
		}
		const canonical = path.join(
			Bun.env.SystemRoot ?? "C:\\Windows",
			"System32",
			"WindowsPowerShell",
			"v1.0",
			"powershell.exe",
		);
		cachedNotifier = fs.existsSync(canonical) ? { kind: "powershell", path: canonical } : null;
		return cachedNotifier;
	}
	const notifySend = $which("notify-send");
	if (notifySend) {
		cachedNotifier = { kind: "notify-send", path: notifySend };
		return cachedNotifier;
	}
	const gdbus = $which("gdbus");
	if (gdbus) {
		cachedNotifier = { kind: "gdbus", path: gdbus };
		return cachedNotifier;
	}
	cachedNotifier = null;
	return null;
}

interface ResolvedNotificationFields {
	title: string;
	body: string;
	urgency: "low" | "normal" | "critical";
}

function resolveFields(message: string | TerminalNotification): ResolvedNotificationFields {
	if (typeof message === "string") {
		return { title: APP_NAME, body: message, urgency: "normal" };
	}
	const title = message.title?.trim() || APP_NAME;
	const body = message.body ?? "";
	const urgency = message.urgency === "critical" || message.urgency === "low" ? message.urgency : "normal";
	return { title, body, urgency };
}

const URGENCY_BYTE: Record<ResolvedNotificationFields["urgency"], number> = {
	low: 0,
	normal: 1,
	critical: 2,
};

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * AppUserModelId the toast is attributed to. Unpackaged console apps have no
 * registered AUMID of their own, and `CreateToastNotifier()` (parameterless)
 * throws outside a packaged app — reusing Windows PowerShell's shortcut AUMID
 * is the standard way for an unpackaged process to surface a toast without
 * touching the registry.
 */
const POWERSHELL_AUMID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

/**
 * Build the PowerShell script that raises a WinRT toast for `message`. Pure
 * helper so tests assert the exact script without spawning a child. Title and
 * body are XML-escaped into the toast payload, which leaves no `'` in the
 * XML, so embedding it as a single-quoted PowerShell string runs no
 * interpolation. Critical urgency maps to the `urgent` toast scenario, which
 * keeps the toast on screen until dismissed.
 */
export function buildWindowsToastScript(message: string | TerminalNotification): string {
	const { title, body, urgency } = resolveFields(message);
	const scenario = urgency === "critical" ? ' scenario="urgent"' : "";
	const xml =
		`<toast${scenario}><visual><binding template="ToastGeneric">` +
		`<text>${escapeXml(title)}</text><text>${escapeXml(body)}</text>` +
		`</binding></visual></toast>`;
	return [
		"[void][Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]",
		"[void][Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]",
		"$xml=New-Object Windows.Data.Xml.Dom.XmlDocument",
		`$xml.LoadXml('${xml}')`,
		`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_AUMID}').Show([Windows.UI.Notifications.ToastNotification]::new($xml))`,
	].join("\n");
}

/**
 * Build the argv that delivers `message` through the resolved notifier. Pure
 * helper so tests assert exact wire shape without spawning a child. Notes:
 * - `notify-send` accepts title + body positionally and a numeric expire
 *   timeout (`-t`); urgency is a flag.
 * - `gdbus call ... Notify` takes the freedesktop signature
 *   `s u s s s as a{sv} i`: app_name, replaces_id, app_icon, summary, body,
 *   actions, hints, expire_timeout. We feed hints with the urgency byte so
 *   the daemon classifies the toast identically to `notify-send`.
 * - `powershell` runs the WinRT toast script via `-EncodedCommand` (UTF-16LE
 *   base64) so the payload survives argv intact with no shell re-quoting.
 */
export function buildDesktopNotifyCommand(notifier: DesktopNotifier, message: string | TerminalNotification): string[] {
	if (notifier.kind === "powershell") {
		const encoded = Buffer.from(buildWindowsToastScript(message), "utf16le").toString("base64");
		return [
			notifier.path,
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-WindowStyle",
			"Hidden",
			"-EncodedCommand",
			encoded,
		];
	}
	const { title, body, urgency } = resolveFields(message);
	if (notifier.kind === "notify-send") {
		return [notifier.path, "--app-name", APP_NAME, `--urgency=${urgency}`, "--expire-time=5000", title, body];
	}
	const hints = `{"urgency": <byte ${URGENCY_BYTE[urgency]}>}`;
	return [
		notifier.path,
		"call",
		"--session",
		"--dest",
		"org.freedesktop.Notifications",
		"--object-path",
		"/org/freedesktop/Notifications",
		"--method",
		"org.freedesktop.Notifications.Notify",
		APP_NAME,
		"0",
		"",
		title,
		body,
		"[]",
		hints,
		"5000",
	];
}

/**
 * Fire-and-forget desktop notification. Resolves a notifier, spawns it
 * with stdio fully detached, and never throws — terminal notifications are
 * best-effort and must not block the renderer or interleave bytes onto
 * stdout. Caller is responsible for the gating check
 * ({@link shouldDeliverDesktopNotification}).
 */
export function sendDesktopNotification(
	message: string | TerminalNotification,
	platform: NodeJS.Platform = process.platform,
): void {
	const notifier = resolveDesktopNotifier(platform);
	if (!notifier) return;
	try {
		// `.unref()` lets the event loop exit while the notifier is still running.
		// Without it, an unresponsive D-Bus activation (slow `notify-send`, hung
		// `gdbus` waiting on a stalled session bus) would keep `omp` alive past
		// the renderer's shutdown — a completion toast must never delay process
		// exit. Ignored stdio alone does not detach the child from the parent's
		// reference count.
		const child = Bun.spawn({
			cmd: buildDesktopNotifyCommand(notifier, message),
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		child.unref();
	} catch {
		// Best-effort: a failed spawn is silent.
	}
}
