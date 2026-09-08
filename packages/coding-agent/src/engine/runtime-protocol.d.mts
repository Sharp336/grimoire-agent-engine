export const runtimeProtocol: { $defs: Record<string, unknown>; 'x-artel': { version: string; contractRevision: number; limits: Record<string, number>; controlActions: string[]; methods: Record<string, string>; nativeMethods: Record<string, { request: string; response: string }>; rules: Record<string, string> } };
export const runtimeLimits: Record<string, number>;
export class RuntimeProtocolError extends Error { code: string; retryable: boolean; admission: string; constructor(code: string, message: string, admission?: string); }
export function canonicalRuntimeJson(value: unknown): string;
export function validateRuntimeValue<T>(name: string, value: T): T;
export function runtimeCommandHash(command: unknown): Promise<string>;
export function runtimeProjectionHash(scope: unknown): Promise<string>;
export function validateRuntimeChannelScope<T>(channel: unknown, scope: T): T;
