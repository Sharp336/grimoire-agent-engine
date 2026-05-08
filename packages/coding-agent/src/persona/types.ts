export interface UserPersona {
	version: string;
	updatedAt: number;

	basics: {
		gender?: string;
		birthday?: string;
		zodiac?: string;
		mbti?: string;
		lifeStage?: string;
		location?: string;
		pace?: string;
		languageStyle?: string;
	};

	career: {
		industry?: string;
		role?: string;
		dailyWork?: string;
		expertise?: string[];
		lifeGoal?: string;
		thinkingPattern?: string;
	};

	interests: {
		longTerm: string[];
		shortTerm: string[];
		avoid: string[];
		priorities: string[];
	};

	preferences: {
		contentType?: string;
		communicationStyle?: string;
		outputFormat?: string;
		contentStyle?: string;
		tolerance?: string;
		hobbies?: string[];
	};

	interaction: {
		commonCommands?: string[];
		replyStyle?: string;
		proactive?: boolean;
		errorHandling?: string;
	};

	thinking: {
		workStyle?: string;
		choicePreference?: string;
		logicHabit?: string;
		riskAppetite?: string;
	};

	constraints: {
		forbidden: string[];
		formatRules?: string;
		memoryRules?: string;
		accuracyRules?: string;
	};
}

export function createEmptyPersona(): UserPersona {
	return {
		version: "1.0",
		updatedAt: Date.now(),
		basics: {},
		career: {},
		interests: { longTerm: [], shortTerm: [], avoid: [], priorities: [] },
		preferences: {},
		interaction: {},
		thinking: {},
		constraints: { forbidden: [] },
	};
}
