export function sha256CouncilContent(content: string | Uint8Array): string {
	return Bun.SHA256.hash(content, "hex");
}
