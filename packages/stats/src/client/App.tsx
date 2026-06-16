import { useCallback, useEffect, useState } from "react";
import {
	getBehaviorDashboardStats,
	getCostDashboardStats,
	getModelDashboardStats,
	getOverviewStats,
	getRecentErrors,
	getRecentRequests,
	sync,
} from "./api";
import { BehaviorChart } from "./components/BehaviorChart";
import { BehaviorModelsTable } from "./components/BehaviorModelsTable";
import { BehaviorSummary } from "./components/BehaviorSummary";
import { ChartsContainer } from "./components/ChartsContainer";
import { CostChart } from "./components/CostChart";
import { CostSummary } from "./components/CostSummary";
import { Header } from "./components/Header";
import { ModelsTable } from "./components/ModelsTable";
import { RequestDetail } from "./components/RequestDetail";
import { RequestList } from "./components/RequestList";
import { StatsGrid } from "./components/StatsGrid";
import { useTranslation } from "./i18n";
import type {
	BehaviorDashboardStats,
	CostDashboardStats,
	MessageStats,
	ModelDashboardStats,
	OverviewStats,
	TimeRange,
} from "./types";

type Tab = "overview" | "requests" | "errors" | "models" | "costs" | "behavior";

export default function App() {
	const [overviewStats, setOverviewStats] = useState<OverviewStats | null>(null);
	const [modelStats, setModelStats] = useState<ModelDashboardStats | null>(null);
	const [costStats, setCostStats] = useState<CostDashboardStats | null>(null);
	const [behaviorStats, setBehaviorStats] = useState<BehaviorDashboardStats | null>(null);
	const [recentRequests, setRecentRequests] = useState<MessageStats[]>([]);
	const [recentErrors, setRecentErrors] = useState<MessageStats[]>([]);
	const [requestTotal, setRequestTotal] = useState(0);
	const [errorTotal, setErrorTotal] = useState(0);
	const [requestPage, setRequestPage] = useState(0);
	const [errorPage, setErrorPage] = useState(0);
	const [overviewRequestPage, setOverviewRequestPage] = useState(0);
	const [overviewErrorPage, setOverviewErrorPage] = useState(0);
	const [requestPageSize, setRequestPageSize] = useState(15);
	const [errorPageSize, setErrorPageSize] = useState(15);
	const OVERVIEW_PAGE_SIZE = 15;
	const [selectedRequest, setSelectedRequest] = useState<number | null>(null);
	const [syncing, setSyncing] = useState(false);
	const [activeTab, setActiveTab] = useState<Tab>("overview");
	const [timeRange, setTimeRange] = useState<TimeRange>("24h");
	const { t } = useTranslation();
	const [requestSeq, setRequestSeq] = useState(0);
	const [errorSeq, setErrorSeq] = useState(0);

	const loadRecentRequests = useCallback(async () => {
		const seq = requestSeq + 1;
		setRequestSeq(seq);
		try {
			const isOverview = activeTab === "overview";
			const page = isOverview ? overviewRequestPage : requestPage;
			const pageSize = isOverview ? OVERVIEW_PAGE_SIZE : requestPageSize;
			const res = await getRecentRequests(pageSize, page * pageSize);
			if (seq !== requestSeq + 1) return;
			setRecentRequests(res.data);
			setRequestTotal(res.total);
		} catch (err) {
			console.error(err);
		}
	}, [activeTab, requestPage, overviewRequestPage, requestPageSize, requestSeq]);

	const loadRecentErrors = useCallback(async () => {
		const seq = errorSeq + 1;
		setErrorSeq(seq);
		try {
			const isOverview = activeTab === "overview";
			const page = isOverview ? overviewErrorPage : errorPage;
			const pageSize = isOverview ? OVERVIEW_PAGE_SIZE : errorPageSize;
			const res = await getRecentErrors(pageSize, page * pageSize);
			if (seq !== errorSeq + 1) return;
			setRecentErrors(res.data);
			setErrorTotal(res.total);
		} catch (err) {
			console.error(err);
		}
	}, [activeTab, errorPage, overviewErrorPage, errorPageSize, errorSeq]);

	const loadRecentLists = useCallback(async () => {
		await Promise.all([loadRecentRequests(), loadRecentErrors()]);
	}, [loadRecentRequests, loadRecentErrors]);
	const loadActiveTabStats = useCallback(async () => {
		try {
			if (activeTab === "models") {
				setModelStats(await getModelDashboardStats(timeRange));
				return;
			}
			if (activeTab === "costs") {
				setCostStats(await getCostDashboardStats(timeRange));
				return;
			}
			if (activeTab === "behavior") {
				setBehaviorStats(await getBehaviorDashboardStats(timeRange));
				return;
			}
			if (activeTab === "overview") {
				setOverviewStats(await getOverviewStats(timeRange));
			}
		} catch (err) {
			console.error(err);
		}
	}, [activeTab, timeRange]);

	const handleSync = async () => {
		setSyncing(true);
		try {
			await sync();
			await Promise.all([loadActiveTabStats(), loadRecentLists()]);
		} finally {
			setSyncing(false);
		}
	};

	useEffect(() => {
		loadRecentRequests();
	}, [loadRecentRequests]);

	useEffect(() => {
		loadRecentErrors();
	}, [loadRecentErrors]);

	useEffect(() => {
		const interval = setInterval(() => {
			loadRecentRequests();
			loadRecentErrors();
		}, 30000);
		return () => clearInterval(interval);
	}, [loadRecentRequests, loadRecentErrors]);

	useEffect(() => {
		loadActiveTabStats();
		const interval = setInterval(loadActiveTabStats, 30000);
		return () => clearInterval(interval);
	}, [loadActiveTabStats]);

	return (
		<div className="min-h-screen">
			<div className="max-w-[1600px] mx-auto px-6 py-6">
				<Header
					activeTab={activeTab}
					onTabChange={setActiveTab}
					onSync={handleSync}
					syncing={syncing}
					timeRange={timeRange}
					onTimeRangeChange={setTimeRange}
				/>

				{activeTab === "overview" && (
					<div className="space-y-6 animate-fade-in">
						{overviewStats ? (
							<StatsGrid stats={overviewStats.overall} />
						) : (
							<LoadingState label={t("common.loading")} />
						)}

						<div className="grid lg:grid-cols-2 gap-6">
							<RequestList
								title={t("requestList.recentRequests")}
								requests={recentRequests}
								total={requestTotal}
								page={overviewRequestPage}
								pageSize={OVERVIEW_PAGE_SIZE}
								onPageChange={setOverviewRequestPage}
								onSelect={r => r.id && setSelectedRequest(r.id)}
								compact={true}
							/>
							<RequestList
								title={t("requestList.recentErrors")}
								requests={recentErrors}
								total={errorTotal}
								page={overviewErrorPage}
								pageSize={OVERVIEW_PAGE_SIZE}
								onPageChange={setOverviewErrorPage}
								onSelect={r => r.id && setSelectedRequest(r.id)}
								compact={true}
							/>
						</div>
					</div>
				)}

				{activeTab === "requests" && (
					<div className="h-[calc(100vh-140px)] animate-fade-in">
						<div className="mb-4 flex items-center gap-2">
							<span className="text-sm text-[var(--text-muted)]">{t("requestList.pageSize")}:</span>
							<select
								value={requestPageSize}
								onChange={e => { setRequestPageSize(Number(e.target.value)); setRequestPage(0); }}
								className="px-2 py-1 text-sm rounded bg-[var(--bg-elevated)] text-[var(--text-primary)] border border-[var(--border-subtle)]"
							>
								<option value={15}>15</option>
								<option value={30}>30</option>
								<option value={50}>50</option>
							</select>
						</div>
						<RequestList
							title={t("requestList.allRequests")}
							requests={recentRequests}
							total={requestTotal}
							page={requestPage}
							pageSize={requestPageSize}
							onPageChange={setRequestPage}
							onSelect={r => r.id && setSelectedRequest(r.id)}
						/>
					</div>
				)}

				{activeTab === "errors" && (
					<div className="h-[calc(100vh-140px)] animate-fade-in">
						<div className="mb-4 flex items-center gap-2">
							<span className="text-sm text-[var(--text-muted)]">{t("requestList.pageSize")}:</span>
							<select
								value={errorPageSize}
								onChange={e => { setErrorPageSize(Number(e.target.value)); setErrorPage(0); }}
								className="px-2 py-1 text-sm rounded bg-[var(--bg-elevated)] text-[var(--text-primary)] border border-[var(--border-subtle)]"
							>
								<option value={15}>15</option>
								<option value={30}>30</option>
								<option value={50}>50</option>
							</select>
						</div>
						<RequestList
							title={t("requestList.failedRequests")}
							requests={recentErrors}
							total={errorTotal}
							page={errorPage}
							pageSize={errorPageSize}
							onPageChange={setErrorPage}
							onSelect={r => r.id && setSelectedRequest(r.id)}
						/>
					</div>
				)}

				{activeTab === "models" && (
					<div className="space-y-6 animate-fade-in">
						{modelStats ? (
							<>
								<ChartsContainer modelSeries={modelStats.modelSeries} timeRange={timeRange} />
								<ModelsTable
									models={modelStats.byModel}
									performanceSeries={modelStats.modelPerformanceSeries}
									timeRange={timeRange}
								/>
							</>
						) : (
							<LoadingState label={t("common.loading")} />
						)}
					</div>
				)}

				{activeTab === "costs" && (
					<div className="space-y-6 animate-fade-in">
						{costStats ? (
							<>
								<CostSummary costSeries={costStats.costSeries} />
								<CostChart costSeries={costStats.costSeries} />
							</>
						) : (
							<LoadingState label={t("common.loading")} />
						)}
					</div>
				)}

				{activeTab === "behavior" && (
					<div className="space-y-6 animate-fade-in">
						{behaviorStats ? (
							<>
								<BehaviorSummary
									overall={behaviorStats.overall}
									behaviorSeries={behaviorStats.behaviorSeries}
								/>
								<BehaviorChart behaviorSeries={behaviorStats.behaviorSeries} />
								<BehaviorModelsTable
									models={behaviorStats.byModel}
									behaviorSeries={behaviorStats.behaviorSeries}
								/>
							</>
						) : (
							<LoadingState label={t("common.loading")} />
						)}
					</div>
				)}

				{selectedRequest !== null && (
					<RequestDetail id={selectedRequest} onClose={() => setSelectedRequest(null)} />
				)}
			</div>
		</div>
	);
}

function LoadingState({ label }: { label: string }) {
	return (
		<div className="min-h-[180px] flex items-center justify-center">
			<div className="flex items-center gap-3 text-[var(--text-muted)]">
				<div className="w-5 h-5 border-2 border-[var(--border-default)] border-t-[var(--accent-cyan)] rounded-full spin" />
				<span className="text-sm">{label}</span>
			</div>
		</div>
	);
}
