import { afterEach, describe, expect, it } from "bun:test";
import {
	buildCursorHeaders,
	CURSOR_DEFAULT_CLIENT_VERSION,
	resolveCursorClientVersion,
} from "@oh-my-pi/pi-ai/providers/cursor/headers";
import { CURSOR_DEFAULT_CLIENT_VERSION as CATALOG_DEFAULT } from "@oh-my-pi/pi-catalog/discovery/cursor";

const PINNED = "cli-2026.07.23-e383d2b";
const originalClientVersionEnv = Bun.env.CURSOR_CLIENT_VERSION;

afterEach(() => {
	if (originalClientVersionEnv === undefined) {
		delete Bun.env.CURSOR_CLIENT_VERSION;
	} else {
		Bun.env.CURSOR_CLIENT_VERSION = originalClientVersionEnv;
	}
});

describe("Cursor request identity headers", () => {
	it("shares one client-version default across catalog discovery and provider headers", () => {
		expect(CURSOR_DEFAULT_CLIENT_VERSION).toBe(CATALOG_DEFAULT);
		expect(CURSOR_DEFAULT_CLIENT_VERSION).toBe(PINNED);
	});

	it("resolves client version by option, then env, then the single default", () => {
		delete Bun.env.CURSOR_CLIENT_VERSION;
		expect(resolveCursorClientVersion(undefined)).toBe(PINNED);
		expect(resolveCursorClientVersion("cli-option-override")).toBe("cli-option-override");

		Bun.env.CURSOR_CLIENT_VERSION = "cli-env-override";
		expect(resolveCursorClientVersion(undefined)).toBe("cli-env-override");
		// Option still outranks a non-empty env override.
		expect(resolveCursorClientVersion("cli-option-override")).toBe("cli-option-override");

		Bun.env.CURSOR_CLIENT_VERSION = "";
		expect(resolveCursorClientVersion(undefined)).toBe(PINNED);
	});

	it("builds the protected identity fields with a stable original id and fresh request id", () => {
		const headers = buildCursorHeaders({
			apiKey: "secret-token",
			originalRequestId: "orig-1",
			requestId: "req-1",
		});
		expect(headers.authorization).toBe("Bearer secret-token");
		expect(headers["x-ghost-mode"]).toBe("true");
		expect(headers["x-cursor-client-type"]).toBe("cli");
		expect(headers["x-cursor-client-version"]).toBe(PINNED);
		expect(headers["x-original-request-id"]).toBe("orig-1");
		expect(headers["x-request-id"]).toBe("req-1");
		expect(headers["x-cursor-streaming"]).toBeUndefined();
	});

	it("omits the stream-only original request ID when discovery does not provide one", () => {
		const headers = buildCursorHeaders({ apiKey: "secret-token", requestId: "req-1" });
		expect(headers["x-original-request-id"]).toBeUndefined();
		expect(headers["x-request-id"]).toBe("req-1");
	});

	it("honors ghost mode and the HTTP/1 streaming marker", () => {
		const ghostOff = buildCursorHeaders({
			apiKey: "t",
			originalRequestId: "o",
			requestId: "r",
			ghostMode: false,
		});
		expect(ghostOff["x-ghost-mode"]).toBe("false");

		const http1 = buildCursorHeaders({
			apiKey: "t",
			originalRequestId: "o",
			requestId: "r",
			http1: true,
		});
		expect(http1["x-cursor-streaming"]).toBe("true");
	});
});
