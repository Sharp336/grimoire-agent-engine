/**
 * Regression: the fullscreen transcript viewer must align the header, body, and
 * footer on a single shared gutter. The transcript components carry their own
 * 1-column left pad, so the viewer must NOT add a second outer gutter to body
 * rows — doing so shifted the content one column right of the "Agent Hub" title
 * (the reported "first char off / title shift"). Scrolling must also move the
 * visible window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentTranscriptViewer } from "@oh-my-pi/pi-coding-agent/modes/components/agent-transcript-viewer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { Component } from "@oh-my-pi/pi-tui";

const TS = new Date().toISOString();

function buildJsonl(): string {
	const usage = {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	const lines = [
		JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "adv", timestamp: TS, cwd: "/tmp" }),
	];
	lines.push(
		JSON.stringify({
			type: "message",
			id: "u0",
			parentId: null,
			timestamp: TS,
			message: { role: "user", synthetic: true, attribution: "agent", content: "PROMPTMARKER", timestamp: 0 },
		}),
	);
	for (let i = 0; i < 40; i++) {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `a${i}`,
				parentId: null,
				timestamp: TS,
				message: {
					role: "assistant",
					content: [{ type: "text", text: `Reviewing step ${i}.` }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "gpt-5.5",
					usage,
					stopReason: "stop",
					timestamp: i,
				},
			}),
		);
	}
	return `${lines.join("\n")}\n`;
}

function buildCustomJsonl(count: number): string {
	const lines = [
		JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "adv", timestamp: TS, cwd: "/tmp" }),
	];
	for (let i = 0; i < count; i++) {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `c${i}`,
				parentId: null,
				timestamp: TS,
				message: {
					role: "custom",
					customType: "counting",
					content: `custom-${i}`,
					display: true,
					details: { index: i },
					timestamp: i,
				},
			}),
		);
	}
	return `${lines.join("\n")}\n`;
}

function buildLabeledJsonl(labels: readonly string[]): string {
	const lines = [
		JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: "adv", timestamp: TS, cwd: "/tmp" }),
	];
	for (let i = 0; i < labels.length; i++) {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `l${i}`,
				parentId: null,
				timestamp: TS,
				message: {
					role: "custom",
					customType: "counting",
					content: labels[i],
					display: true,
					details: { index: i },
					timestamp: i,
				},
			}),
		);
	}
	return `${lines.join("\n")}\n`;
}

function modelChangeJsonl(model: string): string {
	return `${JSON.stringify({
		type: "model_change",
		id: `model-${model}`,
		parentId: null,
		timestamp: TS,
		model,
	})}\n`;
}

function labeledMessageJsonl(id: string, index: number, label: string): string {
	return `${JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: TS,
		message: {
			role: "custom",
			customType: "counting",
			content: label,
			display: true,
			details: { index },
			timestamp: index,
		},
	})}\n`;
}

async function appendFixture(file: string, content: string): Promise<void> {
	await Bun.write(file, `${await Bun.file(file).text()}${content}`);
}

class CountingMessageComponent implements Component {
	renderCount = 0;
	constructor(
		readonly label: string,
		readonly rows = 1,
	) {}
	invalidate(): void {}
	render(width: number): readonly string[] {
		this.renderCount++;
		return Array.from({ length: this.rows }, (_v, i) => `${this.label}-row-${i}`.slice(0, width));
	}
}

function makeViewer(
	file: string,
	getMessageRenderer?: ConstructorParameters<typeof AgentTranscriptViewer>[0]["getMessageRenderer"],
	requestRender: () => void = () => {},
) {
	const agents = new AgentRegistry();
	agents.register({
		id: "Main/advisor",
		displayName: "advisor",
		kind: "advisor",
		parentId: "Main",
		session: null,
		sessionFile: file,
		status: "parked",
	});
	return new AgentTranscriptViewer({
		agentId: "Main/advisor",
		registry: agents,
		ui: { requestRender: () => {}, requestComponentRender: () => {} } as never,
		getMessageRenderer,
		cwd: "/tmp",
		expandKeys: ["ctrl+o"],
		hubKeys: ["ctrl+s"],
		onClose: () => {},
		onHubClose: () => {},
		requestRender,
	});
}

/** Leading-space count of a stripped line (its content gutter). */
function gutter(line: string): number {
	const stripped = Bun.stripANSI(line);
	return stripped.length - stripped.trimStart().length;
}

