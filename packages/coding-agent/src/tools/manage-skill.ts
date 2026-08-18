import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { CaptureWriteRecord } from "../autolearn/capture-request";
import { CAPTURE_RESULT_DETAILS_KEY } from "../autolearn/capture-request";
import type { ProcedureDescriptor } from "../autolearn/catalog";
import {
	deleteManagedSkill,
	getManagedSkillsDir,
	readManagedSkillMetadata,
	sanitizeManagedDescription,
	sanitizeSkillName,
	writeManagedSkill,
} from "../autolearn/managed-skills";
import { isNameClaimedByAuthoredSkill } from "../extensibility/skills";
import manageSkillDescription from "../prompts/tools/manage-skill.md" with { type: "text" };
import type { ToolSession } from ".";

const manageSkillSchema = type({
	action: "'create' | 'update' | 'delete'",
	name: type("string").describe("kebab-case skill name"),
	"description?": type("string").describe(
		"one-line description of when to use the skill (required for create/update)",
	),
	"body?": type("string").describe("the SKILL.md body in markdown, no frontmatter (required for create/update)"),
	"scope?": type("'global' | 'project-tagged'"),
	"match?": type({
		"toolFamilies?": "string[]",
		"platforms?": "string[]",
		"triggers?": "string[]",
	}),
}).narrow(
	(p, ctx) =>
		p.action === "delete" ||
		(p.description !== undefined && p.body !== undefined) ||
		// Enforce the action/field contract at validation time rather than only in
		// execute. Kept as a cross-field narrow (not a discriminated union) so the
		// wire schema stays a single root object — strict structured-output mode and
		// the Anthropic tool-schema builder both require that.
		ctx.mustBe('used with both "description" and "body" for "create" and "update"'),
);

export type ManageSkillParams = typeof manageSkillSchema.infer;

/**
 * Direct create/update/delete of isolated managed skills. Gated behind
 * `autolearn.enabled`; backend-independent (the skill side is standalone).
 */
export class ManageSkillTool implements AgentTool<typeof manageSkillSchema> {
	readonly name = "manage_skill";
	readonly approval = "write" as const;
	readonly label = "Manage Skill";
	readonly description = manageSkillDescription;
	readonly parameters = manageSkillSchema;
	readonly strict = true;
	readonly loadMode = "essential" as const;
	readonly summary = "Create, update, or delete an isolated managed skill";

	constructor(
		private readonly refreshSkills?: () => Promise<void>,
		private readonly syncDescriptor?: (descriptor: ProcedureDescriptor) => Promise<void> | void,
		private readonly deleteDescriptor?: (name: string) => Promise<void> | void,
	) {}

	static createIf(session: ToolSession): ManageSkillTool | null {
		if (!session.settings.get("autolearn.enabled")) return null;
		// ToolSession exposes no descriptor-cache hook; the controller owns catalog sync.
		return new ManageSkillTool(session.refreshSkills);
	}

	async execute(
		_id: string,
		params: ManageSkillParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback,
		context?: AgentToolContext,
	): Promise<AgentToolResult> {
		if (params.action === "delete") {
			const name = sanitizeSkillName(params.name);
			await deleteManagedSkill(name);
			await this.refreshSkills?.();
			await this.deleteDescriptor?.(name);
			return {
				content: [{ type: "text", text: `Deleted managed skill "${params.name}".` }],
				details: { action: "delete", name: params.name },
			};
		}

		// Defensive narrowing: the schema refine already rejects create/update
		// without both fields, so this is unreachable for valid input — it only
		// proves the strings are present to `writeManagedSkill`'s typed contract.
		if (!params.description || !params.body) {
			throw new Error(`"${params.action}" requires both "description" and "body".`);
		}
		// A managed skill resolves below any authored skill of the same name
		// (authored always wins in discovery), so creating one under a name an
		// authored skill already claims writes a file that never surfaces. Refuse
		// up front rather than report a false "Created". `sanitizeSkillName`
		// normalizes to the on-disk name the discovery scan compares against.
		if (params.action === "create" && isNameClaimedByAuthoredSkill(sanitizeSkillName(params.name))) {
			return {
				content: [
					{
						type: "text",
						text: `Cannot create managed skill "${params.name}": an authored skill of that name already exists, and managed skills cannot override authored ones. Choose a different name.`,
					},
				],
				isError: true,
				details: { action: "create", name: params.name, shadowed: true },
			};
		}

		const name = sanitizeSkillName(params.name);
		const capture = context?.autolearnCapture;
		const modelMatch = params.match;
		const metadata =
			capture || params.scope !== undefined || modelMatch !== undefined
				? {
						scope: capture?.scope ?? params.scope,
						projectKey: capture ? capture.projectKey : undefined,
						projectLabel: capture ? capture.projectLabel : undefined,
						// `toolFamilies` is the catalog's COVERAGE key: the ranker matches a
						// failure family against it exactly.
						//
						// A RECOVERY capture holds a NAMED slot, and the runner accounts that
						// write against exactly that family — so the host list REPLACES the
						// model's. Unioning would let a capture holding slot `bash` also tag
						// itself `mcp:playwright`, making the procedure recallable for a
						// candidate the runner simultaneously reports as uncovered.
						//
						// A MANUAL capture (`/learn`) has one UNNAMED slot: the host claims no
						// family, makes no coverage assertion, and the manual prompt asks the
						// model to supply the families itself. Overriding there would silently
						// strip every recall key from a user-requested procedure. Same for an
						// ordinary non-capture call.
						toolFamilies: capture?.assignedFamily !== undefined ? capture.toolFamilies : modelMatch?.toolFamilies,
						platforms: capture?.platforms ?? modelMatch?.platforms,
						// `triggers` are symptom text, not a coverage key — they can only help
						// lexical ranking, never grant a family match — so the model's own
						// description of the failure it fixed is merged in on purpose.
						triggers: [...(capture?.triggers ?? []), ...(modelMatch?.triggers ?? [])],
					}
				: undefined;
		const { path: skillPath } = await writeManagedSkill({
			action: params.action,
			name,
			description: params.description,
			body: params.body,
			metadata,
		});
		await this.refreshSkills?.();
		if (this.syncDescriptor) {
			const persistedMetadata = await readManagedSkillMetadata(name);
			const descriptor: ProcedureDescriptor = {
				name,
				description: sanitizeManagedDescription(params.description),
				scope: persistedMetadata?.scope ?? "global",
				projectKey: persistedMetadata?.projectKey,
				projectLabel: persistedMetadata?.projectLabel,
				toolFamilies: persistedMetadata?.toolFamilies ?? [],
				platforms: persistedMetadata?.platforms ?? [],
				triggers: persistedMetadata?.triggers ?? [],
			};
			await this.syncDescriptor(descriptor);
		}
		const relativePath = path.relative(getManagedSkillsDir(), skillPath);
		const verb = params.action === "create" ? "Created" : "Updated";
		const details = {
			action: params.action,
			name: params.name,
			...(capture
				? {
						[CAPTURE_RESULT_DETAILS_KEY]: {
							action: params.action,
							name,
							family: capture.assignedFamily,
						} satisfies CaptureWriteRecord,
					}
				: {}),
		};
		return {
			content: [{ type: "text", text: `${verb} managed skill "${params.name}" (managed-skills/${relativePath}).` }],
			details,
		};
	}
}
