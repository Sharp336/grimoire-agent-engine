import { spyOn } from "bun:test";
import type { DesktopSession } from "@oh-my-pi/pi-natives";
import * as desktop from "@oh-my-pi/pi-natives/desktop";

spyOn(desktop, "createDesktopSession").mockImplementation(
	() =>
		({
			capabilities: {},
			close: async () => {},
		}) as DesktopSession,
);

type IpcSend = (message: unknown, ...args: unknown[]) => boolean;
const ipcProcess = process as NodeJS.Process & { send?: IpcSend };
const optionalSend = ipcProcess.send;
if (!optionalSend) throw new Error("Expected IPC process.send");
const send: IpcSend = optionalSend.bind(process);
spyOn(ipcProcess as NodeJS.Process & { send: IpcSend }, "send").mockImplementation((message, ...args) => {
	if (
		message !== null &&
		typeof message === "object" &&
		"type" in message &&
		message.type === "tool-call" &&
		"args" in message &&
		typeof message.args === "object" &&
		message.args !== null &&
		"bad" in message.args
	) {
		throw new DOMException("The object could not be cloned", "DataCloneError");
	}
	return send(message, ...args);
});
