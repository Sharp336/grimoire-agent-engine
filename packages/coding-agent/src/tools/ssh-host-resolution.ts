import type { SSHHost } from "../capability/ssh";
import { sshCapability } from "../capability/ssh";
import { loadCapability } from "../discovery";
import type { SSHConnectionTarget } from "../ssh/connection-manager";
import type { ToolSession } from ".";
import { ToolError } from "./tool-errors";

export interface LoadedSshHosts {
	hostNames: string[];
	hostsByName: Map<string, SSHHost>;
}

export async function loadSshHosts(session: Pick<ToolSession, "cwd">): Promise<LoadedSshHosts> {
	const result = await loadCapability<SSHHost>(sshCapability.id, { cwd: session.cwd });
	const hostsByName = new Map<string, SSHHost>();
	for (const host of result.items) {
		if (!hostsByName.has(host.name)) {
			hostsByName.set(host.name, host);
		}
	}
	return { hostNames: Array.from(hostsByName.keys()).sort(), hostsByName };
}

export function sshHostToConnectionTarget(host: SSHHost): SSHConnectionTarget {
	return {
		name: host.name,
		host: host.host,
		username: host.username,
		port: host.port,
		keyPath: host.keyPath,
		compat: host.compat,
	};
}

export async function resolveSshHostByName(
	session: Pick<ToolSession, "cwd">,
	hostName: string,
): Promise<SSHConnectionTarget> {
	const { hostNames, hostsByName } = await loadSshHosts(session);
	const host = hostsByName.get(hostName);
	if (!host) {
		const suffix =
			hostNames.length > 0 ? ` Available hosts: ${hostNames.join(", ")}` : " No SSH hosts are configured.";
		throw new ToolError(`Unknown SSH host: ${hostName}.${suffix}`);
	}
	return sshHostToConnectionTarget(host);
}
