/**
 * Contract: `extraConfigPaths` (the `--mcp-config` flag) loads servers from
 * explicitly specified `mcpServers` JSON files that live outside every
 * discovery path, with these semantics:
 *
 * - servers from an extra config override same-named discovered servers;
 * - an `enabled: false` entry disables the same-named discovered server;
 * - an unreadable or malformed file is a hard error (the caller asked for
 *   this exact file), unlike best-effort provider discovery — "malformed"
 *   covers syntactically valid JSON of the wrong shape;
 * - that hard error survives the CLI/SDK-facing wrapper, which otherwise
 *   degrades discovery failures to a resolved, empty result;
 * - `MCPManager` remembers the paths, so an option-less rediscovery
 *   (`/mcp reload`) re-reads the same files.
 *
 * The shape check is shared with provider discovery, which warns instead of
 * throwing; the last test covers that half.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { discoverAndLoadMCPTools } from "@oh-my-pi/pi-coding-agent/mcp/loader";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

describe("loadAllMCPConfigs extraConfigPaths", () => {
	let tempHome = "";
	let projectDir = "";
	let originalHome: string | undefined;

	beforeEach(async () => {
		originalHome = process.env.HOME;
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-extra-home-"));
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-extra-project-"));
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(path.join(tempHome, ".omp", "agent"));
		clearFsCache();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearFsCache();
		if (originalAgentDirEnv) {
			setAgentDir(originalAgentDirEnv);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		await removeWithRetries(tempHome);
		await removeWithRetries(projectDir);
	});

	test("loads servers from a file outside discovery paths and overrides same-named discovered servers", async () => {
		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					penpot: { url: "http://localhost:4401/mcp" },
					standalone: { command: "standalone-server" },
				},
			}),
		);
		const generatedDir = path.join(projectDir, ".devenv", "mcp");
		await fs.mkdir(generatedDir, { recursive: true });
		const generatedPath = path.join(generatedDir, "claude-code.json");
		await fs.writeFile(
			generatedPath,
			JSON.stringify({
				mcpServers: {
					penpot: { url: "http://localhost:14401/mcp" },
					serena: { url: "http://localhost:24181/mcp" },
				},
			}),
		);

		const { configs, sources } = await loadAllMCPConfigs(projectDir, {
			extraConfigPaths: [path.join(".devenv", "mcp", "claude-code.json")],
		});

		expect(configs.penpot).toMatchObject({ type: "http", url: "http://localhost:14401/mcp" });
		expect(configs.serena).toMatchObject({ type: "http", url: "http://localhost:24181/mcp" });
		expect(configs.standalone).toMatchObject({ type: "stdio", command: "standalone-server" });
		expect(sources.penpot.path).toBe(generatedPath);
		expect(sources.standalone.provider).toBe("mcp-json");
	});

	test("enabled: false in an extra config disables the same-named discovered server", async () => {
		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { noisy: { command: "noisy-server" } } }),
		);
		const overridePath = path.join(projectDir, "override.json");
		await fs.writeFile(overridePath, JSON.stringify({ mcpServers: { noisy: { enabled: false } } }));

		const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: [overridePath] });

		expect(configs.noisy).toBeUndefined();
	});

	// The flag is repeatable and later files win per name — which has to hold for
	// an entry that only disables the name, not just for one carrying a real
	// config, or a generated config could never be turned off downstream of it.
	describe("repeated --mcp-config files resolve last-wins per name", () => {
		const writeExtras = async (...contents: object[]) => {
			const paths: string[] = [];
			for (const [index, body] of contents.entries()) {
				const extraPath = path.join(projectDir, `extra-${index}.json`);
				await fs.writeFile(extraPath, JSON.stringify(body));
				paths.push(extraPath);
			}
			return paths;
		};

		test("a later file's server replaces an earlier file's same-named server", async () => {
			const paths = await writeExtras(
				{ mcpServers: { shared: { url: "http://localhost:1111/mcp" } } },
				{ mcpServers: { shared: { url: "http://localhost:2222/mcp" } } },
			);

			const { configs, sources } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: paths });

			expect(configs.shared).toMatchObject({ type: "http", url: "http://localhost:2222/mcp" });
			expect(sources.shared.path).toBe(paths[1]);
		});

		test("a later file can disable an earlier file's server", async () => {
			const paths = await writeExtras(
				{ mcpServers: { shared: { command: "shared-server" } } },
				{ mcpServers: { shared: { enabled: false } } },
			);

			const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: paths });

			expect(configs.shared).toBeUndefined();
		});

		test("a later file re-enables a name an earlier file disabled", async () => {
			const paths = await writeExtras(
				{ mcpServers: { shared: { enabled: false } } },
				{ mcpServers: { shared: { command: "shared-server" } } },
			);

			const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: paths });

			expect(configs.shared).toMatchObject({ type: "stdio", command: "shared-server" });
		});

		test("a later file's disable still owns the name against discovery", async () => {
			await fs.writeFile(
				path.join(projectDir, ".mcp.json"),
				JSON.stringify({ mcpServers: { shared: { command: "discovered-server" } } }),
			);
			const paths = await writeExtras(
				{ mcpServers: { shared: { command: "shared-server" } } },
				{ mcpServers: { shared: { enabled: false } } },
			);

			const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: paths });

			expect(configs.shared).toBeUndefined();
		});
	});

	// `enabledServers` is the user-level allowlist that overrides a source
	// config's `enabled: false` (what `/mcp enable` writes for a server the user
	// does not own). An explicit tombstone carries no transport, so it must never
	// survive as a config of its own when the allowlist keeps it from suppressing.
	describe("force-enable vs an explicit enabled: false entry", () => {
		const forceEnable = async (...names: string[]) => {
			const userConfigPath = path.join(tempHome, ".omp", "agent", "mcp.json");
			await fs.mkdir(path.dirname(userConfigPath), { recursive: true });
			await fs.writeFile(userConfigPath, JSON.stringify({ enabledServers: names }));
			clearFsCache();
		};

		test("a force-enabled name falls back to the discovered definition", async () => {
			await fs.writeFile(
				path.join(projectDir, ".mcp.json"),
				JSON.stringify({ mcpServers: { shared: { command: "discovered-server" } } }),
			);
			const tombstonePath = path.join(projectDir, "tombstone.json");
			await fs.writeFile(tombstonePath, JSON.stringify({ mcpServers: { shared: { enabled: false } } }));
			await forceEnable("shared");

			const { configs, sources } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: [tombstonePath] });

			// Not a blank stdio config synthesized from the tombstone.
			expect(configs.shared).toMatchObject({ type: "stdio", command: "discovered-server" });
			expect(sources.shared.provider).toBe("mcp-json");
		});

		test("a force-enabled tombstone with nothing to fall back to yields no server", async () => {
			const tombstonePath = path.join(projectDir, "tombstone.json");
			await fs.writeFile(tombstonePath, JSON.stringify({ mcpServers: { orphan: { enabled: false } } }));
			await forceEnable("orphan");

			const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: [tombstonePath] });

			expect(configs.orphan).toBeUndefined();
		});

		test("the denylist still wins over a force-enabled name", async () => {
			await fs.writeFile(
				path.join(projectDir, ".mcp.json"),
				JSON.stringify({ mcpServers: { shared: { command: "discovered-server" } } }),
			);
			const userConfigPath = path.join(tempHome, ".omp", "agent", "mcp.json");
			await fs.mkdir(path.dirname(userConfigPath), { recursive: true });
			await fs.writeFile(
				userConfigPath,
				JSON.stringify({ enabledServers: ["shared"], disabledServers: ["shared"] }),
			);
			clearFsCache();
			const tombstonePath = path.join(projectDir, "tombstone.json");
			await fs.writeFile(tombstonePath, JSON.stringify({ mcpServers: { shared: { enabled: false } } }));

			const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: [tombstonePath] });

			expect(configs.shared).toBeUndefined();
		});

		// `enabled: false` alongside a command or url is a complete config that
		// happens to be off, not a tombstone. Discovery keeps exactly that shape
		// when force-enabled, so the explicit path has to as well — dropping it
		// would demote the highest-priority definition to a lower-priority one.
		test("a force-enabled complete config is kept, not replaced by the discovered one", async () => {
			await fs.writeFile(
				path.join(projectDir, ".mcp.json"),
				JSON.stringify({ mcpServers: { shared: { command: "discovered-server" } } }),
			);
			const explicitPath = path.join(projectDir, "explicit.json");
			await fs.writeFile(
				explicitPath,
				JSON.stringify({ mcpServers: { shared: { enabled: false, command: "explicit-server" } } }),
			);
			await forceEnable("shared");

			const { configs, sources } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: [explicitPath] });

			expect(configs.shared).toMatchObject({ type: "stdio", command: "explicit-server" });
			expect(sources.shared.provider).toBe("mcp-config-flag");
		});

		// The parity baseline the case above has to match: discovery has always
		// kept a disabled-but-complete server when the allowlist force-enables it.
		test("discovery keeps a force-enabled complete but disabled server", async () => {
			await fs.writeFile(
				path.join(projectDir, ".mcp.json"),
				JSON.stringify({ mcpServers: { shared: { enabled: false, command: "discovered-server" } } }),
			);
			await forceEnable("shared");

			const { configs } = await loadAllMCPConfigs(projectDir);

			expect(configs.shared).toMatchObject({ type: "stdio", command: "discovered-server" });
		});

		test("a force-enabled complete config with a url is kept", async () => {
			const explicitPath = path.join(projectDir, "explicit.json");
			await fs.writeFile(
				explicitPath,
				JSON.stringify({ mcpServers: { remote: { enabled: false, url: "http://localhost:4401/mcp" } } }),
			);
			await forceEnable("remote");

			const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: [explicitPath] });

			expect(configs.remote).toMatchObject({ type: "http", url: "http://localhost:4401/mcp" });
		});

		test("without force-enable a complete but disabled config drops both it and the discovered server", async () => {
			await fs.writeFile(
				path.join(projectDir, ".mcp.json"),
				JSON.stringify({ mcpServers: { shared: { command: "discovered-server" } } }),
			);
			const explicitPath = path.join(projectDir, "explicit.json");
			await fs.writeFile(
				explicitPath,
				JSON.stringify({ mcpServers: { shared: { enabled: false, command: "explicit-server" } } }),
			);

			const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: [explicitPath] });

			expect(configs.shared).toBeUndefined();
		});

		test("without force-enable the tombstone still disables the discovered server", async () => {
			await fs.writeFile(
				path.join(projectDir, ".mcp.json"),
				JSON.stringify({ mcpServers: { shared: { command: "discovered-server" } } }),
			);
			const tombstonePath = path.join(projectDir, "tombstone.json");
			await fs.writeFile(tombstonePath, JSON.stringify({ mcpServers: { shared: { enabled: false } } }));

			const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: [tombstonePath] });

			expect(configs.shared).toBeUndefined();
		});
	});

	test("missing extra config file is a hard error", async () => {
		await expect(
			loadAllMCPConfigs(projectDir, { extraConfigPaths: [path.join(projectDir, "does-not-exist.json")] }),
		).rejects.toThrow(/Cannot read MCP config/);
	});

	test("malformed extra config file is a hard error", async () => {
		const brokenPath = path.join(projectDir, "broken.json");
		await fs.writeFile(brokenPath, "{ not json");
		await expect(loadAllMCPConfigs(projectDir, { extraConfigPaths: [brokenPath] })).rejects.toThrow(
			/Invalid JSON in MCP config/,
		);
	});

	// Valid JSON of the wrong shape used to survive: `Object.entries` iterates a
	// string or array into blank stdio servers named by index.
	test.each([
		['"mcpServers" is a string', { mcpServers: "not-a-map" }, /"mcpServers" must be an object/],
		['"mcpServers" is an array', { mcpServers: ["a", "b"] }, /"mcpServers" must be an object/],
		["a server entry is not an object", { mcpServers: { broken: "oops" } }, /server "broken" must be an object/],
		["a server entry is null", { mcpServers: { nulled: null } }, /server "nulled" must be an object/],
		["the root is not an object", ["mcpServers"], /expected a JSON object at the top level/],
		// Pointing the flag at some other valid JSON file is a mistake, not a
		// request for zero servers.
		[
			'"mcpServers" is absent (e.g. package.json)',
			{ name: "my-package", version: "1.0.0" },
			/missing an "mcpServers" object/,
		],
	])("wrong-shape extra config is a hard error: %s", async (_label, contents, expected) => {
		const wrongShapePath = path.join(projectDir, "wrong-shape.json");
		await fs.writeFile(wrongShapePath, JSON.stringify(contents));

		await expect(loadAllMCPConfigs(projectDir, { extraConfigPaths: [wrongShapePath] })).rejects.toThrow(expected);
	});

	// The key has to be present, but declaring no servers is a legitimate way to
	// say "add nothing here" — only the absent key signals the wrong file.
	test("an empty mcpServers object is accepted", async () => {
		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { discovered: { command: "discovered-server" } } }),
		);
		const emptyPath = path.join(projectDir, "empty.json");
		await fs.writeFile(emptyPath, JSON.stringify({ mcpServers: {} }));

		const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: [emptyPath] });

		expect(configs.discovered).toMatchObject({ type: "stdio", command: "discovered-server" });
	});

	// Per-entry checks: `loadCapability` drops invalid discovered servers with a
	// warning, but extras are merged after that call. Without the same checks, a
	// typo'd or missing endpoint becomes a blank stdio config and degrades into a
	// startup connection error instead of the promised hard failure.
	test.each([
		["a typo'd command key", { foo: { commmand: "server" } }, /Must have command or url/],
		["an empty server object", { foo: {} }, /Must have command or url/],
		["http with no url", { foo: { type: "http" } }, /url/],
		["stdio with no command", { foo: { type: "stdio", url: "http://localhost:4401/mcp" } }, /command/],
		// An unknown type falls through `convertToLegacyConfig` to stdio, so it
		// either degrades to a connection error or quietly runs a command the
		// entry did not ask to be run that way.
		["an unknown transport type", { foo: { type: "htt", url: "http://localhost:4401/mcp" } }, /unknown.*type/i],
		// `convertToLegacyConfig` infers stdio from the command and drops the url,
		// so the conflict is gone before `validateServerConfig` could report it.
		[
			"both command and url",
			{ foo: { command: "stale-server", url: "http://localhost:4401/mcp" } },
			/both "command" and "url"/,
		],
	])("invalid explicit server entry is a hard error: %s", async (_label, mcpServers, expected) => {
		const invalidPath = path.join(projectDir, "invalid.json");
		await fs.writeFile(invalidPath, JSON.stringify({ mcpServers }));

		await expect(loadAllMCPConfigs(projectDir, { extraConfigPaths: [invalidPath] })).rejects.toThrow(expected);
	});

	// The exemption the checks above must not swallow: a tombstone has no
	// endpoint by design.
	test("a transport-less enabled: false entry is still accepted", async () => {
		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { noisy: { command: "noisy-server" }, other: { command: "other-server" } } }),
		);
		const tombstonePath = path.join(projectDir, "tombstone.json");
		await fs.writeFile(tombstonePath, JSON.stringify({ mcpServers: { noisy: { enabled: false } } }));

		const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: [tombstonePath] });

		expect(configs.noisy).toBeUndefined();
		expect(configs.other).toMatchObject({ type: "stdio", command: "other-server" });
	});

	// `loadCapability` shadows discovered aliases through `mcpCapability.equivalent`,
	// but extras merge after that call, so an explicit server naming an endpoint a
	// discovered server already covers would otherwise open a second connection to
	// it and expose the same tools twice.
	test("an explicit server shadows a discovered alias for the same endpoint", async () => {
		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					penpot: { url: "http://localhost:14401/mcp" },
					unrelated: { url: "http://localhost:9999/mcp" },
				},
			}),
		);
		const explicitPath = path.join(projectDir, "explicit.json");
		await fs.writeFile(
			explicitPath,
			JSON.stringify({ mcpServers: { "penpot-ws1": { url: "http://localhost:14401/mcp" } } }),
		);

		const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: [explicitPath] });

		expect(configs["penpot-ws1"]).toMatchObject({ type: "http", url: "http://localhost:14401/mcp" });
		expect(configs.penpot).toBeUndefined();
		expect(configs.unrelated).toMatchObject({ type: "http", url: "http://localhost:9999/mcp" });
	});

	// The same dedupe contract inside the explicit set: two names for one endpoint
	// would otherwise open two connections and mount the tools twice, which is
	// what `loadCapability` prevents for everything it loads, single file included.
	test("two explicit files naming one endpoint collapse to the later name", async () => {
		const firstPath = path.join(projectDir, "first.json");
		const secondPath = path.join(projectDir, "second.json");
		await fs.writeFile(firstPath, JSON.stringify({ mcpServers: { penpot: { url: "http://localhost:14401/mcp" } } }));
		await fs.writeFile(
			secondPath,
			JSON.stringify({ mcpServers: { "penpot-ws1": { url: "http://localhost:14401/mcp" } } }),
		);

		const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: [firstPath, secondPath] });

		expect(configs["penpot-ws1"]).toMatchObject({ type: "http", url: "http://localhost:14401/mcp" });
		expect(configs.penpot).toBeUndefined();
	});

	test("two entries in one explicit file naming one endpoint collapse", async () => {
		const explicitPath = path.join(projectDir, "explicit.json");
		await fs.writeFile(
			explicitPath,
			JSON.stringify({
				mcpServers: {
					penpot: { url: "http://localhost:14401/mcp" },
					"penpot-alias": { url: "http://localhost:14401/mcp" },
				},
			}),
		);

		const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: [explicitPath] });

		expect(configs["penpot-alias"]).toMatchObject({ type: "http", url: "http://localhost:14401/mcp" });
		expect(configs.penpot).toBeUndefined();
	});

	// `Map#set` on an existing key updates the value but keeps the original
	// insertion slot, so a redefined name would be walked at its first-appearance
	// position and lose the alias collapse to an entry written before it. Server
	// names decide MCP tool names, so which one survives is user-visible.
	test("a redefined name outranks an alias introduced before the redefinition", async () => {
		const firstPath = path.join(projectDir, "first.json");
		const secondPath = path.join(projectDir, "second.json");
		await fs.writeFile(
			firstPath,
			JSON.stringify({
				mcpServers: {
					penpot: { url: "http://localhost:14401/mcp" },
					alias: { url: "http://localhost:14401/mcp" },
				},
			}),
		);
		await fs.writeFile(secondPath, JSON.stringify({ mcpServers: { penpot: { url: "http://localhost:14401/mcp" } } }));

		const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: [firstPath, secondPath] });

		expect(configs.penpot).toMatchObject({ type: "http", url: "http://localhost:14401/mcp" });
		expect(configs.alias).toBeUndefined();
	});

	// `/mcp reauth` and `/mcp unauth` cannot write to a generated `--mcp-config`
	// file, so they persist auth for these servers into the writable user config
	// instead. That entry shares the name, so the merge would otherwise discard
	// it and reconnect with the auth the explicit file was written with.
	describe("auth persisted to the user config for an explicit server", () => {
		const writeUserConfig = async (servers: object) => {
			const userConfigPath = path.join(tempHome, ".omp", "agent", "mcp.json");
			await fs.mkdir(path.dirname(userConfigPath), { recursive: true });
			await fs.writeFile(userConfigPath, JSON.stringify({ mcpServers: servers }));
			clearFsCache();
		};

		test("a reauth recorded in the user config wins over the explicit entry", async () => {
			// `timeout` stands in for everything that is not auth: the overlay must
			// contribute credentials only, so a wholesale shadow would leak it.
			await writeUserConfig({
				secure: { url: "http://localhost:4401/mcp", timeout: 999, auth: { type: "oauth", credentialId: "new" } },
			});
			const explicitPath = path.join(projectDir, "explicit.json");
			await fs.writeFile(
				explicitPath,
				JSON.stringify({
					mcpServers: {
						secure: { url: "http://localhost:4401/mcp", auth: { type: "oauth", credentialId: "old" } },
					},
				}),
			);

			const { configs, sources } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: [explicitPath] });

			expect(configs.secure).toMatchObject({ auth: { type: "oauth", credentialId: "new" } });
			expect(configs.secure?.timeout).toBeUndefined();
			expect(sources.secure.provider).toBe("mcp-config-flag");
		});

		test("an unauth recorded in the user config clears the explicit entry's auth", async () => {
			await writeUserConfig({ secure: { url: "http://localhost:4401/mcp" } });
			const explicitPath = path.join(projectDir, "explicit.json");
			await fs.writeFile(
				explicitPath,
				JSON.stringify({
					mcpServers: {
						secure: { url: "http://localhost:4401/mcp", auth: { type: "oauth", credentialId: "old" } },
					},
				}),
			);

			const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: [explicitPath] });

			expect(configs.secure?.auth).toBeUndefined();
			expect(configs.secure).toMatchObject({ url: "http://localhost:4401/mcp" });
		});

		// A user config is a general store, not only what the auth commands write.
		// A stale same-named entry for some other endpoint must not be read as an
		// auth overlay, or it would start an authenticated explicit server without
		// credentials.
		test("a same-named user entry for a different endpoint does not touch explicit auth", async () => {
			await writeUserConfig({ secure: { url: "http://localhost:9999/mcp" } });
			const explicitPath = path.join(projectDir, "explicit.json");
			await fs.writeFile(
				explicitPath,
				JSON.stringify({
					mcpServers: {
						secure: { url: "http://localhost:4401/mcp", auth: { type: "oauth", credentialId: "own" } },
					},
				}),
			);

			const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: [explicitPath] });

			expect(configs.secure).toMatchObject({
				url: "http://localhost:4401/mcp",
				auth: { type: "oauth", credentialId: "own" },
			});
		});

		test("an explicit entry with no user-config counterpart keeps its own auth", async () => {
			const explicitPath = path.join(projectDir, "explicit.json");
			await fs.writeFile(
				explicitPath,
				JSON.stringify({
					mcpServers: {
						secure: { url: "http://localhost:4401/mcp", auth: { type: "oauth", credentialId: "own" } },
					},
				}),
			);

			const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: [explicitPath] });

			expect(configs.secure).toMatchObject({ auth: { type: "oauth", credentialId: "own" } });
		});
	});

	test("explicit entries for different endpoints all survive", async () => {
		const explicitPath = path.join(projectDir, "explicit.json");
		await fs.writeFile(
			explicitPath,
			JSON.stringify({
				mcpServers: {
					ws0: { url: "http://localhost:4401/mcp" },
					ws1: { url: "http://localhost:14401/mcp" },
				},
			}),
		);

		const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: [explicitPath] });

		expect(configs.ws0).toMatchObject({ url: "http://localhost:4401/mcp" });
		expect(configs.ws1).toMatchObject({ url: "http://localhost:14401/mcp" });
	});

	test("a stdio alias with different args is not shadowed", async () => {
		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { local: { command: "srv", args: ["--port", "1"] } } }),
		);
		const explicitPath = path.join(projectDir, "explicit.json");
		await fs.writeFile(
			explicitPath,
			JSON.stringify({ mcpServers: { other: { command: "srv", args: ["--port", "2"] } } }),
		);

		const { configs } = await loadAllMCPConfigs(projectDir, { extraConfigPaths: [explicitPath] });

		expect(configs.local).toMatchObject({ command: "srv" });
		expect(configs.other).toMatchObject({ command: "srv" });
	});

	test("a discovered server with conflicting endpoints is dropped, not run as stdio", async () => {
		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					conflicted: { command: "stale-server", url: "http://localhost:4401/mcp" },
					fine: { command: "fine-server" },
				},
			}),
		);

		const { configs } = await loadAllMCPConfigs(projectDir);

		expect(configs.conflicted).toBeUndefined();
		expect(configs.fine).toMatchObject({ type: "stdio", command: "fine-server" });
	});

	// Discovery keeps the other half of the asymmetry: same defect, warning only.
	test("an invalid discovered server is dropped rather than raised", async () => {
		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { broken: { commmand: "server" }, fine: { command: "fine-server" } } }),
		);

		const { configs } = await loadAllMCPConfigs(projectDir);

		expect(configs.broken).toBeUndefined();
		expect(configs.fine).toMatchObject({ type: "stdio", command: "fine-server" });
	});

	// `discoverAndLoadMCPTools` degrades discovery failures to a resolved result
	// with an `errors` entry, which startup only logs. An explicitly named file
	// has to escape that, or `--mcp-config typo.json` starts a session anyway.
	test("explicit-config failure propagates through discoverAndLoadMCPTools", async () => {
		await expect(
			discoverAndLoadMCPTools(projectDir, {
				extraConfigPaths: [path.join(projectDir, "does-not-exist.json")],
				cacheStorage: null,
			}),
		).rejects.toThrow(/Cannot read MCP config/);
	});

	// `/mcp reload` calls `discoverAndConnect()` with no options, so the paths
	// have to survive on the manager. Servers name commands that do not exist:
	// the connect fails fast and lands in `errors` keyed by server name, which
	// is enough to observe which file the second pass read.
	test("manager re-reads remembered extra config paths on option-less rediscovery", async () => {
		const extraPath = path.join(projectDir, "extra.json");
		await fs.writeFile(extraPath, JSON.stringify({ mcpServers: { alpha: { command: "omp-no-such-binary-alpha" } } }));

		const manager = new MCPManager(projectDir, null);
		try {
			const first = await manager.discoverAndConnect({ extraConfigPaths: [extraPath] });
			expect([...first.errors.keys()]).toEqual(["alpha"]);

			await fs.writeFile(
				extraPath,
				JSON.stringify({ mcpServers: { beta: { command: "omp-no-such-binary-beta" } } }),
			);
			clearFsCache();

			const second = await manager.discoverAndConnect();
			expect([...second.errors.keys()]).toEqual(["beta"]);
		} finally {
			await manager.disconnectAll();
		}
	});

	// Discovery keeps its best-effort contract: a wrong-shape `.mcp.json` is
	// skipped with a warning rather than iterated into servers named "0".."8".
	test("wrong-shape discovered config is skipped, not turned into blank servers", async () => {
		await fs.writeFile(path.join(projectDir, ".mcp.json"), JSON.stringify({ mcpServers: "not-a-map" }));

		const { configs } = await loadAllMCPConfigs(projectDir);

		expect(Object.keys(configs)).toEqual([]);
	});

	// Discovery is best-effort per entry, not per file: one malformed entry must
	// not cost the file its valid servers. Capability validation drops the bad
	// one on its own, which is what happened before the file-level check existed.
	test("a discovered file with one bad entry still loads its valid servers", async () => {
		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { bad: "oops", good: { command: "good-server" } } }),
		);

		const { configs } = await loadAllMCPConfigs(projectDir);

		expect(configs.good).toMatchObject({ type: "stdio", command: "good-server" });
		expect(configs.bad).toBeUndefined();
	});

	// `null` is the entry shape that would throw on first field access rather
	// than merely producing a useless server.
	test("a discovered null entry does not take the file down with it", async () => {
		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { nulled: null, good: { command: "good-server" } } }),
		);

		const { configs } = await loadAllMCPConfigs(projectDir);

		expect(configs.good).toMatchObject({ type: "stdio", command: "good-server" });
		expect(configs.nulled).toBeUndefined();
	});

	// The `mcpServers` requirement is scoped to explicitly named files: discovery
	// probes fixed paths, where a file without the key just contributes nothing.
	test("a discovered config with no mcpServers key is not an error", async () => {
		await fs.writeFile(path.join(projectDir, ".mcp.json"), JSON.stringify({ someOtherTool: { setting: true } }));

		const { configs } = await loadAllMCPConfigs(projectDir);

		expect(Object.keys(configs)).toEqual([]);
	});
});
