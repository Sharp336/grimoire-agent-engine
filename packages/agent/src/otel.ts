/**
 * OpenTelemetry helpers for the agent loop.
 *
 * Opt-in via `AgentLoopConfig.experimental.openTelemetry`. When the flag is
 * unset, every helper short-circuits and the agent loop performs zero tracer
 * lookups. When the flag is set but no OTEL SDK is registered in the host
 * process, `@opentelemetry/api` returns a no-op tracer — span calls are safe
 * and cheap but produce no output.
 *
 * Span naming and attributes follow the OpenTelemetry GenAI semantic
 * conventions (https://opentelemetry.io/docs/specs/semconv/gen-ai/).
 */
import { type Attributes, type Span, SpanStatusCode, type Tracer, trace } from "@opentelemetry/api";

const TRACER_NAME = "@oh-my-pi/pi-agent-core";

let cachedTracer: Tracer | undefined;

function getTracer(): Tracer {
	if (!cachedTracer) {
		cachedTracer = trace.getTracer(TRACER_NAME);
	}
	return cachedTracer;
}

/**
 * Start a span only when the experimental flag is set. Returns `undefined`
 * otherwise so callers can pass the result straight back into the matching
 * helpers without a branch.
 */
export function startSpan(enabled: boolean | undefined, name: string, attributes?: Attributes): Span | undefined {
	if (!enabled) return undefined;
	return getTracer().startSpan(name, attributes ? { attributes } : undefined);
}

/**
 * End a span. If `error` is provided, the span is marked as ERROR with the
 * error message and (when it's an Error instance) an exception recorded.
 */
export function endSpan(span: Span | undefined, error?: unknown): void {
	if (!span) return;
	if (error !== undefined) {
		const message = error instanceof Error ? error.message : String(error);
		span.setStatus({ code: SpanStatusCode.ERROR, message });
		if (error instanceof Error) {
			span.recordException(error);
		}
	}
	span.end();
}

export function setSpanAttributes(span: Span | undefined, attributes: Attributes): void {
	if (!span) return;
	span.setAttributes(attributes);
}

/** Mark a span as ERROR without ending it — useful when the caller needs to
 * attach further attributes before closing. */
export function markSpanError(span: Span | undefined, message: string): void {
	if (!span) return;
	span.setStatus({ code: SpanStatusCode.ERROR, message });
}
