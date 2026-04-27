import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type { PiCompatProfile } from "./types";

const PROFILES: PiCompatProfile[] = [
	{
		packageNames: ["@tmustier/pi-agent-teams"],
		expectedTier: 2,
		requiresCliShim: false,
		recommendedBridgeMode: "profile",
		env: {
			PI_TEAMS_ROOT_DIR: "{{agentDir}}/teams",
			PI_TEAMS_HOOKS_DIR: "{{agentDir}}/teams/_hooks",
		},
		notes: ["Uses Pi-compatible manifests and env-overridable team directories."],
	},
	{
		packageNames: ["pi-teams"],
		expectedTier: 3,
		requiresCliShim: true,
		warnsHardcodedPiHome: true,
		recommendedBridgeMode: "child-home",
		notes: ["Spawns pi and has legacy ~/.pi teams/tasks paths; prefer child-home before symlink mode."],
	},
	{
		packageNames: ["pi-messenger"],
		expectedTier: 3,
		requiresCliShim: true,
		warnsHardcodedPiHome: true,
		recommendedBridgeMode: "child-home",
		notes: ["Spawns pi workers and has install/config paths under .pi and ~/.pi/agent."],
	},
];

function expandProfileValue(value: string): string {
	return value.replaceAll("{{agentDir}}", getAgentDir()).replaceAll("{{teamsDir}}", path.join(getAgentDir(), "teams"));
}

export function getPiCompatProfiles(): readonly PiCompatProfile[] {
	return PROFILES;
}

export function findPiCompatProfile(packageName: string | undefined): PiCompatProfile | undefined {
	if (!packageName) return undefined;
	return PROFILES.find(profile => profile.packageNames.includes(packageName));
}

export function getPiCompatProfileEnv(packageName: string | undefined): Record<string, string> {
	const profile = findPiCompatProfile(packageName);
	if (!profile?.env) return {};
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(profile.env)) {
		env[key] = expandProfileValue(value);
	}
	return env;
}
