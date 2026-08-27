/** Stable, opaque 128-bit broker/OMP route token for a canonical durable id. */
export function engineRouteToken(id: string): string {
	return new Bun.CryptoHasher("sha256").update(id).digest("hex").slice(0, 32);
}

export function engineAgentId(agentInstanceId: string): string {
	return `Engine-${engineRouteToken(agentInstanceId)}`;
}
