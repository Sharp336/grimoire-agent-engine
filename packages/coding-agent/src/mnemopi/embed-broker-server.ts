import { postmortem, setProcessName } from "@oh-my-pi/pi-utils";
import {
	MNEMOPI_EMBED_BROKER_ENDPOINT_ENV,
	MNEMOPI_EMBED_BROKER_TOKEN_FILE_ENV,
	MnemopiEmbedBroker,
	mnemopiEmbedBrokerReadyBanner,
} from "./embed-broker";
import { spawnMnemopiEmbedWorker } from "./embed-client";

/** Start the machine-global embedding broker selected by the hidden CLI worker entrypoint. */
export async function startMnemopiEmbedBrokerFromEnvironment(): Promise<void> {
	const endpoint = process.env[MNEMOPI_EMBED_BROKER_ENDPOINT_ENV];
	const tokenFile = process.env[MNEMOPI_EMBED_BROKER_TOKEN_FILE_ENV];
	if (!endpoint || !tokenFile) throw new Error("Mnemopi embed broker environment is incomplete");
	delete process.env[MNEMOPI_EMBED_BROKER_ENDPOINT_ENV];
	delete process.env[MNEMOPI_EMBED_BROKER_TOKEN_FILE_ENV];
	const token = (await Bun.file(tokenFile).text()).trim();
	if (!token) throw new Error("Mnemopi embed broker token is empty");
	setProcessName("omp mnemopi embed broker");
	const broker = new MnemopiEmbedBroker({ token, spawnWorker: spawnMnemopiEmbedWorker });
	const cancelCleanup = postmortem.register("mnemopi-embed-broker", () => broker.shutdown());
	try {
		await broker.listen(endpoint);
		process.stdout.write(`${mnemopiEmbedBrokerReadyBanner(endpoint)}\n`);
		await Promise.withResolvers<never>().promise;
	} finally {
		cancelCleanup();
		await broker.shutdown();
	}
}
