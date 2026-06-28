import {
	Activity,
	AlertCircle,
	Coins,
	Cpu,
	Folder,
	HeartPulse,
	LayoutDashboard,
	Smile,
	TrendingUp,
} from "lucide-react";
import type React from "react";

export type DashboardSection =
	| "overview"
	| "requests"
	| "errors"
	| "models"
	| "costs"
	| "behavior"
	| "health"
	| "projects"
	| "gain";

export interface DashboardRoute {
	id: DashboardSection;
	label: string;
	shortLabel?: string;
	icon: React.ComponentType<{ size?: number; className?: string }>;
}

export const routes: DashboardRoute[] = [
	{
		id: "overview",
		label: "Overview",
		icon: LayoutDashboard,
	},
	{
		id: "requests",
		label: "Requests",
		icon: Activity,
	},
	{
		id: "errors",
		label: "Errors",
		icon: AlertCircle,
	},
	{
		id: "models",
		label: "Models",
		icon: Cpu,
	},
	{
		id: "costs",
		label: "Costs",
		icon: Coins,
	},
	{
		id: "behavior",
		label: "Behavior",
		shortLabel: "Behavior",
		icon: Smile,
	},
	{
		id: "health",
		label: "Health",
		icon: HeartPulse,
	},
	{
		id: "projects",
		label: "Projects",
		icon: Folder,
	},
	{
		id: "gain",
		label: "Gain",
		icon: TrendingUp,
	},
];
