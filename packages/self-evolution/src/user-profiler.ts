/**
 * UserProfiler: incremental user behavioral profiling.
 */
import type { SessionTrace, UserProfile } from "./types";

function getFileExtension(path: string): string | undefined {
	const match = path.match(/\.([a-zA-Z0-9]+)$/);
	return match ? match[1].toLowerCase() : undefined;
}

function extensionToLanguage(ext: string): string | undefined {
	const map: Record<string, string> = {
		ts: "typescript",
		tsx: "typescript",
		js: "javascript",
		jsx: "javascript",
		rs: "rust",
		py: "python",
		go: "go",
		java: "java",
		kotlin: "kotlin",
		swift: "swift",
		cpp: "cpp",
		cc: "cpp",
		cxx: "cpp",
		h: "cpp",
		hpp: "cpp",
		c: "c",
		cs: "csharp",
		rb: "ruby",
		php: "php",
		scala: "scala",
		r: "r",
		sh: "shell",
		bash: "shell",
		zsh: "shell",
		md: "markdown",
		yml: "yaml",
		yaml: "yaml",
		json: "json",
		toml: "toml",
	};
	return map[ext];
}

export class UserProfiler {
	#profile: UserProfile;

	constructor(profile?: UserProfile) {
		this.#profile = profile ?? this.#makeDefaultProfile();
	}

	getProfile(): UserProfile {
		return { ...this.#profile };
	}

	updateProfile(trace: SessionTrace, intent: string): void {
		this.#profile.sessionCount++;
		this.#profile.updatedAt = Date.now();

		// Tool frequency
		const toolCalls = trace.entries.filter(e => e.type === "tool_call" && e.toolName);
		for (const entry of toolCalls) {
			const tool = entry.toolName!;
			this.#profile.toolFrequency[tool] = (this.#profile.toolFrequency[tool] ?? 0) + 1;
		}

		// Tool transitions
		const toolNames = toolCalls.map(e => e.toolName!);
		for (let i = 0; i < toolNames.length - 1; i++) {
			const transition = `${toolNames[i]}→${toolNames[i + 1]}`;
			this.#profile.toolTransitions[transition] = (this.#profile.toolTransitions[transition] ?? 0) + 1;
		}

		// Intent distribution
		this.#profile.intentDistribution[intent] = (this.#profile.intentDistribution[intent] ?? 0) + 1;

		// Averages
		const prevCount = this.#profile.sessionCount - 1;
		this.#profile.avgToolCallsPerSession =
			(this.#profile.avgToolCallsPerSession * prevCount + trace.toolCallCount) / this.#profile.sessionCount;

		const filesModified = new Set<string>();
		for (const entry of toolCalls) {
			if (["write", "edit", "ast_edit"].includes(entry.toolName!)) {
				const p = (entry.args as Record<string, unknown>)?.path;
				if (typeof p === "string") filesModified.add(p);
			}
		}
		this.#profile.avgFilesModifiedPerSession =
			(this.#profile.avgFilesModifiedPerSession * prevCount + filesModified.size) / this.#profile.sessionCount;

		// Error rate
		const totalErrors = this.#profile.errorRate * prevCount + (trace.errorCount > 0 ? 1 : 0);
		this.#profile.errorRate = totalErrors / this.#profile.sessionCount;

		// Recovery rate
		const totalRecoveries = this.#profile.recoveryRate * prevCount + (trace.hadRecovery ? 1 : 0);
		this.#profile.recoveryRate = totalRecoveries / this.#profile.sessionCount;

		// Preferred languages
		for (const file of filesModified) {
			const ext = getFileExtension(file);
			if (ext) {
				const lang = extensionToLanguage(ext);
				if (lang && !this.#profile.preferredLanguages.includes(lang)) {
					this.#profile.preferredLanguages.push(lang);
				}
			}
		}
	}

	serialize(): string {
		return JSON.stringify(this.#profile);
	}

	static deserialize(json: string): UserProfiler {
		const profile = JSON.parse(json) as UserProfile;
		return new UserProfiler(profile);
	}

	#makeDefaultProfile(): UserProfile {
		return {
			toolFrequency: {},
			toolTransitions: {},
			intentDistribution: {},
			avgToolCallsPerSession: 0,
			avgFilesModifiedPerSession: 0,
			errorRate: 0,
			recoveryRate: 0,
			preferredLanguages: [],
			sessionCount: 0,
			updatedAt: Date.now(),
		};
	}
}
