/**
 * @oh-my-pi/pi-gateway
 *
 * IM gateway for Oh My Pi — connects AI agents to messaging platforms.
 *
 * Architecture:
 *   [IM Platform] → [Channel] → [Gateway] → [Session Store] → [Agent Bridge]
 *
 * Channels supported: DingTalk (with Stream mode), Feishu, WeChat (planned).
 */

export { BaseChannel, ChannelRegistry, DingTalkChannel } from "./channels";
export { getConfigPath, getDataDir, getDingTalkConfig, getEnabledChannels, loadConfig } from "./config";
export { Gateway } from "./gateway";
export { SQLiteSessionStore } from "./session-store";
export type * from "./types";
