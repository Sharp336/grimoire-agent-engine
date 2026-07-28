import type { SecretHandle } from "../broker/types";

/**
 * Wire protocol for the sidecar broker — JSON lines over a Unix domain socket.
 * One request per line, one response per line. IDs correlate request/response.
 */

export type SidecarRequest =
 | { id: number; op: "ping" }
 | { id: number; op: "run_with_secret"; handle: SecretHandle; command: string; args: string[]; envKey: string; timeoutMs?: number }
 | { id: number; op: "register_handle"; handle: SecretHandle }
 | { id: number; op: "resolve_for_redaction"; handle: SecretHandle; token: string }
 | { id: number; op: "set_credential"; key: string; value: string; token: string }
 | { id: number; op: "get_credential_present"; key: string; token: string }
 | { id: number; op: "create_lease"; handle: SecretHandle; ttlMs: number }
 | { id: number; op: "revoke_lease"; leaseId: string }
 | { id: number; op: "run_with_lease"; leaseId: string; command: string; args: string[]; envKey: string; timeoutMs?: number };

export type SidecarResponse =
 | { id: number; ok: true; result: unknown }
 | { id: number; ok: false; error: string };

export function encodeRequest(req: SidecarRequest): string {
 return JSON.stringify(req) + "\n";
}

export function encodeResponse(res: SidecarResponse): string {
 return JSON.stringify(res) + "\n";
}

export function parseLine<T>(line: string): T | undefined {
 const trimmed = line.trim();
 if (trimmed.length === 0) return undefined;
 try {
  return JSON.parse(trimmed) as T;
 } catch {
  return undefined;
 }
}
