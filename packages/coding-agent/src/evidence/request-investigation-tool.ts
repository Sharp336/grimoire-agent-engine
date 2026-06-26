import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@oh-my-pi/pi-agent-core";
import { type } from "arktype";
import requestInvestigationDescription from "../prompts/advisor/request-investigation-tool.md" with { type: "text" };
import type { EvidenceBroker } from "./broker";
import type { InvestigationMode, InvestigationRisk, InvestigationStatus } from "./types";

const requestInvestigationSchema = type({
	question: type("string").describe("The concrete factual or empirical question to answer."),
	objective: type("string").describe("Why this could change the advisor's guidance to the main agent."),
	mode: type("'docs' | 'web' | 'source' | 'code_experiment' | 'reproduction' | 'compatibility' | 'benchmark' | 'browser_probe'").describe("The investigation lane."),
	risk: type("'background' | 'could_change_direction' | 'potential_blocker'").describe("How much the answer could affect the current work."),
	"constraints?": type("string[]").describe("Concrete limits for the worker, such as package version, URL, command, or platform."),
});

export type RequestInvestigationParams = typeof requestInvestigationSchema.infer;

export interface RequestInvestigationDetails {
	id: string;
	status: InvestigationStatus;
	mode: InvestigationMode;
	risk: InvestigationRisk;
}

export class RequestInvestigationTool implements AgentTool<typeof requestInvestigationSchema, RequestInvestigationDetails> {
	readonly name = "request_investigation";
	readonly label = "Request Investigation";
	readonly description = requestInvestigationDescription;
	readonly parameters = requestInvestigationSchema;
	readonly intent = "omit" as const;

	constructor(private readonly broker: EvidenceBroker) {}

	async execute(
		_toolCallId: string,
		args: RequestInvestigationParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<RequestInvestigationDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<RequestInvestigationDetails>> {
		try {
			const input = args.constraints
				? { question: args.question, objective: args.objective, mode: args.mode, risk: args.risk, constraints: args.constraints }
				: { question: args.question, objective: args.objective, mode: args.mode, risk: args.risk };
			const record = await this.broker.request(input);
			return {
				content: [
					{
						type: "text",
						text: `Queued investigation ${record.id}. Continue reviewing; a later update will surface the artifact if it changes your guidance.`,
					},
				],
				details: { id: record.id, status: record.status, mode: record.mode, risk: record.risk },
				useless: true,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				content: [{ type: "text", text: message }],
				isError: true,
			};
		}
	}
}
