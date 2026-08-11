export const CONTRIBUTION_REMINDER = "Something broken? Ask your agent to fix it and submit a PR.";

export function appendContributionReminder(content: string): string {
	const trimmedContent = content.trim();
	if (trimmedContent.endsWith(CONTRIBUTION_REMINDER)) {
		return trimmedContent;
	}
	return `${trimmedContent}\n\n${CONTRIBUTION_REMINDER}`;
}
