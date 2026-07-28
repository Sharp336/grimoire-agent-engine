const decoder = new TextDecoder();
let buffered = "";
let deferred: { id: string } | undefined;
let negotiated = false;
const methods = [
	"invoke.start",
	"invoke.observe",
	"invoke.wait_turn",
	"invoke.cancel",
	"invoke.message",
	"invoke.release",
	"mail.receive",
	"mail.ack",
];
if (process.argv.includes("--omit-message")) methods.splice(methods.indexOf("invoke.message"), 1);
const ignoreEOF = process.argv.includes("--ignore-eof");
const reportPID = process.argv.includes("--report-pid");
const maxLineArg = process.argv.find(argument => argument.startsWith("--max-line-bytes="));
const maxLineBytes = maxLineArg ? Number(maxLineArg.slice("--max-line-bytes=".length)) : 1_048_576;

function send(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

for await (const chunk of Bun.stdin.stream()) {
	buffered += decoder.decode(chunk, { stream: true });
	let newline = buffered.indexOf("\n");
	while (newline >= 0) {
		const line = buffered.slice(0, newline);
		buffered = buffered.slice(newline + 1);
		newline = buffered.indexOf("\n");
		if (!line) continue;
		const request = JSON.parse(line) as { id: string; method: string };
		if (request.method !== "protocol.hello" && !negotiated) {
			send({
				id: request.id,
				ok: false,
				error: { code: "unsupported_version", message: "protocol.hello must be first", retryable: false },
			});
			continue;
		}
		switch (request.method) {
			case "protocol.hello":
				negotiated = true;
				send({
					id: request.id,
					ok: true,
					result: {
						protocol: "anima-control",
						version: 1,
						anima_version: reportPID ? String(process.pid) : "fixture",
						owner: "external:omp:fixture",
						mailbox: "omp-fixture-Main",
						methods,
						capabilities: { turn_authority: true, threaded_mail: true, external_mailbox: true },
						limits: { max_line_bytes: maxLineBytes, max_in_flight: 128 },
					},
				});
				break;
			case "test.first":
				deferred = request;
				break;
			case "test.second":
				send({ id: request.id, ok: true, result: { order: 2 } });
				if (deferred) send({ id: deferred.id, ok: true, result: { order: 1 } });
				deferred = undefined;
				break;
			case "test.event":
				send({
					type: "event",
					invocation_id: "in-fixture",
					event: { kind: "generating", at: "2026-07-28T00:00:00Z", detail: "claude" },
				});
				send({ id: request.id, ok: true, result: { delivered: true } });
				break;
			case "test.oversized":
				send({ id: request.id, ok: true, result: { body: "x".repeat(1_048_576) } });
				break;
			case "test.crash":
				process.exit(17);
				break;
			case "test.invalid":
				process.stdout.write("{invalid\n");
				break;
			default:
				send({
					id: request.id,
					ok: false,
					error: { code: "unknown_method", message: request.method, retryable: false },
				});
		}
	}
}

if (ignoreEOF) await new Promise<void>(() => {});
