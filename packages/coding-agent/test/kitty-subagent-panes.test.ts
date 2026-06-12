import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ChildInvalidationDTO,
	ChildPermissionSet,
	ChildSnapshotDTO,
} from "@oh-my-pi/pi-coding-agent/agent-control/protocol";
import { $which } from "@oh-my-pi/pi-utils";
import {
	isExplicitLocalKitty,
	isOwnedViewer,
	type KittyExecResult,
	KittyPaneController,
	type KittyWindow,
	parseKittyWindows,
} from "../examples/extensions/kitty-subagent-panes";

const OMP = "/opt/omp/bin/omp";
const KITTEN = "/opt/kitty/bin/kitten";
const PASSWORD_FILE = "/tmp/kitty-password";
const NONCES = [
	"00000000-0000-4000-8000-000000000001",
	"00000000-0000-4000-8000-000000000002",
	"00000000-0000-4000-8000-000000000003",
	"00000000-0000-4000-8000-000000000004",
	"00000000-0000-4000-8000-000000000005",
	"00000000-0000-4000-8000-000000000006",
	"00000000-0000-4000-8000-000000000007",
	"00000000-0000-4000-8000-000000000008",
	"00000000-0000-4000-8000-000000000009",
	"00000000-0000-4000-8000-000000000010",
	"00000000-0000-4000-8000-000000000011",
	"00000000-0000-4000-8000-000000000012",
];

function snapshot(generation: string, id: string, label = id, updatedAt = 1): ChildSnapshotDTO {
	return { version: 1, generation, id, label, availability: "running", capability: "send", updatedAt };
}

class HostHarness {
	generation = "generation-a";
	children: ChildSnapshotDTO[] = [];
	readonly listeners = new Set<(event: ChildInvalidationDTO) => void>();
	readonly permissionRequests: string[] = [];

	getGeneration(): string {
		return this.generation;
	}
	getChildren(): ChildSnapshotDTO[] {
		return this.children;
	}
	onInvalidation(listener: (event: ChildInvalidationDTO) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	createPermissionSet(childId: string): ChildPermissionSet | undefined {
		this.permissionRequests.push(childId);
		return {
			version: 1,
			generation: this.generation,
			childId,
			endpoint: "http://127.0.0.1:1234/",
			token: `token-${childId}`,
		};
	}
	invalidate(childId = "child"): void {
		for (const listener of this.listeners)
			listener({ version: 1, generation: this.generation, childId, kind: "state" });
	}
	rotate(generation: string, children: ChildSnapshotDTO[]): void {
		this.generation = generation;
		this.children = children;
		this.invalidate();
	}
}

class KittyHarness {
	readonly calls: string[][] = [];
	readonly windows = new Map<number, KittyWindow>();
	failLaunchNumber: number | undefined;
	malformedLaunchNumber: number | undefined;
	onLaunch: (() => void) | undefined;
	#launches = 0;
	#nextId = 40;

