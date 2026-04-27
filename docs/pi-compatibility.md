# Pi compatibility in OMP

OMP remains OMP: the executable is `omp`, packages are `@oh-my-pi/*`, and configuration lives under `.omp` / `~/.omp`. Pi compatibility is an adapter boundary for upstream Pi packages that expect `package.json.pi`, `@mariozechner/*` imports, `pi` child processes, or legacy `.pi` paths.

## Compatibility tiers

| Tier | Name | Supported package behavior | Required OMP compatibility |
| --- | --- | --- | --- |
| 1 | Manifest/API compatible | Uses `package.json.pi` or conventional `extensions/`, `skills/`, `prompts/`, `themes/`; imports Pi public APIs; does not shell out to `pi`; does not hardcode `.pi` paths | Manifest normalization, resource discovery, import alias shims |
| 2 | Process compatible | Tier 1 plus child workers that call `pi --list-models`, `pi --mode json`, `pi --extension`, or related CLI flags | Scoped `pi` shim and Pi-compatible environment propagation |
| 3 | Legacy path compatible | Tier 2 plus `.pi` / `~/.pi` path assumptions | Explicit path bridge mode (`env`, `child-home`, `symlink`, or profile) |
| 4 | Patch/profile required | Custom installers or package assumptions that cannot be redirected generically | Package profile, documented patch, or precise doctor report |

The contract is: a Pi package should either run under an OMP compatibility mode or fail with a precise `doctor` report that identifies the unsupported assumption and recommended bridge/profile.

## Installing Pi packages

Pi source grammar is accepted by OMP plugin install paths:

```bash
omp plugin install npm:pi-teams@0.9.14 --compat-pi
omp plugin install npm:@tmustier/pi-agent-teams@0.5.4 --compat-pi
omp plugin install git:github.com/user/repo@v1 --compat-pi
omp plugin install ./local-pi-package --compat-pi
```

The dedicated Pi command enables compatibility by default:

```bash
omp pi install npm:@tmustier/pi-agent-teams@0.5.4
omp pi doctor npm:pi-teams@0.9.14
omp pi doctor ./local-pi-package
```

Local paths are linked into OMP's plugin directory. NPM and Git sources are installed into `~/.omp/plugins` with Bun.

## Resource support

OMP normalizes plugin manifests in this order:

1. `package.json.omp`
2. `package.json.pi`
3. conventional Pi resource directories when no manifest exists

Supported resource keys are:

- `extensions`
- `tools`
- `hooks`
- `commands`
- `skills`
- `prompts`
- `themes`

`omp` manifests take precedence over `pi` manifests. When a manifest omits Pi resource keys but conventional directories exist, OMP fills them in rather than silently dropping them.

Plugin-provided skills and prompts are registered through the capability discovery system. Theme paths are resolved and exposed by plugin resource resolvers; users can copy or bridge theme files into OMP's custom theme directory when needed.

## Import aliases

OMP writes shim packages into its managed plugin `node_modules` directory. These do not modify global `node_modules` or shell configuration.

| Pi import | OMP target |
| --- | --- |
| `@mariozechner/pi-coding-agent` | `@oh-my-pi/pi-coding-agent` |
| `@mariozechner/pi-agent-core` | `@oh-my-pi/pi-agent-core` |
| `@mariozechner/pi-ai` | `@oh-my-pi/pi-ai` |
| `@mariozechner/pi-ai/oauth` | `@oh-my-pi/pi-ai/utils/oauth` |
| `@mariozechner/pi-tui` | `@oh-my-pi/pi-tui` |
| `typebox` | `@sinclair/typebox` |
| `typebox/compile` | `@sinclair/typebox/compiler` |
| `typebox/value` | `@sinclair/typebox/value` |

Shims are generated automatically before loading plugin extension or tool modules. They can also be generated explicitly:

```bash
omp pi shim
```

## Scoped `pi` CLI shim

OMP generates a scoped shim under `~/.omp/pi-compat/bin/pi`. The shim delegates to `omp`:

```sh
exec omp "$@"
```

OMP prepends this directory to `PATH` only for OMP compatibility runtime/install contexts. It does not create `/usr/local/bin/pi` and does not edit shell startup files.

Compatibility env vars include:

- `PI_CODING_AGENT=true`
- `PI_CODING_AGENT_DIR=<OMP agent dir>`
- `PI_PACKAGE_DIR=<OMP plugin dir>`
- `OMP_PI_COMPAT=1`
- `OMP_PI_COMPAT_HOME=<OMP-managed compatibility home>`

## Path bridge modes

| Mode | Behavior | Safety notes |
| --- | --- | --- |
| `none` | No legacy path redirection | Default for pure Tier 1 packages |
| `env` | Sets Pi-compatible environment variables only | Safe default for packages with env overrides |
| `profile` | Applies known package env/profile settings | Used for packages such as `@tmustier/pi-agent-teams` |
| `child-home` | Runs child `pi` processes with `HOME=<~/.omp/pi-compat/home>` so `~/.pi` resolves in an OMP sandbox | Preferred for packages whose hardcoded paths occur in spawned workers |
| `symlink` | Creates `~/.pi -> ~/.omp/pi-compat/home/.pi` | Explicit opt-in only; refuses to overwrite an existing `~/.pi` |

Plan or create the symlink bridge explicitly:

```bash
omp pi bridge plan
omp pi bridge symlink --dry-run
omp pi bridge symlink
```

OMP never silently writes to a real `~/.pi` directory. If `~/.pi` already exists, symlink mode reports `refuse-existing`.

## Doctor

`doctor` inspects local packages without executing package code. For installed or local packages it reports:

- manifest source and resolved resources
- Pi import aliases required
- `pi` executable calls
- `.pi` / `~/.pi` path assumptions
- install scripts
- Pi-related env vars
- compatibility tier and recommended bridge mode
- known package profile, if any

Examples:

```bash
omp pi doctor npm:pi-teams@0.9.14
omp pi doctor npm:pi-messenger@0.14.1
omp plugin doctor --compat-pi ./local-package
```

For remote packages that are not installed locally, doctor uses source parsing and known package profiles only. Install or link the package to get full static scanning.

## Known package profiles

| Package | Expected tier | Notes |
| --- | --- | --- |
| `@tmustier/pi-agent-teams` | Tier 2 | Uses Pi manifests and supports env overrides such as `PI_TEAMS_ROOT_DIR` and `PI_TEAMS_HOOKS_DIR` |
| `pi-teams` | Tier 3 | Spawns `pi`, calls `pi --list-models`, and references legacy `~/.pi` paths |
| `pi-messenger` | Tier 3 | Spawns JSON-mode Pi workers and has `.pi` / `~/.pi/agent` config assumptions |

Profiles currently set env and diagnostics only. They do not rewrite package source.

## Unsupported assumptions

OMP compatibility cannot guarantee arbitrary code that depends on native binaries, destructive install scripts, platform-specific terminal behavior, absolute non-Pi paths, or incompatible API drift. Those cases are classified by `doctor` and should be handled through a package profile or upstream patch.

## PR workflow

1. Fork `can1357/oh-my-pi` unless you have maintainer push access.
2. Create a feature branch from upstream `main`.
3. Implement compatibility changes with tests.
4. Run package checks.
5. Push to your fork.
6. Open a PR against `can1357/oh-my-pi:main` and link issue `#433`.