function withViewer(fn: (viewer: AgentTranscriptViewer) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-view-"));
	const file = path.join(dir, "__advisor.jsonl");
	fs.writeFileSync(file, buildJsonl());
	try {
		fn(makeViewer(file));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe("AgentTranscriptViewer", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		initTheme();
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("aligns the title and body content on the same gutter", () => {
		withViewer(viewer => {
			viewer.render(80); // populate the scroll view before navigating
			viewer.handleInput("g"); // scroll to top so the first message is visible
			const lines = viewer.render(80).map(l => Bun.stripANSI(l));
			const titleLine = lines.find(l => l.includes("Agent Hub"));
			const bodyLine = lines.find(l => l.includes("PROMPTMARKER"));
			expect(titleLine).toBeDefined();
			expect(bodyLine).toBeDefined();
			// The body must not sit one column right of the title.
			expect(gutter(bodyLine!)).toBe(gutter(titleLine!));
		});
	});

	it("scrolls the visible window with j/k and g/G", () => {
		withViewer(viewer => {
			const atBottom = viewer
				.render(80)
				.map(l => Bun.stripANSI(l))
				.join("\n");
			viewer.handleInput("g");
			const atTop = viewer
				.render(80)
				.map(l => Bun.stripANSI(l))
				.join("\n");
			expect(atTop).not.toEqual(atBottom);
			expect(atTop).toContain("PROMPTMARKER");
			expect(atBottom).not.toContain("PROMPTMARKER");
		});
	});

	it("renders only the follow-bottom viewport instead of the whole transcript", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "adv-view-"));
		const file = path.join(dir, "__advisor.jsonl");
		await Bun.write(file, buildCustomJsonl(160));
		const components = Array.from({ length: 160 }, (_v, i) => new CountingMessageComponent(`custom-${i}`));
		const viewer = makeViewer(file, customType => {
			if (customType !== "counting") return undefined;
			return message => {
				const details = message.details as { index?: number } | undefined;
				const index = details?.index;
				return typeof index === "number" ? components[index] : undefined;
			};
		});
		try {
			viewer.render(80);
			expect(components.slice(0, 120).every(component => component.renderCount === 0)).toBe(true);
			expect(components.at(-1)!.renderCount).toBeGreaterThan(0);
		} finally {
			viewer.dispose();
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("scrolls one row up from a tail-rendered multiline transcript", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "adv-view-"));
		const file = path.join(dir, "__advisor.jsonl");
		await Bun.write(file, buildCustomJsonl(30));
		const components = Array.from({ length: 30 }, (_v, i) => new CountingMessageComponent(`custom-${i}`, 5));
		const viewer = makeViewer(file, customType => {
			if (customType !== "counting") return undefined;
			return message => {
				const details = message.details as { index?: number } | undefined;
				const index = details?.index;
				return typeof index === "number" ? components[index] : undefined;
			};
		});
		try {
			const bottom = viewer
				.render(80)
				.map(l => Bun.stripANSI(l))
				.join("\n");
			viewer.handleInput("k");
			const oneRowUp = viewer
				.render(80)
				.map(l => Bun.stripANSI(l))
				.join("\n");
			expect(oneRowUp).not.toEqual(bottom);
			expect(oneRowUp).toContain("custom-29");
		} finally {
			viewer.dispose();
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("pages up one viewport from a tail-rendered multiline transcript", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "adv-view-"));
		const file = path.join(dir, "__advisor.jsonl");
		await Bun.write(file, buildCustomJsonl(30));
		const components = Array.from({ length: 30 }, (_v, i) => new CountingMessageComponent(`custom-${i}`, 5));
		const viewer = makeViewer(file, customType => {
			if (customType !== "counting") return undefined;
			return message => {
				const details = message.details as { index?: number } | undefined;
				const index = details?.index;
				return typeof index === "number" ? components[index] : undefined;
			};
		});
		try {
			viewer.render(80);
			viewer.handleInput("\x1b[5~");
			const pageUp = viewer
				.render(80)
				.map(l => Bun.stripANSI(l))
				.join("\n");
			expect(pageUp).toContain("custom-24");
			expect(pageUp).not.toContain("custom-29");
		} finally {
			viewer.dispose();
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("rebuilds when a transcript rewrite grows the file", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "adv-view-"));
		const file = path.join(dir, "__advisor.jsonl");
		await Bun.write(file, buildLabeledJsonl(["old-short"]));
		const viewer = makeViewer(file, customType => {
			if (customType !== "counting") return undefined;
			return message => new CountingMessageComponent(String(message.content));
		});
		try {
			expect(
				viewer
					.render(80)
					.map(l => Bun.stripANSI(l))
					.join("\n"),
			).toContain("old-short");
			await Bun.write(file, buildLabeledJsonl(["new-longer-content-that-replaces-old", "new-tail"]));
			const deadline = Date.now() + 5000;
			let body = "";
			while (Date.now() < deadline) {
				await Bun.sleep(25);
				body = viewer
					.render(80)
					.map(l => Bun.stripANSI(l))
					.join("\n");
				if (body.includes("new-longer-content-that-replaces-old")) break;
			}
			expect(body).toContain("new-longer-content-that-replaces-old");
			expect(body).not.toContain("old-short");
		} finally {
			viewer.dispose();
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("rebuilds after append sentinels grow beyond the initial short transcript", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "adv-view-"));
		const file = path.join(dir, "__advisor.jsonl");
		const initial = buildLabeledJsonl(["edge"]);
		await Bun.write(file, initial);
		const viewer = makeViewer(file, customType => {
			if (customType !== "counting") return undefined;
			return message => new CountingMessageComponent(String(message.content));
		});
		try {
			await appendFixture(file, labeledMessageJsonl("stale", 1, "stale-after-append"));
			let body = "";
			const appendDeadline = Date.now() + 5000;
			while (Date.now() < appendDeadline) {
				await Bun.sleep(25);
				body = viewer
					.render(80)
					.map(l => Bun.stripANSI(l))
					.join("\n");
				if (body.includes("stale-after-append")) break;
			}
			expect(body).toContain("stale-after-append");

			await Bun.write(
				file,
				`${initial}${labeledMessageJsonl("replacement", 2, "replacement-after-rewrite")}${initial}`,
			);
			const rewriteDeadline = Date.now() + 5000;
			while (Date.now() < rewriteDeadline) {
				await Bun.sleep(25);
				body = viewer
					.render(80)
					.map(l => Bun.stripANSI(l))
					.join("\n");
				if (body.includes("replacement-after-rewrite")) break;
			}
			expect(body).toContain("replacement-after-rewrite");
			expect(body).not.toContain("stale-after-append");
		} finally {
			viewer.dispose();
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("keeps partial transcript lines until their newline is written", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "adv-view-"));
		const file = path.join(dir, "__advisor.jsonl");
		const complete = buildLabeledJsonl(["complete"]);
		const next = JSON.stringify({
			type: "message",
			id: "partial",
			parentId: null,
			timestamp: TS,
			message: {
				role: "custom",
				customType: "counting",
				content: "completed-partial",
				display: true,
				details: { index: 0 },
				timestamp: 1,
			},
		});
		await Bun.write(file, `${complete}${next.slice(0, Math.floor(next.length / 2))}`);
		const viewer = makeViewer(file, customType => {
			if (customType !== "counting") return undefined;
			return message => new CountingMessageComponent(String(message.content));
		});
		try {
			expect(
				viewer
					.render(80)
					.map(l => Bun.stripANSI(l))
					.join("\n"),
			).toContain("complete");
			await appendFixture(file, `${next.slice(Math.floor(next.length / 2))}\n`);
			const deadline = Date.now() + 5000;
			let body = "";
			while (Date.now() < deadline) {
				await Bun.sleep(25);
				body = viewer
					.render(80)
					.map(l => Bun.stripANSI(l))
					.join("\n");
				if (body.includes("completed-partial")) break;
			}
			expect(body).toContain("completed-partial");
		} finally {
			viewer.dispose();
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("repaints the header after a metadata-only model change append", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "adv-view-"));
		const file = path.join(dir, "__advisor.jsonl");
		await Bun.write(file, buildLabeledJsonl([]));
		let renders = 0;
		const viewer = makeViewer(file, undefined, () => {
			renders++;
		});
		renders = 0;
		try {
			await appendFixture(file, modelChangeJsonl("anthropic/claude-sonnet-4-5"));
			const deadline = Date.now() + 5000;
			while (renders === 0 && Date.now() < deadline) {
				await Bun.sleep(25);
			}
			expect(renders).toBeGreaterThan(0);
			expect(
				viewer
					.render(80)
					.map(l => Bun.stripANSI(l))
					.join("\n"),
			).toContain("anthropic/claude-sonnet-4-5");
		} finally {
			viewer.dispose();
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("tails appended transcript entries without rebuilding old rows", async () => {
		const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "adv-view-"));
		const file = path.join(dir, "__advisor.jsonl");
		await Bun.write(file, buildCustomJsonl(10));
		const rendererCalls = Array.from({ length: 11 }, () => 0);
		let renders = 0;
		const viewer = makeViewer(
			file,
			customType => {
				if (customType !== "counting") return undefined;
				return message => {
					const details = message.details as { index?: number } | undefined;
					const index = details?.index;
					if (typeof index !== "number") return undefined;
					rendererCalls[index]++;
					return new CountingMessageComponent(`custom-${index}`);
				};
			},
			() => {
				renders++;
			},
		);
		try {
			expect(rendererCalls.slice(0, 10).every(count => count === 1)).toBe(true);
			const appended = JSON.stringify({
				type: "message",
				id: "c10",
				parentId: null,
				timestamp: TS,
				message: {
					role: "custom",
					customType: "counting",
					content: "custom-10",
					display: true,
					details: { index: 10 },
					timestamp: 10,
				},
			});
			await appendFixture(file, `${appended}\n`);
			const deadline = Date.now() + 5000;
			while (rendererCalls[10] === 0 && Date.now() < deadline) {
				await Bun.sleep(25);
			}
			expect(rendererCalls[10]).toBe(1);
			expect(rendererCalls.slice(0, 10).every(count => count === 1)).toBe(true);
			expect(renders).toBeGreaterThan(0);
		} finally {
			viewer.dispose();
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	it("clears stale content when the transcript file is deleted while open", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adv-view-"));
		const file = path.join(dir, "__advisor.jsonl");
		fs.writeFileSync(file, buildJsonl());
		const viewer = makeViewer(file);
		const body = () =>
			viewer
				.render(80)
				.map(l => Bun.stripANSI(l))
				.join("\n");
		try {
			viewer.render(80);
			viewer.handleInput("g");
			expect(body()).toContain("PROMPTMARKER");

			fs.rmSync(file);
			// Poll until the viewer's own poll timer re-stats and clears (deadline-bounded).
			const deadline = Date.now() + 5000;
			while (body().includes("PROMPTMARKER") && Date.now() < deadline) {
				await Bun.sleep(50);
			}
			expect(body()).not.toContain("PROMPTMARKER");
		} finally {
			viewer.dispose();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
