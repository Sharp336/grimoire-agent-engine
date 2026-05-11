import { Type } from "@sinclair/typebox";

export const createGoalSchema = Type.Object({
	objective: Type.String({ description: "Concrete objective requested by the user or developer." }),
	tokenBudget: Type.Optional(Type.Integer({ description: "Optional positive token budget for this goal." })),
});

export const getGoalSchema = Type.Object({});

export const updateGoalSchema = Type.Object({
	status: Type.Literal("complete", { description: "Only complete is accepted; other transitions are system-owned." }),
});
