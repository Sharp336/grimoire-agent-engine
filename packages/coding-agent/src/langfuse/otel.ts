// Langfuse OTEL initialization for pi-ai package
// Only activates when LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set

let initialized = false;

export function initLangfuseOtel(): void {
	if (initialized) return;
	initialized = true;

	const publicKey = process.env.LANGFUSE_PUBLIC_KEY || process.env.HERMES_LANGFUSE_PUBLIC_KEY;
	const secretKey = process.env.LANGFUSE_SECRET_KEY || process.env.HERMES_LANGFUSE_SECRET_KEY;
	const host = process.env.LANGFUSE_HOST || process.env.HERMES_LANGFUSE_BASE_URL || "https://cloud.langfuse.com";

	if (!publicKey || !secretKey) return;

	try {
		const { NodeSDK } = require("@opentelemetry/sdk-node");
		const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
		const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
		const { Resource } = require("@opentelemetry/resources");
		const { SemanticResourceAttributes } = require("@opentelemetry/semantic-conventions");

		const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
		const traceExporter = new OTLPTraceExporter({
			url: `${host.replace(/\/$/, "")}/api/public/otel/v1/traces`,
			headers: { Authorization: `Basic ${auth}` },
		});

		const resource = new Resource({
			[SemanticResourceAttributes.SERVICE_NAME]: "oh-my-pi",
			[SemanticResourceAttributes.SERVICE_VERSION]: process.env.OMP_VERSION || "dev",
			"user.id": process.env.USER || "ricardoroche",
			environment: process.env.OMP_ENV || "local",
			source: "omp",
		});

		const sdk = new NodeSDK({
			resource,
			spanProcessors: [new BatchSpanProcessor(traceExporter)],
		});
		sdk.start();

		// Graceful shutdown
		const shutdown = async () => {
			try {
				await sdk.shutdown();
			} catch {}
			process.exit(0);
		};
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
	} catch {
		// OTEL packages not available — silently skip
	}
}

// No auto-init on import. Coding-agent calls initLangfuseOtel() explicitly
// when observability.langfuse.enabled is true so the OTEL SDK is only
// loaded when telemetry is requested.
