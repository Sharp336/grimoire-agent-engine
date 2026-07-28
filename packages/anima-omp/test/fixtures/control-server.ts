const decoder = new TextDecoder();
let buffered = "";
let deferred: { id: string } | undefined;

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
		switch (request.method) {
			case "protocol.hello":
				send({
					id: request.id,
					ok: true,
					result: {
						protocol: "anima-control",
						version: 1,
						anima_version: "fixture",
						methods: ["invoke.start", "invoke.observe", "invoke.wait_turn", "invoke.cancel", "invoke.release"],
						capabilities: { turn_authority: true },
						limits: { max_line_bytes: 1_048_576, max_in_flight: 128 },
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
			default:
				send({
					id: request.id,
					ok: false,
					error: { code: "unknown_method", message: request.method, retryable: false },
				});
		}
	}
}
