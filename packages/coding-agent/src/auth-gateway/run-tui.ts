import { AuthGatewayAdminClient } from "@oh-my-pi/pi-ai/auth-gateway";
import type { Component, OverlayHandle, TUI } from "@oh-my-pi/pi-tui";
import { ProcessTerminal, TUI as TerminalUi } from "@oh-my-pi/pi-tui";
import { Settings } from "../config/settings";
import type { AuthGatewayConsoleOptions } from "../modes/components/auth-gateway/console";
import { AuthGatewayConsole } from "../modes/components/auth-gateway/console";
import { GatewayProfileSettingsComponent } from "../modes/components/auth-gateway/profile-settings";
import { openPath } from "../utils/open";
import { AuthGatewayProfileStore, type ResolvedAuthGatewayConnection } from "./profiles";

const NO_CONNECTION_ERROR = "No auth-gateway connection is configured";

export interface RunAuthGatewayTuiOptions {
	connection?: string;
	profileStore?: AuthGatewayProfileStore;
}

export interface ShowAuthGatewayConsoleOverlayOptions extends RunAuthGatewayTuiOptions {
	ui: TUI;
	createClient?(connection: ResolvedAuthGatewayConnection): AuthGatewayAdminClient;
	openInBrowser?(url: string): void;
	afterClose?(): void;
}

export interface RunAuthGatewayTuiDependencyOptions extends ShowAuthGatewayConsoleOverlayOptions {
	start?(): void;
	stop?(): void;
}

interface MountedOverlay {
	component: Component;
	handle: OverlayHandle;
}

export function createAuthGatewayAdminClient(connection: ResolvedAuthGatewayConnection): AuthGatewayAdminClient {
	return new AuthGatewayAdminClient({ url: connection.profile.url, token: connection.token });
}

export function createAuthGatewayConsole(options: AuthGatewayConsoleOptions): AuthGatewayConsole {
	return new AuthGatewayConsole(options);
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function isNoConnectionError(error: unknown): boolean {
	return error instanceof Error && error.message === NO_CONNECTION_ERROR;
}

function hideMountedOverlay(mounted: MountedOverlay | null): void {
	mounted?.handle.hide();
	mounted?.component.dispose?.();
}

export async function showAuthGatewayConsoleOverlay(options: ShowAuthGatewayConsoleOverlayOptions): Promise<void> {
	const profileStore = options.profileStore ?? AuthGatewayProfileStore.open();
	const createClient = options.createClient ?? createAuthGatewayAdminClient;
	const openInBrowser = options.openInBrowser ?? openPath;
	let mounted: MountedOverlay | null = null;
	let settled = false;
	const closed = Promise.withResolvers<void>();

	const cleanupMountedOverlay = (): void => {
		hideMountedOverlay(mounted);
		mounted = null;
	};
	const finish = (): void => {
		if (settled) return;
		settled = true;
		cleanupMountedOverlay();
		closed.resolve();
	};
	const fail = (error: unknown): void => {
		if (settled) return;
		settled = true;
		cleanupMountedOverlay();
		closed.reject(toError(error));
	};
	const mount = (component: Component): void => {
		hideMountedOverlay(mounted);
		const handle = options.ui.showOverlay(component, {
			anchor: "top-left",
			width: "100%",
			maxHeight: "100%",
			margin: 0,
			fullscreen: true,
		});
		mounted = { component, handle };
		options.ui.setFocus(component);
		options.ui.requestRender();
	};
	const openConsole = async (connectionName?: string): Promise<void> => {
		const connection = await profileStore.resolve(connectionName);
		const consoleComponent = createAuthGatewayConsole({
			connection,
			profileStore,
			createClient,
			host: {
				ui: options.ui,
				openInBrowser,
				close: finish,
			},
		});
		mount(consoleComponent);
		void consoleComponent.ready.catch(fail);
	};

	try {
		try {
			await openConsole(options.connection);
		} catch (error) {
			if (options.connection !== undefined || !isNoConnectionError(error)) throw error;
			const onboarding = new GatewayProfileSettingsComponent(
				{
					profileStore,
					createClient,
					requestRender: () => options.ui.requestRender(),
				},
				{
					onboarding: true,
					onCancel: finish,
					onConnectionReady: name => {
						void openConsole(name).catch(fail);
					},
				},
			);
			mount(onboarding);
		}
		await closed.promise;
	} finally {
		cleanupMountedOverlay();
		options.afterClose?.();
		options.ui.requestRender();
	}
}

export async function runAuthGatewayTuiWithDependencies(options: RunAuthGatewayTuiDependencyOptions): Promise<void> {
	const start = options.start ?? (() => options.ui.start());
	const stop = options.stop ?? (() => options.ui.stop());
	start();
	try {
		await showAuthGatewayConsoleOverlay(options);
	} finally {
		stop();
	}
}

export async function runAuthGatewayTui(options: RunAuthGatewayTuiOptions = {}): Promise<void> {
	await Settings.init();
	const ui = new TerminalUi(new ProcessTerminal());
	await runAuthGatewayTuiWithDependencies({
		ui,
		connection: options.connection,
		profileStore: options.profileStore ?? AuthGatewayProfileStore.open(),
		openInBrowser: openPath,
	});
}
