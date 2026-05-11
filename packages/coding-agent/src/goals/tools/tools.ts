import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import type { Static } from "@sinclair/typebox";
import type { ToolSession } from "../../tools";
import { goalToolResponse } from "../response";
import type { GoalToolResponse } from "../types";
import createGoalDescription from "./create-goal.md" with { type: "text" };
import getGoalDescription from "./get-goal.md" with { type: "text" };
import { createGoalSchema, getGoalSchema, updateGoalSchema } from "./spec";
import updateGoalDescription from "./update-goal.md" with { type: "text" };

type CreateGoalParams = Static<typeof createGoalSchema>;
type UpdateGoalParams = Static<typeof updateGoalSchema>;

function missingGoalsRuntime(): AgentToolResult<GoalToolResponse> {
	return {
		content: [{ type: "text", text: "Goals are not available in this session." }],
		details: goalToolResponse(null, false),
	};
}

function formatResponse(response: GoalToolResponse): AgentToolResult<GoalToolResponse> {
	return {
		content: [{ type: "text", text: JSON.stringify(response) }],
		details: response,
	};
}

export class GetGoalTool implements AgentTool<typeof getGoalSchema, GoalToolResponse> {
	readonly name = "get_goal";
	readonly label = "Get Goal";
	readonly summary = "Get the current thread goal";
	readonly loadMode = "essential";
	readonly description = prompt.render(getGoalDescription);
	readonly parameters = getGoalSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(): Promise<AgentToolResult<GoalToolResponse>> {
		if (!this.session.goals) return missingGoalsRuntime();
		const goal = await this.session.goals.get();
		return formatResponse(goalToolResponse(goal, false));
	}
}

export class CreateGoalTool implements AgentTool<typeof createGoalSchema, GoalToolResponse> {
	readonly name = "create_goal";
	readonly label = "Create Goal";
	readonly summary = "Create a current thread goal";
	readonly loadMode = "essential";
	readonly description = prompt.render(createGoalDescription);
	readonly parameters = createGoalSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(_toolCallId: string, params: CreateGoalParams): Promise<AgentToolResult<GoalToolResponse>> {
		if (!this.session.goals) return missingGoalsRuntime();
		const goal = await this.session.goals.create({
			objective: params.objective,
			tokenBudget: params.tokenBudget,
		});
		return formatResponse(goalToolResponse(goal, false));
	}
}

export class UpdateGoalTool implements AgentTool<typeof updateGoalSchema, GoalToolResponse> {
	readonly name = "update_goal";
	readonly label = "Update Goal";
	readonly summary = "Mark the current thread goal complete";
	readonly loadMode = "essential";
	readonly description = prompt.render(updateGoalDescription);
	readonly parameters = updateGoalSchema;
	readonly strict = true;

	constructor(private readonly session: ToolSession) {}

	async execute(_toolCallId: string, params: UpdateGoalParams): Promise<AgentToolResult<GoalToolResponse>> {
		if (!this.session.goals) return missingGoalsRuntime();
		if (params.status !== "complete") {
			return {
				content: [{ type: "text", text: "Only status=complete is supported." }],
				details: goalToolResponse(await this.session.goals.get(), false),
			};
		}
		const goal = await this.session.goals.complete();
		return formatResponse(goalToolResponse(goal, true));
	}
}
