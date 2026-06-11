import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { zhHans } from "./translations";

export default function zhHansLocale(pi: ExtensionAPI): void {
	pi.setLabel("Simplified Chinese UI Locale");
	pi.registerLocale("zh-Hans", zhHans);
}
