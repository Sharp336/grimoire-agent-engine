import { bin, name, version } from "../package.json" with { type: "json" };

export const UPSTREAM_PACKAGE_NAME = "@oh-my-pi/pi-coding-agent";
export const MOMP_PACKAGE_NAME = "@mikeei/momp";

export interface UpdateNotificationDetails {
	sourceLabel?: string;
	actionText?: string;
}

export function isMompPackageName(packageName: string): boolean {
	return packageName === MOMP_PACKAGE_NAME;
}

export function comparableVersionForUpstreamCheck(packageName: string, currentVersion: string): string {
	if (!isMompPackageName(packageName)) {
		return currentVersion;
	}
	return currentVersion.split("-", 1)[0] ?? currentVersion;
}

export function isUpstreamVersionNewer(
	latestVersion: string,
	currentVersion: string,
	packageName: string = APP_PACKAGE_NAME,
): boolean {
	return Bun.semver.order(latestVersion, comparableVersionForUpstreamCheck(packageName, currentVersion)) > 0;
}

export function updateNotificationDetails(packageName: string = APP_PACKAGE_NAME): UpdateNotificationDetails {
	if (isMompPackageName(packageName)) {
		return { sourceLabel: "upstream", actionText: "Rebase momp from upstream." };
	}
	return { actionText: "Run: omp update" };
}

export const APP_PACKAGE_NAME: string = name;
export const APP_VERSION: string = version;
export const APP_DISPLAY_NAME: string = Object.keys(bin)[0] ?? "omp";
