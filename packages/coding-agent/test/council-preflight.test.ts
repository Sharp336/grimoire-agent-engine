import { afterEach, beforeEach, describe, expect, it, type Mock, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import * as modelResolver from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { sha256CouncilContent } from "@oh-my-pi/pi-coding-agent/council/hash";
import * as instructions from "@oh-my-pi/pi-coding-agent/council/instructions";
import {
	COUNCIL_TASK_CHAR_LIMIT,
	CouncilDispatchError,
	type CouncilPreflightHost,
	preflightCouncilDispatch,
} from "@oh-my-pi/pi-coding-agent/council/preflight";
import * as publication from "@oh-my-pi/pi-coding-agent/council/publication";
import type { EffectiveSubagentPolicy } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import * as subagents from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as git from "@oh-my-pi/pi-coding-agent/utils/git";

const cwd = fs.realpathSync(process.cwd());
const plannerModel = {
	provider: "planner",
	id: "slow",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.High, Effort.Max] },
} as unknown as Model<Api>;
const memberModel = {
	provider: "review",
	id: "one",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.High] },
} as unknown as Model<Api>;
const otherMemberModel = {
	provider: "review",
	id: "two",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.High] },
} as unknown as Model<Api>;
const mainModel = {
	provider: "main",
	id: "active",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.High] },
} as unknown as Model<Api>;
const publicationTarget = {
	repoRoot: cwd,
	plansDirectory: `${cwd}/plans`,
	slug: "change-auth",
	relativePath: "plans/change-auth.md",
	absolutePath: `${cwd}/plans/change-auth.md`,
};
const instructionSnapshot = {
	repoRoot: cwd,
	contextFiles: [{ path: `${cwd}/AGENTS.md`, content: "rules", depth: 0 }],
	files: [{ path: `${cwd}/AGENTS.md`, sha256: sha256CouncilContent("rules") }],
	totalBytes: 5,
};

function settings(options?: {
	members?: Array<{ role: string; enabled: boolean }>;
	roles?: Record<string, string>;
	defaultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto";
}): Settings {
	return Settings.isolated({
		"council.members": options?.members ?? [{ role: "reviewer", enabled: true }],
		defaultThinkingLevel: options?.defaultThinkingLevel ?? "high",
		modelRoles: { reviewer: "review/one:high", slow: "planner/slow:max", ...options?.roles },
	});
}

