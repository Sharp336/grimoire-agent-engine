// Interactive TUI Component for the Quota Dashboard.
// Implements pi-tui Component interface with keyboard navigation, collapse/expand, filtering, and refresh.

import type { MinimalTheme } from "./format";
import type { QuotaDashboardModel } from "./hierarchy";
import { matchActionKey } from "./keys";
import {
	collectSelectables,
	type DashboardViewState,
	renderDashboard,
	type SelectableTarget,
} from "./render-dashboard";

export interface QuotaDashboardOptions {
	model: QuotaDashboardModel;
	theme: MinimalTheme;
	requestRender: () => void;
	onRefresh: () => Promise<QuotaDashboardModel | null>;
	onClose: () => void;
}

export class QuotaDashboardComponent {
	private model: QuotaDashboardModel;
	private readonly theme: MinimalTheme;
	private readonly requestRender: () => void;
	private readonly onRefreshCallback: () => Promise<QuotaDashboardModel | null>;
	private readonly onCloseCallback: () => void;

	private viewState: DashboardViewState;
	private selectables: SelectableTarget[] = [];
	private cachedRender: readonly string[] = [];
	private lastWidth = 0;
	private isDisposed = false;

	constructor(options: QuotaDashboardOptions) {
		this.model = options.model;
		this.theme = options.theme;
		this.requestRender = options.requestRender;
		this.onRefreshCallback = options.onRefresh;
		this.onCloseCallback = options.onClose;

		// Initial collapse state:
		// Accounts with issues or active accounts default to expanded.
		// Accounts in single-account providers default to expanded.
		// Completely healthy accounts in multi-account providers default to collapsed.
		const collapsedAccounts = new Set<string>();
		const collapsedPools = new Set<string>();

		for (const provider of this.model.providers) {
			const isMultiAccount = provider.accounts.length > 1;
			for (const account of provider.accounts) {
				if (isMultiAccount && !account.healthSummary.hasIssues && !account.isActive) {
					collapsedAccounts.add(account.id);
				}
			}
		}

		this.viewState = {
			selectedIndex: 0,
			collapsedAccounts,
			collapsedPools,
			attentionOnly: false,
			hideHealthy: false,
			isRefreshing: false,
		};

		this.refreshSelectables();
	}

	private refreshSelectables(): void {
		this.selectables = collectSelectables(this.model, this.viewState);
		if (this.viewState.selectedIndex >= this.selectables.length) {
			this.viewState.selectedIndex = Math.max(0, this.selectables.length - 1);
		}
	}

	public updateModel(newModel: QuotaDashboardModel): void {
		this.model = newModel;
		this.viewState.isRefreshing = false;
		this.viewState.refreshError = undefined;
		this.refreshSelectables();
		this.invalidate();
		this.requestRender();
	}

	public render(width: number): readonly string[] {
		if (this.cachedRender.length > 0 && this.lastWidth === width) {
			return this.cachedRender;
		}
		this.lastWidth = width;
		this.cachedRender = Object.freeze(renderDashboard(this.model, this.viewState, this.theme, width));
		return this.cachedRender;
	}

	public handleInput(data: string): void {
		if (this.isDisposed) return;

		const action = matchActionKey(data);
		switch (action) {
			case "close":
			case "escape":
				this.onCloseCallback();
				break;

			case "up":
				if (this.selectables.length > 0) {
					this.viewState.selectedIndex = Math.max(0, this.viewState.selectedIndex - 1);
					this.invalidate();
					this.requestRender();
				}
				break;

			case "down":
				if (this.selectables.length > 0) {
					this.viewState.selectedIndex = Math.min(this.selectables.length - 1, this.viewState.selectedIndex + 1);
					this.invalidate();
					this.requestRender();
				}
				break;

			case "home":
				this.viewState.selectedIndex = 0;
				this.invalidate();
				this.requestRender();
				break;

			case "end":
				this.viewState.selectedIndex = Math.max(0, this.selectables.length - 1);
				this.invalidate();
				this.requestRender();
				break;

			case "page_up":
				this.viewState.selectedIndex = Math.max(0, this.viewState.selectedIndex - 5);
				this.invalidate();
				this.requestRender();
				break;

			case "page_down":
				this.viewState.selectedIndex = Math.min(this.selectables.length - 1, this.viewState.selectedIndex + 5);
				this.invalidate();
				this.requestRender();
				break;

			case "enter":
				this.toggleSelected();
				break;

			case "toggle_attention":
				this.viewState.attentionOnly = !this.viewState.attentionOnly;
				this.viewState.selectedIndex = 0;
				this.refreshSelectables();
				this.invalidate();
				this.requestRender();
				break;

			case "toggle_healthy":
				this.viewState.hideHealthy = !this.viewState.hideHealthy;
				this.refreshSelectables();
				this.invalidate();
				this.requestRender();
				break;

			case "refresh":
				this.triggerRefresh();
				break;
		}
	}

	private toggleSelected(): void {
		const current = this.selectables[this.viewState.selectedIndex];
		if (!current) return;

		if (current.kind === "account") {
			if (this.viewState.collapsedAccounts.has(current.id)) {
				this.viewState.collapsedAccounts.delete(current.id);
			} else {
				this.viewState.collapsedAccounts.add(current.id);
			}
		} else if (current.kind === "pool") {
			if (this.viewState.collapsedPools.has(current.id)) {
				this.viewState.collapsedPools.delete(current.id);
			} else {
				this.viewState.collapsedPools.add(current.id);
			}
		}

		this.refreshSelectables();
		this.invalidate();
		this.requestRender();
	}

	private triggerRefresh(): void {
		if (this.viewState.isRefreshing) return;
		this.viewState.isRefreshing = true;
		this.viewState.refreshError = undefined;
		this.invalidate();
		this.requestRender();

		Promise.resolve(this.onRefreshCallback())
			.then(freshModel => {
				if (this.isDisposed) return;
				if (freshModel) {
					this.updateModel(freshModel);
				} else {
					this.viewState.isRefreshing = false;
					this.viewState.refreshError = "No data returned";
					this.invalidate();
					this.requestRender();
				}
			})
			.catch(err => {
				if (this.isDisposed) return;
				this.viewState.isRefreshing = false;
				this.viewState.refreshError = err instanceof Error ? err.message : String(err);
				this.invalidate();
				this.requestRender();
			});
	}

	public invalidate(): void {
		this.cachedRender = [];
	}

	public dispose(): void {
		this.isDisposed = true;
		this.cachedRender = [];
	}
}