	exec = async (_command: string, args: string[]): Promise<KittyExecResult> => {
		this.calls.push(args);
		const command = args[3];
		if (command === "ls")
			return {
				code: 0,
				stderr: "",
				stdout: JSON.stringify([
					{
						tabs: [
							{
								windows: [...this.windows.values()].map(window => ({
									id: window.id,
									cmdline: window.cmdline,
									user_vars: window.userVars,
								})),
							},
						],
					},
				]),
			};
		if (command === "close-window") {
			const match = args[args.indexOf("--match") + 1] ?? "";
			const id = Number(/^id:([1-9][0-9]*) /.exec(match)?.[1]);
			if (Number.isSafeInteger(id)) this.windows.delete(id);
			return { code: 0, stderr: "", stdout: "" };
		}
		if (command !== "launch") return { code: 1, stderr: "denied", stdout: "" };
		this.#launches++;
		if (this.#launches === this.failLaunchNumber) return { code: 1, stderr: "denied", stdout: "" };
		const ownerIndex = args.indexOf("--var");
		const viewerIndex = args.indexOf("--var", ownerIndex + 1);
		const nonce = (args[ownerIndex + 1] ?? "").slice("OMP_PANE_OWNER=".length);
		const viewerId = (args[viewerIndex + 1] ?? "").slice("OMP_PANE_VIEWER=".length);
		const separator = args.indexOf("--");
		const window: KittyWindow = {
			id: this.#nextId++,
			cmdline: args.slice(separator + 1),
			userVars: { OMP_PANE_OWNER: nonce, OMP_PANE_VIEWER: viewerId },
		};
		this.windows.set(window.id, window);
		this.onLaunch?.();
		return {
			code: 0,
			stderr: "",
			stdout: this.#launches === this.malformedLaunchNumber ? "not-an-id" : `${window.id}\n`,
		};
	};
}

function createController(
	host: HostHarness,
	kitty: KittyHarness,
	notices: string[],
	removed: string[] = [],
): KittyPaneController {
	let nonceIndex = 0;
	return new KittyPaneController({
		host,
		kittenExecutable: KITTEN,
		ompExecutable: OMP,
		passwordFile: PASSWORD_FILE,
		exec: kitty.exec,
		createHandoff: async _permission => `/tmp/omp-agent-pane-501/handoff-${NONCES[nonceIndex]}.json`,
		removeHandoff: async locator => {
			removed.push(locator);
		},
		randomNonce: () => NONCES[nonceIndex++]!,
		notice: () => {
			notices.push("unavailable");
		},
	});
}

function launchCalls(kitty: KittyHarness): string[][] {
	return kitty.calls.filter(args => args[3] === "launch");
}

describe("Kitty subagent pane launcher", () => {
	it("admits the first four children once and never backfills a failed slot in the same generation", async () => {
		const host = new HostHarness();
		host.children = [
			snapshot(host.generation, "one", "--type=os-window", 1),
			snapshot(host.generation, "two", "' quoted\nlabel", 2),
			snapshot(host.generation, "three", "[.*] Unicode λ", 3),
			snapshot(host.generation, "four", "control\u0007", 4),
			snapshot(host.generation, "five", "overflow", 5),
		];
		const kitty = new KittyHarness();
		kitty.failLaunchNumber = 2;
		const notices: string[] = [];
		const controller = createController(host, kitty, notices);
		await controller.start();
		host.invalidate("one");
		await controller.settled();

		expect(launchCalls(kitty)).toHaveLength(4);
		expect(launchCalls(kitty).flat()).not.toContain("five");
		expect(launchCalls(kitty).flat()).not.toContain("--type=os-window");
		for (const call of launchCalls(kitty)) {
			expect(call.slice(4, 6)).toEqual(["--type=window", "--keep-focus"]);
			expect(call).toContain("OMP_KITTY_SUBAGENT_PANES");
			expect(call).toContain("OMP_KITTY_OMP_EXECUTABLE");
			expect(call).toContain("OMP_KITTY_KITTEN_EXECUTABLE");
			expect(call).toContain("OMP_KITTY_RC_PASSWORD_FILE");
			expect(call).toContain("KITTY_RC_PASSWORD");
			expect(call).toContain("KITTY_LISTEN_ON");
			expect(call).toContain("KITTY_PUBLIC_KEY");
			expect(call).not.toContain("--allow-remote-control");
			expect(call).not.toContain("--copy-env");
			expect(call).not.toContain("--no-response");
			expect(call.some(value => value.includes("127.0.0.1") || value.startsWith("token-"))).toBe(false);
		}
		for (const window of kitty.windows.values()) {
			expect(window.cmdline.some(value => value.startsWith("KITTY_") || value.startsWith("OMP_KITTY_"))).toBe(false);
		}
		expect(notices).toEqual(["unavailable"]);
		await controller.shutdown();
	});

	it("removes a successful launch handoff when cleanup wins before the viewer consumes it", async () => {
		const host = new HostHarness();
		host.children = [snapshot(host.generation, "one")];
		const kitty = new KittyHarness();
		const removed: string[] = [];
		const controller = createController(host, kitty, [], removed);
		await controller.start();

		expect(kitty.windows.size).toBe(1);
		expect(removed).toEqual([]);
		await controller.shutdown();
		expect(removed).toEqual([`/tmp/omp-agent-pane-501/handoff-${NONCES[0]}.json`]);
	});

	it("resets admission on generation change and closes only an id+nonce+viewer identity match", async () => {
		const host = new HostHarness();
		host.children = [snapshot(host.generation, "one")];
		const kitty = new KittyHarness();
		const controller = createController(host, kitty, []);
		await controller.start();
		const owned = [...kitty.windows.values()][0]!;
		kitty.windows.set(owned.id, { ...owned, userVars: { ...owned.userVars, OMP_PANE_VIEWER: NONCES[11]! } });
		host.rotate("generation-b", [snapshot("generation-b", "five")]);
		await controller.settled();

		expect(kitty.windows.get(owned.id)?.cmdline).toEqual(owned.cmdline);
		expect(launchCalls(kitty)).toHaveLength(2);
		expect(launchCalls(kitty)[1]).toContain("five");
		await controller.shutdown();
		await controller.shutdown();
		expect(kitty.calls.filter(args => args[3] === "close-window")).toHaveLength(1);
	});

	it("reconciles a lost launch response and closes it when a switch wins the launch race", async () => {
		const host = new HostHarness();
		host.children = [snapshot(host.generation, "one")];
		const kitty = new KittyHarness();
		kitty.malformedLaunchNumber = 1;
		kitty.onLaunch = () => {
			host.generation = "generation-b";
			host.children = [];
		};
		const notices: string[] = [];
		const controller = createController(host, kitty, notices);
		await controller.start();

		expect(kitty.windows.size).toBe(0);
		expect(kitty.calls.filter(args => args[3] === "close-window")).toHaveLength(1);
		expect(notices).toHaveLength(1);
		await controller.shutdown();
	});

	it("fails with one bounded notice and never relaunches a manually closed viewer", async () => {
		const host = new HostHarness();
		host.children = [snapshot(host.generation, "one"), snapshot(host.generation, "two")];
		const kitty = new KittyHarness();
		kitty.failLaunchNumber = 1;
		const notices: string[] = [];
		const removed: string[] = [];
		const controller = createController(host, kitty, notices, removed);
		await controller.start();
		kitty.windows.clear();
		host.invalidate("two");
		await controller.settled();

		expect(launchCalls(kitty)).toHaveLength(2);
		expect(notices).toEqual(["unavailable"]);
		expect(removed).toHaveLength(1);
		await controller.shutdown();
	});

	it("parses structured ls without trusting id, ownership nonce, or viewer identity alone", () => {
		const raw = JSON.stringify([
			{
				tabs: [
					{
						windows: [
							{
								id: 7,
								cmdline: ["bun", OMP, "__agent-pane", "--", "one", "/tmp/x"],
								user_vars: { OMP_PANE_OWNER: NONCES[0], OMP_PANE_VIEWER: NONCES[1] },
							},
						],
					},
				],
			},
		]);
		const [window] = parseKittyWindows(raw);
		const record = { windowId: 7, nonce: NONCES[0]!, viewerId: NONCES[1]! };
		expect(isOwnedViewer(window!, record)).toBe(true);
		expect(isOwnedViewer({ ...window!, cmdline: ["/bin/unrelated"] }, record)).toBe(true);
		expect(isOwnedViewer({ ...window!, userVars: { ...window!.userVars, OMP_PANE_OWNER: NONCES[2]! } }, record)).toBe(
			false,
		);
		expect(
			isOwnedViewer({ ...window!, userVars: { ...window!.userVars, OMP_PANE_VIEWER: NONCES[2]! } }, record),
		).toBe(false);
		expect(() => parseKittyWindows("not json")).toThrow("malformed structured window data");
	});

	it("requires explicit local non-SSH Kitty enablement", () => {
		expect(isExplicitLocalKitty({ OMP_KITTY_SUBAGENT_PANES: "1", KITTY_WINDOW_ID: "12" })).toBe(true);
		expect(
			isExplicitLocalKitty({ OMP_KITTY_SUBAGENT_PANES: "1", KITTY_WINDOW_ID: "12", SSH_CONNECTION: "remote" }),
		).toBe(false);
		expect(isExplicitLocalKitty({ OMP_KITTY_SUBAGENT_PANES: "0", KITTY_WINDOW_ID: "12" })).toBe(false);
		expect(isExplicitLocalKitty({ OMP_KITTY_SUBAGENT_PANES: "1" })).toBe(false);
	});
});

const authPath = path.join(import.meta.dir, "../examples/kitty/authorize-omp-panes.py");
const authProbe = [
	"import importlib.util,json,sys",
	"spec=importlib.util.spec_from_file_location('auth',sys.argv[1])",
	"mod=importlib.util.module_from_spec(spec)",
	"spec.loader.exec_module(mod)",
	"print(json.dumps(mod.is_cmd_allowed(json.loads(sys.argv[2]),None,sys.argv[3]=='1',{})))",
].join(";");

async function authorize(command: Record<string, unknown>, fromSocket = false): Promise<boolean> {
	if (process.platform === "win32") return false;
	const python = $which("python3");
	if (!python) throw new Error("python3 is required for the Kitty authorization policy test");
	const processResult = Bun.spawn(
		[python, "-c", authProbe, authPath, JSON.stringify(command), fromSocket ? "1" : "0"],
		{
			env: { ...process.env, OMP_KITTY_OMP_EXECUTABLE: OMP },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [code, stdout] = await Promise.all([processResult.exited, new Response(processResult.stdout).text()]);
	return code === 0 && JSON.parse(stdout) === true;
}

function launchPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		args: [
			OMP,
			"__agent-pane",
			"--",
			"child-one",
			path.join(os.tmpdir(), `omp-agent-pane-${process.getuid?.() ?? "user"}`, `handoff-${NONCES[0]}.json`),
		],
		type: "window",
		keep_focus: true,
		env: [
			"OMP_KITTY_SUBAGENT_PANES",
			"OMP_KITTY_OMP_EXECUTABLE",
			"OMP_KITTY_KITTEN_EXECUTABLE",
			"OMP_KITTY_RC_PASSWORD_FILE",
			"KITTY_RC_PASSWORD",
			"KITTY_LISTEN_ON",
			"KITTY_PUBLIC_KEY",
		],
		var: [`OMP_PANE_OWNER=${NONCES[0]}`, `OMP_PANE_VIEWER=${NONCES[1]}`],
		...overrides,
	};
}

describe("Kitty custom authorization policy", () => {
	it("allows only the exact viewer launch, narrow structured ls, and ownership-qualified close", async () => {
		if (process.platform === "win32") return;
		expect(await authorize({ cmd: "launch", payload: launchPayload() })).toBe(true);
		expect(await authorize({ cmd: "ls", payload: {} })).toBe(true);
		expect(
			await authorize({
				cmd: "close-window",
				payload: {
					match: `id:42 and var:OMP_PANE_OWNER=${NONCES[0]} and var:OMP_PANE_VIEWER=${NONCES[1]}`,
					ignore_no_match: true,
				},
			}),
		).toBe(true);
	});

	it("denies arbitrary execution, metadata privilege, alternate targets/types, broad close, and socket control", async () => {
		if (process.platform === "win32") return;
		const requests = [
			{ cmd: "launch", payload: launchPayload({ args: ["/bin/sh", "-c", "id"] }) },
			{ cmd: "launch", payload: launchPayload({ env: ["TOKEN=secret"] }) },
			{ cmd: "launch", payload: launchPayload({ allow_remote_control: true }) },
			{ cmd: "launch", payload: launchPayload({ type: "os-window" }) },
			{ cmd: "launch", payload: launchPayload({ match: "recent:0" }) },
			{ cmd: "launch", payload: launchPayload({ copy_env: ["*"] }) },
			{ cmd: "close-window", payload: { match: "all", ignore_no_match: true } },
			{ cmd: "close-window", payload: { match: "id:42", ignore_no_match: true } },
			{ cmd: "ls", payload: { all_env_vars: true } },
			{ cmd: "send-text", payload: {} },
		];
		for (const request of requests) expect(await authorize(request)).toBe(false);
		expect(await authorize({ cmd: "launch", no_response: true, payload: launchPayload() })).toBe(false);
		expect(await authorize({ cmd: "launch", payload: launchPayload() }, true)).toBe(false);
	});
});
