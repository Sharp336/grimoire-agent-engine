import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

interface RenderableBlock {
	render(width: number): string[];
}

function isRenderableBlock(value: unknown): value is RenderableBlock {
	return value !== null && typeof value === "object" && "render" in value && typeof value.render === "function";
}

function renderPresentedBlocks(value: unknown): string {
	const blocks = Array.isArray(value) ? value : [value];
	return blocks
		.filter(isRenderableBlock)
		.flatMap(block => block.render(120))
		.join("\n");
}

function createUsageSessionDouble() {
	return { getUsageReportingModelSelectors: () => [] };
}

describe("CommandController /usage", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("renders bars and free percentage for limits that only report remainingFraction", async () => {
		const present = vi.fn();
		const ctx = {
			session: createUsageSessionDouble(),
			ui: { terminal: { columns: 100 } },
			present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: 1_700_000_000_000,
				limits: [
					{
						id: "codex-weekly",
						label: "Weekly",
						scope: { provider: "openai-codex", tier: "pro", accountId: "acct-1" },
						window: { id: "weekly", label: "weekly" },
						amount: { remainingFraction: 0.25, unit: "requests" },
						status: "ok",
					},
				],
				metadata: { email: "user@example.com" },
			},
		];

		await controller.handleUsageCommand(reports);

		expect(present).toHaveBeenCalledTimes(1);
		const firstCall = present.mock.calls[0];
		expect(firstCall).toBeDefined();
		const output = renderPresentedBlocks(firstCall?.[0]);
		expect(output).toContain("25% free");
		expect(output).toContain("█");
		expect(output).not.toContain("··········");
	});

	it("renders Cursor request quotas in the /usage view", async () => {
		const present = vi.fn();
		const ctx = {
			session: createUsageSessionDouble(),
			ui: { terminal: { columns: 100 } },
			present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		const now = Date.now();
		const reports: UsageReport[] = [
			{
				provider: "cursor",
				fetchedAt: now,
				limits: [
					{
						id: "cursor:requests:gpt-4",
						label: "gpt-4 requests",
						scope: { provider: "cursor", windowId: "monthly" },
						window: { id: "monthly", label: "Monthly", resetsAt: now + 90_000_000 },
						amount: {
							unit: "requests",
							used: 150,
							limit: 500,
							remaining: 350,
							usedFraction: 0.3,
							remainingFraction: 0.7,
						},
						status: "ok",
					},
				],
				metadata: { email: "cursor@example.test" },
			},
		];

		await controller.handleUsageCommand(reports);

		expect(present).toHaveBeenCalledTimes(1);
		const firstCall = present.mock.calls[0];
		expect(firstCall).toBeDefined();
		const output = renderPresentedBlocks(firstCall?.[0]);
		expect(output).toContain("Cursor");
		expect(output).toContain("gpt-4 requests");
		expect(output).toContain("70% free");
		expect(output).toContain("resets in 1d");
	});

	it("renders saved reset expiry lines for future and expired credits", async () => {
		const present = vi.fn();
		const ctx = {
			session: createUsageSessionDouble(),
			ui: { terminal: { columns: 100 } },
			present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		const now = Date.now();
		const dayMs = 24 * 60 * 60 * 1000;
		const futureIso = new Date(now + 2 * dayMs).toISOString();
		const expiredIso = new Date(now - 2 * dayMs).toISOString();
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: now,
				limits: [],
				metadata: { email: "user@example.com" },
				resetCredits: {
					availableCount: 2,
					credits: [{ expiresAt: futureIso }, { expiresAt: expiredIso }],
				},
			},
		];

		await controller.handleUsageCommand(reports);

		expect(present).toHaveBeenCalledTimes(1);
		const firstCall = present.mock.calls[0];
		expect(firstCall).toBeDefined();
		const output = renderPresentedBlocks(firstCall?.[0]);
		expect(output).toContain("Saved rate-limit resets");
		expect(output).toContain("user@example.com: 2 saved resets");
		expect(output).toContain(`expires in`);
		expect(output).toContain(`(${futureIso.slice(0, 10)})`);
		expect(output).toContain(`expired (${expiredIso.slice(0, 10)})`);
	});

	it("renders single and multiple Devin used-only ACUs as summed totals, plus neighboring fallback acct count", async () => {
		const present = vi.fn();
		const ctx = {
			session: {},
			ui: { terminal: { columns: 100 } },
			present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		const now = Date.now();

		// 1. Single Devin account
		const reportsSingle: UsageReport[] = [
			{
				provider: "devin",
				fetchedAt: now,
				limits: [
					{
						id: "devin:acus:total",
						label: "Devin ACU consumption",
						scope: { provider: "devin", accountId: "acct-1" },
						amount: { unit: "acus", used: 12.5 },
						status: "ok",
					},
					{
						id: "devin:acus:product:devin",
						label: "Devin product ACU consumption",
						scope: { provider: "devin", accountId: "acct-1", tier: "devin" },
						amount: { unit: "acus", used: 8 },
						status: "ok",
					},
				],
				metadata: { email: "devin-a@example.com", accountId: "acct-1" },
			},
		];
		await controller.handleUsageCommand(reportsSingle);
		expect(present).toHaveBeenCalledTimes(1);
		let output = renderPresentedBlocks(present.mock.calls[0]?.[0]);
		expect(output).toContain("12.5 ACU used");
		expect(output).toContain("8 ACU used");
		expect(output).not.toContain("20.5 ACU used");
		present.mockClear();

		// 2. Multiple Devin accounts plus neighboring fallback case
		const reportsMultiple: UsageReport[] = [
			{
				provider: "devin",
				fetchedAt: now,
				limits: [
					{
						id: "devin:acus:total",
						label: "Devin ACU consumption",
						scope: { provider: "devin", accountId: "acct-1" },
						amount: { unit: "acus", used: 12.5 },
						status: "ok",
					},
				],
				metadata: { email: "devin-a@example.com", accountId: "acct-1" },
			},
			{
				provider: "devin",
				fetchedAt: now,
				limits: [
					{
						id: "devin:acus:total",
						label: "Devin ACU consumption",
						scope: { provider: "devin", accountId: "acct-2" },
						amount: { unit: "acus", used: 3.0 },
						status: "ok",
					},
				],
				metadata: { email: "devin-b@example.com", accountId: "acct-2" },
			},
			{
				provider: "mock-fallback",
				fetchedAt: now,
				limits: [
					{
						id: "mock:fallback:limit",
						label: "Mock Quota",
						scope: { provider: "mock-fallback", accountId: "acct-3" },
						amount: { unit: "requests" },
						status: "ok",
					},
				],
				metadata: { email: "fallback-a@example.com", accountId: "acct-3" },
			},
			{
				provider: "mock-fallback",
				fetchedAt: now,
				limits: [
					{
						id: "mock:fallback:limit",
						label: "Mock Quota",
						scope: { provider: "mock-fallback", accountId: "acct-4" },
						amount: { unit: "requests" },
						status: "ok",
					},
				],
				metadata: { email: "fallback-b@example.com", accountId: "acct-4" },
			},
		];

		await controller.handleUsageCommand(reportsMultiple);
		expect(present).toHaveBeenCalledTimes(1);
		output = renderPresentedBlocks(present.mock.calls[0]?.[0]);

		// Assert Devin total sum is formatted as "15.5 ACU used" instead of falling back to "2 accts"
		expect(output).toContain("15.5 ACU used");

		// Assert fallback provider falls back to "2 accts" since it has no amount values
		expect(output).toContain("2 accts");
	});
});
