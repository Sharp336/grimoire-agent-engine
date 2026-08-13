import { useCallback, useRef, useState } from "react";
import { AppLayout } from "./app/AppLayout";
import type { DashboardSection } from "./app/routes";
import { useHashRoute } from "./data/useHashRoute";
import {
	BehaviorRoute,
	CostsRoute,
	ErrorsRoute,
	GainRoute,
	ModelsRoute,
	OverviewRoute,
	ProjectsRoute,
	ProvidersRoute,
	RequestsRoute,
	RunsRoute,
	SessionsRoute,
	ToolsRoute,
} from "./routes";
import { RequestDrawer } from "./ui/RequestDrawer";

export default function App() {
	const { section, id, tab, status, project, failure, q, setSection, range, setRange, openDetail, setTab } =
		useHashRoute();
	const [refreshTrigger, setRefreshTrigger] = useState(0);
	const [selectedRequestId, setSelectedRequestId] = useState<number | null>(null);
	const [updatedAt, setUpdatedAt] = useState<number | null>(() => Date.now());

	const handleSyncComplete = useCallback((result: { success: boolean }) => {
		if (result.success) {
			setRefreshTrigger(prev => prev + 1);
			setUpdatedAt(Date.now());
		}
	}, []);

	const closeDrawer = useCallback(() => setSelectedRequestId(null), []);
	const active = section;
	const rangeDisabled = Boolean(id) && (section === "sessions" || section === "runs");

	const mountedRef = useRef<Set<DashboardSection>>(new Set());
	mountedRef.current.add(active);

	const renderRoute = (target: DashboardSection) => {
		const isActive = target === active;
		switch (target) {
			case "overview":
				return (
					<OverviewRoute
						active={isActive}
						range={range}
						refreshTrigger={refreshTrigger}
						onRequestClick={setSelectedRequestId}
					/>
				);
			case "sessions":
				return (
					<SessionsRoute
						active={isActive}
						id={isActive ? id : null}
						tab={isActive ? tab : null}
						range={range}
						status={status}
						project={project}
						failure={failure}
						q={q}
						refreshTrigger={refreshTrigger}
						onOpen={nextId => openDetail("sessions", nextId)}
						onTab={setTab}
						onRequestClick={setSelectedRequestId}
					/>
				);
			case "runs":
				return (
					<RunsRoute
						active={isActive}
						id={isActive ? id : null}
						tab={isActive ? tab : null}
						range={range}
						status={status}
						project={project}
						failure={failure}
						q={q}
						refreshTrigger={refreshTrigger}
						onOpen={nextId => openDetail("runs", nextId)}
						onTab={setTab}
						onRequestClick={setSelectedRequestId}
					/>
				);
			case "requests":
				return (
					<RequestsRoute
						active={isActive}
						range={range}
						refreshTrigger={refreshTrigger}
						onRequestClick={setSelectedRequestId}
					/>
				);
			case "errors":
				return (
					<ErrorsRoute
						active={isActive}
						range={range}
						refreshTrigger={refreshTrigger}
						onRequestClick={setSelectedRequestId}
					/>
				);
			case "models":
				return <ModelsRoute active={isActive} range={range} refreshTrigger={refreshTrigger} />;
			case "providers":
				return <ProvidersRoute active={isActive} range={range} refreshTrigger={refreshTrigger} />;
			case "tools":
				return <ToolsRoute active={isActive} range={range} refreshTrigger={refreshTrigger} />;
			case "costs":
				return <CostsRoute active={isActive} range={range} refreshTrigger={refreshTrigger} />;
			case "behavior":
				return <BehaviorRoute active={isActive} range={range} refreshTrigger={refreshTrigger} />;
			case "projects":
				return <ProjectsRoute active={isActive} range={range} refreshTrigger={refreshTrigger} />;
			case "gain":
				return <GainRoute active={isActive} range={range} refreshTrigger={refreshTrigger} />;
		}
	};

	return (
		<>
			<AppLayout
				activeSection={active}
				onSectionChange={setSection}
				range={range}
				onRangeChange={setRange}
				rangeDisabled={rangeDisabled}
				updatedAt={updatedAt}
				onSyncComplete={handleSyncComplete}
			>
				{[...mountedRef.current].map(target => (
					<div key={target} hidden={target !== active}>
						{renderRoute(target)}
					</div>
				))}
			</AppLayout>

			<RequestDrawer id={selectedRequestId} onClose={closeDrawer} />
		</>
	);
}
