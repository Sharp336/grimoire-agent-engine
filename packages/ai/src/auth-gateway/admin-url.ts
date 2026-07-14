export const AUTH_GATEWAY_TRANSPORT_ERROR =
	"Remote auth-gateway connections must use https:// (plain http:// is allowed only for localhost)";

function loopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
	return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function normalizeAuthGatewayAdminUrl(value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value.trim());
	} catch {
		throw new Error(`Invalid auth-gateway admin URL: ${value}`);
	}

	if (parsed.username || parsed.password) {
		throw new Error("Auth-gateway admin URL must not include credentials");
	}
	if (parsed.search) {
		throw new Error("Auth-gateway admin URL must not include a query string");
	}
	if (parsed.hash) {
		throw new Error("Auth-gateway admin URL must not include a fragment");
	}
	if (parsed.protocol === "http:") {
		if (!loopbackHostname(parsed.hostname)) throw new Error(AUTH_GATEWAY_TRANSPORT_ERROR);
	} else if (parsed.protocol !== "https:") {
		throw new Error("Auth-gateway admin URL must use http:// or https://");
	}

	let pathname = parsed.pathname.replace(/\/+$/g, "");
	if (pathname === "") pathname = "/";
	parsed.pathname = pathname;
	parsed.search = "";
	parsed.hash = "";
	const serialized = parsed.toString();
	return serialized.endsWith("/") && parsed.pathname === "/" ? serialized.slice(0, -1) : serialized;
}
