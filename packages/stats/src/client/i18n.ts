/**
 * Stats dashboard i18n (browser-side stub)
 * Simple passthrough implementation for build compatibility
 */

const translations: Record<string, string> = {
	// Requests
	"requests.title": "Recent Requests",
	"requests.subtitle": "Latest message processing details",
	"requests.column.model": "Model",
	"requests.column.time": "Time",
	"requests.column.tokens": "Tokens",
	"requests.column.inputOutput": "In/Out",
	"requests.column.cache": "Cache",
	"requests.column.tokensPerSec": "Tok/s",
	"requests.column.cost": "Cost",
	"requests.column.duration": "Duration",
	"requests.column.status": "Status",
	"requests.status.success": "Success",
	"requests.status.failed": "Failed",
	"requests.noRequests": "No requests found",

	// Errors
	"errors.title": "Recent Errors",
	"errors.subtitle": "Failed message processing attempts",
	"errors.column.model": "Model",
	"errors.column.time": "Time",
	"errors.column.errorMessage": "Error Message",
	"errors.column.tokens": "Tokens",
	"errors.column.cost": "Cost",
	"errors.status.failed": "Failed",
	"errors.unknownError": "Unknown error",
	"errors.noFailures": "No failures found",
};

export function useTranslation() {
	const locale = navigator.language || "en";

	const t = (key: string): string => {
		return translations[key] ?? key;
	};

	return { t, locale };
}