function host(options?: {
	settings?: Settings;
	model?: Model<Api>;
	activeTools?: string[];
	apiKey?: string | undefined;
	cwd?: string;
}): CouncilPreflightHost {
	const effectiveSettings = options?.settings ?? settings();
	const apiKey = Object.hasOwn(options ?? {}, "apiKey") ? options?.apiKey : "test-key";
	const sourceCwd = options?.cwd ?? cwd;
	const toolSession = {
		cwd: sourceCwd,
		hasUI: true,
		settings: effectiveSettings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as ToolSession;
	return {
		toolSession,
		session: {
			model: Object.hasOwn(options ?? {}, "model") ? options?.model : mainModel,
			thinkingLevel: undefined,
			getActiveToolNames: () => options?.activeTools ?? ["read", "write"],
		},
		settings: effectiveSettings,
		modelRegistry: {
			getApiKey: mock(async () => apiKey),
		} as unknown as CouncilPreflightHost["modelRegistry"],
		sessionManager: { getCwd: () => sourceCwd, getSessionId: () => "session-1" },
	};
}
function isPlannerSelector(selector: string | undefined): boolean {
	return selector === "@slow" || selector?.startsWith("planner/") === true;
}

function resolved(selector: string): modelResolver.ResolveCliModelResult {
	const model = isPlannerSelector(selector) ? plannerModel : selector.includes("two") ? otherMemberModel : memberModel;
	return {
		model,
		selector: `${model.provider}/${model.id}`,
		thinkingLevel:
			selector === "@slow" || selector.endsWith(":max")
				? Effort.Max
				: selector.endsWith(":high")
					? Effort.High
					: selector.endsWith(":auto")
						? "auto"
						: undefined,
		warning: undefined,
		error: undefined,
	};
}
let modelResolverSpy: Mock<typeof modelResolver.resolveCliModel>;
let policySpy: Mock<typeof subagents.resolveEffectiveSubagentPolicy>;
let publicationSpy: Mock<typeof publication.resolveCouncilPublicationTarget>;
let instructionsSpy: Mock<typeof instructions.captureCouncilInstructionSnapshot>;

beforeEach(() => {
	modelResolverSpy = spyOn(modelResolver, "resolveCliModel").mockImplementation(options =>
		resolved(options.cliModel ?? ""),
	);
	spyOn(git.repo, "root").mockResolvedValue(cwd);
	publicationSpy = spyOn(publication, "resolveCouncilPublicationTarget").mockResolvedValue(publicationTarget);
	instructionsSpy = spyOn(instructions, "captureCouncilInstructionSnapshot").mockResolvedValue(instructionSnapshot);
	policySpy = spyOn(subagents, "resolveEffectiveSubagentPolicy").mockImplementation(
		async request =>
			({
				agentName: request.agent,
			}) as EffectiveSubagentPolicy,
	);
	spyOn(subagents, "runStructuredSubagent").mockRejectedValue(new Error("must not run"));
});

afterEach(() => {
	mock.restore();
});

async function expectBlocked(preflightHost: CouncilPreflightHost, message: string): Promise<CouncilDispatchError> {
	try {
		await preflightCouncilDispatch(preflightHost, "Change auth");
		expect.unreachable();
	} catch (error) {
		expect(error).toBeInstanceOf(CouncilDispatchError);
		expect((error as Error).message).toContain(message);
		expect((error as CouncilDispatchError).spending).toBeFalse();
		expect(subagents.runStructuredSubagent).toHaveBeenCalledTimes(0);
		return error as CouncilDispatchError;
	}
}

describe("council dispatch preflight", () => {
	it("blocks malformed configuration and an empty enabled roster without spending", async () => {
		await expectBlocked(host({ settings: Settings.isolated({ "council.members": "bad" }) }), "expected an array");

		await expectBlocked(
			host({ settings: settings({ members: [{ role: "reviewer", enabled: false }] }) }),
			"No enabled",
		);
	});
	it("blocks empty and whitespace-only tasks before resolving any model or publication surface", async () => {
		for (const task of ["", " \t\n "]) {
			await expect(preflightCouncilDispatch(host(), task)).rejects.toMatchObject({
				code: "COUNCIL_TASK_INVALID",
				spending: false,
			});
		}
		expect(modelResolver.resolveCliModel).not.toHaveBeenCalled();
		expect(publication.resolveCouncilPublicationTarget).not.toHaveBeenCalled();
		expect(subagents.resolveEffectiveSubagentPolicy).not.toHaveBeenCalled();
	});

	it("blocks an oversized task before resolving any model or publication surface", async () => {
		await expect(preflightCouncilDispatch(host(), "x".repeat(COUNCIL_TASK_CHAR_LIMIT + 1))).rejects.toMatchObject({
			code: "COUNCIL_TASK_INVALID",
			spending: false,
		});
		expect(modelResolver.resolveCliModel).not.toHaveBeenCalled();
		expect(publication.resolveCouncilPublicationTarget).not.toHaveBeenCalled();
		expect(subagents.resolveEffectiveSubagentPolicy).not.toHaveBeenCalled();
	});

	it("accepts a 64-character roster role and blocks a 65-character role before model resolution", async () => {
		const acceptedRole = `a${"1".repeat(63)}`;
		const rejectedRole = `a${"1".repeat(64)}`;
		const accepted = await preflightCouncilDispatch(
			host({
				settings: Settings.isolated({
					"council.members": [{ role: acceptedRole, enabled: true }],
					modelRoles: { [acceptedRole]: "review/one" },
				}),
			}),
			"Change auth",
		);
		expect(accepted.members[0]?.role).toBe(acceptedRole);

		modelResolverSpy.mockClear();
		await expectBlocked(
			host({
				settings: Settings.isolated({
					"council.members": [{ role: rejectedRole, enabled: true }],
					modelRoles: { [rejectedRole]: "review/one" },
				}),
			}),
			"must match /^[a-z][a-z0-9]{0,63}$/",
		);
		expect(modelResolverSpy).not.toHaveBeenCalled();
	});

	it("blocks missing, unavailable, and unauthenticated enabled member models", async () => {
		await expectBlocked(host({ settings: settings({ roles: { reviewer: "" } }) }), "reviewer");
		const absentBuiltIn = Settings.isolated({
			"council.members": [{ role: "slow", enabled: true }],
			modelRoles: {},
		});
		await expectBlocked(host({ settings: absentBuiltIn }), "slow has no configured model selector");
		expect(modelResolverSpy).not.toHaveBeenCalled();

		modelResolverSpy.mockImplementation(options =>
			options.cliModel?.startsWith("review/")
				? {
						model: undefined,
						selector: undefined,
						thinkingLevel: undefined,
						warning: undefined,
						error: "not found",
					}
				: resolved(options.cliModel ?? ""),
		);
		await expectBlocked(host(), "reviewer model is unavailable");

		modelResolverSpy.mockImplementation(options => resolved(options.cliModel ?? ""));
		await expectBlocked(host({ apiKey: undefined }), "reviewer model review/one has no usable credentials");
	});

	it("uses normal built-in resolution for the planner when slow is not configured", async () => {
		const noSlowPlanner = Settings.isolated({
			"council.members": [{ role: "reviewer", enabled: true }],
			modelRoles: { reviewer: "review/one:high" },
		});

		const plan = await preflightCouncilDispatch(host({ settings: noSlowPlanner }), "Change auth");

		expect(plan.planner).toMatchObject({
			requestedSelector: "@slow",
			model: plannerModel,
		});
	});

	it("ignores disabled members even when their selector is unavailable", async () => {
		const plan = await preflightCouncilDispatch(
			host({
				settings: settings({
					members: [
						{ role: "disabled", enabled: false },
						{ role: "reviewer", enabled: true },
					],
					roles: { disabled: "missing/model" },
				}),
			}),
			"Change auth",
		);

		expect(plan.members.map(member => member.role)).toEqual(["reviewer"]);
		expect(modelResolver.resolveCliModel).not.toHaveBeenCalledWith(
			expect.objectContaining({ cliModel: "missing/model" }),
		);
	});

	it("freezes child effort by selector, model default, global default, and concrete auto precedence", async () => {
		const effortModel = {
			...memberModel,
			id: "effort",
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		} as unknown as Model<Api>;
		const withModelDefault = {
			...effortModel,
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.Medium, Effort.High],
				defaultLevel: Effort.Medium,
			},
		} as unknown as Model<Api>;
		let selectedModel = withModelDefault;
		modelResolverSpy.mockImplementation(options => {
			const base = resolved(options.cliModel ?? "");
			return isPlannerSelector(options.cliModel) ? base : { ...base, model: selectedModel };
		});

		const explicit = await preflightCouncilDispatch(
			host({
				settings: settings({
					roles: { reviewer: "review/effort:max" },
					defaultThinkingLevel: "low",
				}),
			}),
			"Change auth",
		);
		expect(explicit.members[0]).toMatchObject({
			requestedSelector: "review/effort:max",
			resolvedSelector: "review/effort:high",
			effort: Effort.High,
		});

		const modelDefault = await preflightCouncilDispatch(
			host({
				settings: settings({
					roles: { reviewer: "review/effort" },
					defaultThinkingLevel: "low",
				}),
			}),
			"Change auth",
		);
		expect(modelDefault.members[0]).toMatchObject({
			resolvedSelector: "review/effort:medium",
			effort: Effort.Medium,
		});

		selectedModel = effortModel;
		const globalDefault = await preflightCouncilDispatch(
			host({
				settings: settings({
					roles: { reviewer: "review/effort" },
					defaultThinkingLevel: "low",
				}),
			}),
			"Change auth",
		);
		expect(globalDefault.members[0]).toMatchObject({
			resolvedSelector: "review/effort:low",
			effort: Effort.Low,
		});

		selectedModel = withModelDefault;
		const automatic = await preflightCouncilDispatch(
			host({ settings: settings({ roles: { reviewer: "review/effort:auto" } }) }),
			"Change auth",
		);
		expect(automatic.members[0]).toMatchObject({
			requestedSelector: "review/effort:auto",
			resolvedSelector: "review/effort:medium",
			effort: Effort.Medium,
		});
		expect(automatic.memberRequests[0]!.model).toBe("review/effort:medium");
	});

	it("blocks an unavailable or unauthenticated planner, absent Main model, and inactive write tool", async () => {
		modelResolverSpy.mockImplementation(options =>
			isPlannerSelector(options.cliModel)
				? {
						model: undefined,
						selector: undefined,
						thinkingLevel: undefined,
						warning: undefined,
						error: "not found",
					}
				: resolved(options.cliModel ?? ""),
		);
		await expectBlocked(host(), "slow model is unavailable");

		modelResolverSpy.mockImplementation(options => resolved(options.cliModel ?? ""));
		const unauthenticatedPlanner = host();
		unauthenticatedPlanner.modelRegistry.getApiKey = mock(async model =>
			model.provider === "planner" ? undefined : "test-key",
		);
		await expectBlocked(unauthenticatedPlanner, "slow model planner/slow has no usable credentials");
		await expectBlocked(host({ model: undefined }), "active Main model");
		const unauthenticatedMain = host();
		unauthenticatedMain.modelRegistry.getApiKey = mock(async model =>
			model.provider === "main" ? undefined : "test-key",
		);
		await expectBlocked(unauthenticatedMain, "Main model main/active has no usable credentials");
		await expectBlocked(host({ activeTools: ["read"] }), "write tool");
	});

	it("blocks tool-incapable members, planner, and Main before storage or child dispatch", async () => {
		const unsupportedMember = { ...memberModel, supportsTools: false } as Model<Api>;
		modelResolverSpy.mockImplementation(options => {
			const base = resolved(options.cliModel ?? "");
			return isPlannerSelector(options.cliModel) ? base : { ...base, model: unsupportedMember };
		});
		await expectBlocked(host(), "reviewer model review/one does not support tools");

		const unsupportedPlanner = { ...plannerModel, supportsTools: false } as Model<Api>;
		modelResolverSpy.mockImplementation(options => {
			const base = resolved(options.cliModel ?? "");
			return isPlannerSelector(options.cliModel) ? { ...base, model: unsupportedPlanner } : base;
		});
		await expectBlocked(host(), "slow model planner/slow does not support tools");

		modelResolverSpy.mockImplementation(options => resolved(options.cliModel ?? ""));
		await expectBlocked(
			host({ model: { ...mainModel, supportsTools: false } as Model<Api> }),
			"Main model main/active does not support tools",
		);
		expect(publication.resolveCouncilPublicationTarget).not.toHaveBeenCalled();
		expect(instructions.captureCouncilInstructionSnapshot).not.toHaveBeenCalled();
		expect(subagents.resolveEffectiveSubagentPolicy).not.toHaveBeenCalled();
	});

	it("blocks repository, publication, and instruction snapshot failures before model execution", async () => {
		const invalidRepository = host();
		invalidRepository.sessionManager = {
			getCwd: () => "/definitely/missing/council-repository",
			getSessionId: () => "session-1",
		};
		await expectBlocked(invalidRepository, "repository root is unusable");

		publicationSpy.mockRejectedValueOnce(new Error("target collision"));
		await expectBlocked(host(), "target collision");

		instructionsSpy.mockRejectedValueOnce(new Error("instruction escaped root"));
		await expectBlocked(host(), "instruction escaped root");
	});

	it("preflights planner and member final policies and propagates either blocker without spending", async () => {
		await preflightCouncilDispatch(host(), "Change auth");
		expect(subagents.resolveEffectiveSubagentPolicy).toHaveBeenCalledTimes(2);
		expect(subagents.resolveEffectiveSubagentPolicy).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ agent: "council-planner" }),
		);
		expect(subagents.resolveEffectiveSubagentPolicy).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ agent: "council-member" }),
		);

		policySpy.mockRejectedValueOnce(new Error("spawn denied"));
		await expectBlocked(host(), "spawn denied");
		policySpy.mockImplementation(async request => {
			if (request.agent === "council-member") throw new Error("member disabled");
			return { agentName: request.agent } as EffectiveSubagentPolicy;
		});
		await expectBlocked(host(), "member disabled");
	});

	it("revalidates a promised resume target without collision allocation", async () => {
		const promised = spyOn(publication, "resolvePromisedCouncilPublicationTarget").mockResolvedValue(
			publicationTarget,
		);

		const plan = await preflightCouncilDispatch(host(), "Change auth", {
			promisedOutputPath: publicationTarget.relativePath,
		});

		expect(promised).toHaveBeenCalledWith(cwd, publicationTarget.relativePath);
		expect(publication.resolveCouncilPublicationTarget).not.toHaveBeenCalled();
		expect(plan.publicationTarget).toEqual(publicationTarget);
	});

	it("pins every child cwd and instruction capture to the canonical root when the session starts nested", async () => {
		const repoRoot = fs.realpathSync(path.resolve(cwd, "../.."));
		const nestedHost = host({ cwd });
		spyOn(git.repo, "root").mockResolvedValueOnce(repoRoot);
		publicationSpy.mockResolvedValueOnce({
			...publicationTarget,
			repoRoot,
			plansDirectory: path.join(repoRoot, "plans"),
			absolutePath: path.join(repoRoot, "plans", "change-auth.md"),
		});
		instructionsSpy.mockResolvedValueOnce({ ...instructionSnapshot, repoRoot });

		const plan = await preflightCouncilDispatch(nestedHost, "Review sibling package behavior");

		expect(plan.cwd).toBe(cwd);
		expect(plan.repoRoot).toBe(repoRoot);
		expect([plan.plannerRequest, ...plan.memberRequests].every(request => request.cwd === repoRoot)).toBeTrue();
		expect(instructions.captureCouncilInstructionSnapshot).toHaveBeenCalledWith(nestedHost.toolSession, repoRoot);
	});

	it("snapshots publication, instructions, roster, duplicate warnings, and strict pinned requests", async () => {
		const duplicateSettings = settings({
			members: [
				{ role: "first", enabled: true },
				{ role: "second", enabled: true },
			],
			roles: { first: "main/active:high", second: "main/active:high" },
		});
		modelResolverSpy.mockImplementation(options => {
			if (isPlannerSelector(options.cliModel)) return resolved(options.cliModel ?? "");
			return { ...resolved(options.cliModel ?? ""), model: mainModel, selector: "main/active" };
		});

		const plan = await preflightCouncilDispatch(host({ settings: duplicateSettings }), "Change auth");

		expect(plan.repoRoot).toBe(cwd);
		expect(plan.publicationTarget.relativePath).toBe("plans/change-auth.md");
		expect(plan.instructions).toEqual(instructionSnapshot);
		expect(plan.instructions.files).toEqual([{ path: `${cwd}/AGENTS.md`, sha256: sha256CouncilContent("rules") }]);
		expect(plan.config.rounds).toBe(1);
		expect(plan.members.map(member => [member.role, member.order])).toEqual([
			["first", 0],
			["second", 1],
		]);
		expect(
			plan.members.map(member => [member.requestedSelector, member.resolvedSelector, member.effort, member.lens]),
		).toEqual([
			["main/active:high", "main/active:high", "high", expect.any(String)],
			["main/active:high", "main/active:high", "high", expect.any(String)],
		]);
		expect(plan.planner).toMatchObject({
			requestedSelector: "@slow",
			resolvedSelector: "planner/slow:max",
			effort: "max",
		});
		expect(plan.main).toMatchObject({ selector: "main/active", effort: undefined });
		expect(plan.warnings).toEqual([
			"Council roles first, second resolve to the same model main/active.",
			"Council roles first, second resolve to the Main model main/active.",
		]);
		const requests = [plan.plannerRequest, ...plan.memberRequests];
		for (const request of requests) {
			expect(request).toMatchObject({
				cwd,
				model: expect.any(String),
				pinModel: true,
				tools: ["read", "grep", "glob", "lsp", "ast_grep"],
				restrictToolNames: true,
				inheritContextFiles: true,
				additionalContextFiles: instructionSnapshot.contextFiles,
				skills: [],
				rules: [],
				autoloadSkills: [],
				enableIrc: false,
				schemaMode: "strict",
			});
			expect(request).not.toHaveProperty("modelOverride");
		}
		expect(subagents.runStructuredSubagent).toHaveBeenCalledTimes(0);
	});
});
