/**
 * Core types for the IM Gateway.
 *
 * The gateway sits between messaging platforms (DingTalk, Feishu, WeChat)
 * and the OMP agent, routing messages bidirectionally.
 */

// ═══════════════════════════════════════════════════════════════════════
// Message Types
// ═══════════════════════════════════════════════════════════════════════

export type MessageContent =
	| { type: "text"; text: string }
	| { type: "markdown"; markdown: string }
	| { type: "image"; url: string; filename?: string }
	| { type: "file"; url: string; filename: string; size?: number }
	| { type: "voice"; url: string; duration?: number; text?: string };

export interface InboundMessage {
	channelId: string;
	userId: string;
	userName?: string;
	conversationId: string;
	conversationTitle?: string;
	isGroup: boolean;
	content: MessageContent;
	timestamp: Date;
	raw?: unknown;
}

export interface OutboundMessage {
	channelId: string;
	conversationId: string;
	content: MessageContent;
	replyTo?: string;
	mentions?: string[];
	/** If set, update an existing message instead of creating new one */
	messageId?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// Channel Interface
// ═══════════════════════════════════════════════════════════════════════

export interface ChannelCapabilities {
	inbound: boolean;
	outbound: boolean;
	richContent: boolean;
	groups: boolean;
	mentions: boolean;
	voice: boolean;
}

export interface ChannelConfig {
	enabled: boolean;
	allowedUsers?: string[];
	allowedGroups?: string[];
	[key: string]: unknown;
}

export interface Channel {
	readonly id: string;
	readonly name: string;
	readonly capabilities: ChannelCapabilities;

	connect(config: ChannelConfig): Promise<void>;
	disconnect(): Promise<void>;
	isConnected(): boolean;

	onMessage(handler: (msg: InboundMessage) => Promise<void>): void;
	sendMessage(msg: OutboundMessage): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════
// Session Types
// ═══════════════════════════════════════════════════════════════════════

export interface SessionRecord {
	id: string;
	channelId: string;
	userId: string;
	conversationId: string;
	createdAt: number;
	updatedAt: number;
	lastMessageId?: string;
	ompSessionPath?: string;
	status: "active" | "idle" | "closed";
}

export interface SessionStore {
	getSession(channelId: string, conversationId: string): Promise<SessionRecord | null>;
	createSession(session: Omit<SessionRecord, "id">): Promise<SessionRecord>;
	updateSession(id: string, updates: Partial<SessionRecord>): Promise<void>;
	closeSession(id: string): Promise<void>;
	getActiveSessions(channelId?: string): Promise<SessionRecord[]>;
}

// ═══════════════════════════════════════════════════════════════════════
// Gateway Config
// ═══════════════════════════════════════════════════════════════════════

export interface AgentConfig {
	ompPath?: string;
	model?: string;
	maxConcurrentSessions?: number;
}

export interface SessionConfig {
	idleTimeoutMinutes?: number;
	resetPolicy?: "none" | "daily" | "idle";
	dailyResetHour?: number;
}

export interface GatewayConfig {
	channels: Record<string, ChannelConfig>;
	agent?: AgentConfig;
	session?: SessionConfig;
	dataDir?: string;
}

// ═══════════════════════════════════════════════════════════════════════
// DingTalk Specific
// ═══════════════════════════════════════════════════════════════════════

export interface DingTalkConfig extends ChannelConfig {
	appKey: string;
	appSecret: string;
	robotCode?: string;
}

export interface DingTalkRawMessage {
	conversationId: string;
	atUsers: Array<{ dingtalkId: string; staffId?: string }>;
	chatbotCorpId: string;
	chatbotUserId: string;
	msgId: string;
	senderNick: string;
	isAdmin: boolean;
	senderStaffId: string;
	sessionWebhookExpiredTime: number;
	createAt: number;
	senderCorpId: string;
	conversationType: "1" | "2";
	senderId: string;
	conversationTitle: string;
	isInAtList: boolean;
	sessionWebhook: string;
	text?: { content: string };
	content?: string;
	msgtype: string;
	robotCode: string;
}
