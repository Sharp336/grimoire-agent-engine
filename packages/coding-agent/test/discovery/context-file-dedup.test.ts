import { describe, expect, test } from "bun:test";
import { type ContextFile, contextFileCapability } from "@oh-my-pi/pi-coding-agent/capability/context-file";

function makeContextFile(overrides: Partial<ContextFile> & Pick<ContextFile, "path" | "level">): ContextFile {
	return {
		content: `content of ${overrides.path}`,
		depth: undefined,
		_source: { provider: "test", providerName: "Test", path: overrides.path, level: overrides.level },
		...overrides,
	};
}

describe("contextFileCapability.key", () => {
	const key = contextFileCapability.key.bind(contextFileCapability);

	test("user-level files share the same key regardless of depth", () => {
		const a = makeContextFile({ path: "/home/user/.omp/agent/AGENTS.md", level: "user" });
		const b = makeContextFile({ path: "/home/user/.claude/CLAUDE.md", level: "user" });
		expect(key(a)).toBe("user");
		expect(key(b)).toBe("user");
		expect(key(a)).toBe(key(b));
	});

	test("project-level files at the same depth share the same key", () => {
		const a = makeContextFile({ path: "/repo/AGENTS.md", level: "project", depth: 0 });
		const b = makeContextFile({ path: "/repo/.claude/CLAUDE.md", level: "project", depth: 0 });
		expect(key(a)).toBe(key(b));
	});

	// Standalone CLAUDE.md (#2612) is the one filename with its own dedup slot, and only
	// when the `agents-md` walk found it. Everything else keeps the shared one-per-scope slot.
	test("standalone CLAUDE.md does not collide with a same-depth AGENTS.md", () => {
		const agents = makeContextFile({
			path: "/repo/AGENTS.md",
			level: "project",
			depth: 0,
			_source: { provider: "agents-md", providerName: "AGENTS.md", path: "/repo/AGENTS.md", level: "project" },
		});
		const claude = makeContextFile({
			path: "/repo/CLAUDE.md",
			level: "project",
			depth: 0,
			_source: { provider: "agents-md", providerName: "AGENTS.md", path: "/repo/CLAUDE.md", level: "project" },
		});
		expect(key(agents)).not.toBe(key(claude));
	});

	test("config-directory CLAUDE.md still shares the scope slot", () => {
		const claudeProvider = makeContextFile({
			path: "/repo/.claude/CLAUDE.md",
			level: "project",
			depth: 0,
			_source: {
				provider: "claude",
				providerName: "Claude Code",
				path: "/repo/.claude/CLAUDE.md",
				level: "project",
			},
		});
		const copilot = makeContextFile({
			path: "/repo/.github/copilot-instructions.md",
			level: "project",
			depth: 0,
			_source: {
				provider: "github",
				providerName: "GitHub",
				path: "/repo/.github/copilot-instructions.md",
				level: "project",
			},
		});
		expect(key(claudeProvider)).toBe(key(copilot));
	});

	test("standalone CLAUDE.md keys still differ across depths", () => {
		const source = (p: string) => ({
			provider: "agents-md",
			providerName: "AGENTS.md",
			path: p,
			level: "project" as const,
		});
		const atCwd = makeContextFile({
			path: "/repo/packages/app/CLAUDE.md",
			level: "project",
			depth: 0,
			_source: source("/repo/packages/app/CLAUDE.md"),
		});
		const atRoot = makeContextFile({
			path: "/repo/CLAUDE.md",
			level: "project",
			depth: 2,
			_source: source("/repo/CLAUDE.md"),
		});
		expect(key(atCwd)).not.toBe(key(atRoot));
	});

	test("project-level files at different depths have different keys", () => {
		const atCwd = makeContextFile({ path: "/repo/packages/app/AGENTS.md", level: "project", depth: 0 });
		const atParent = makeContextFile({ path: "/repo/packages/AGENTS.md", level: "project", depth: 1 });
		const atRoot = makeContextFile({ path: "/repo/AGENTS.md", level: "project", depth: 2 });

		expect(key(atCwd)).not.toBe(key(atParent));
		expect(key(atParent)).not.toBe(key(atRoot));
		expect(key(atCwd)).not.toBe(key(atRoot));
	});

	test("project-level file with no depth uses 0 as default", () => {
		const withDepth = makeContextFile({ path: "/repo/AGENTS.md", level: "project", depth: 0 });
		const noDepth = makeContextFile({ path: "/repo/AGENTS.md", level: "project" });
		expect(key(withDepth)).toBe(key(noDepth));
	});

	test("user key never collides with any project key", () => {
		const user = makeContextFile({ path: "/home/user/.omp/AGENTS.md", level: "user" });
		for (let depth = 0; depth < 20; depth++) {
			const project = makeContextFile({ path: `/repo/AGENTS.md`, level: "project", depth });
			expect(key(user)).not.toBe(key(project));
		}
	});
});

describe("contextFileCapability.validate", () => {
	test("accepts valid context file", () => {
		const file = makeContextFile({ path: "/repo/AGENTS.md", level: "project", depth: 0 });
		expect(contextFileCapability.validate!(file)).toBeUndefined();
	});

	test("rejects missing path", () => {
		const file = makeContextFile({ path: "", level: "project" });
		expect(contextFileCapability.validate!(file)).toBe("Missing path");
	});
});
