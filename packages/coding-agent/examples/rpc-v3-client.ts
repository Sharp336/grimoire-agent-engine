import { RpcClient, type RpcSessionObservationFrame } from "@oh-my-pi/pi-coding-agent/rpc";

const client = new RpcClient({
	cwd: process.cwd(),
	rpcV3: {
		hostCapabilities: {
			interactions: ["confirm", "input", "approval", "ask"],
			semanticContent: ["markdown", "fields", "table", "tree", "diff", "file", "progress", "form", "artifact"],
		},
		requestedCapabilities: ["session.observe", "session.execute", "artifact.read"],
	},
});

let subscriptionId: string | undefined;
let observationTail = Promise.resolve();

try {
	client.onSessionObservation((frame: RpcSessionObservationFrame) => {
		observationTail = observationTail.then(async () => {
			if (frame.observation.type === "gap") {
				console.error("Observation gap; reopen with snapshot: true", frame.observation);
				return;
			}
			console.log(frame.observation.kind, frame.observation.payload);
			await client.acknowledgeSession(frame.subscriptionId, frame.observation.sequence);
		});
	});

	await client.start();
	const negotiation = client.rpcV3Negotiation;
	if (!negotiation) throw new Error("OMP did not negotiate the required omp.session v3 profile");

	const opened = await client.openSession({ snapshot: true });
	subscriptionId = opened.subscriptionId;
	if (!opened.snapshot) throw new Error("OMP omitted the requested authoritative snapshot");

	const outcome = await client.invokeSession({
		kind: "queue_insert",
		input: { lane: "followUp", text: "Review the current changes." },
		expectedRevision: opened.snapshot.revision,
		idempotencyKey: crypto.randomUUID(),
	});
	if (outcome.outcome !== "completed") throw new Error(`queue_insert settled as ${outcome.outcome}`);

	await observationTail;
	await client.unsubscribeSession(subscriptionId);
	subscriptionId = undefined;
	await client.shutdownSession();
} finally {
	if (subscriptionId) await client.unsubscribeSession(subscriptionId).catch(() => {});
	await client.stop();
}
