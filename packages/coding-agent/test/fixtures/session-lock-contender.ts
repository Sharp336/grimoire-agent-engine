import { acquireSessionLock, SessionLockError } from "../../src/session/session-lock";

const [sessionFile, ownerId, nowText] = process.argv.slice(2);
if (!sessionFile || !ownerId || !nowText) throw new Error("expected session path, owner id, and timestamp");

const input = Bun.stdin.stream().getReader();
await input.read();

try {
	const lock = acquireSessionLock(sessionFile, {
		now: () => Number(nowText),
		ownerId,
		pid: process.pid,
		processStartMarker: `fixture:${process.pid}`,
		processProbe: {
			processStartMarker: pid => `fixture:${pid}`,
			isAlive: () => false,
		},
	});
	process.stdout.write(`${JSON.stringify({ status: "acquired", ownerId })}\n`);
	await input.read();
	lock.release();
} catch (error) {
	process.stdout.write(
		`${JSON.stringify({
			status: error instanceof SessionLockError ? "locked" : "error",
			ownerId,
			code: error instanceof SessionLockError ? error.code : undefined,
			message: error instanceof Error ? error.message : String(error),
		})}\n`,
	);
} finally {
	input.releaseLock();
}
