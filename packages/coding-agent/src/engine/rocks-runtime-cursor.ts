import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { EngineTargetError } from "./contracts";

const cursorKey = randomBytes(32);
export function encodeCursor(scope: unknown, value: unknown): string {
	const body = Buffer.from(JSON.stringify({ scope, value })).toString("base64url");
	return `${body}.${createHmac("sha256", cursorKey).update(body).digest("base64url")}`;
}
export function decodeCursor<T>(cursor: string | undefined, scope: unknown, initial: T): T {
	if (!cursor) return initial;
	try {
		const [body, mac, extra] = cursor.split(".");
		const signature = createHmac("sha256", cursorKey).update(body).digest("base64url");
		if (extra || mac?.length !== signature.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(signature)))
			throw new Error("signature");
		const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { scope: unknown; value: T };
		if (JSON.stringify(decoded.scope) !== JSON.stringify(scope)) throw new Error("scope");
		return decoded.value;
	} catch {
		throw new EngineTargetError("stale_target", "Read cursor changed scope or revision");
	}
}
