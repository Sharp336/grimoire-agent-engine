# Prime bridge

`@oh-my-pi/prime-bridge` is a local, authenticated control mesh between OMP and a Prime Agent daemon. It keeps bridge messages and Prime event cursors in SQLite so a bridge restart does not resend completed messages or lose event position.

## Setup

Install the OMP workspace and make the bridge binary available:

```sh
bun install
```

The bridge listens on `127.0.0.1` only. The default state directory is `~/.omp/agent/prime-bridge`.

| Path | Purpose |
| --- | --- |
| `~/.omp/agent/prime-bridge/bridge.sqlite` | Durable outbox, inbox, receipts, audit rows, command journal, and Prime cursors |
| `~/.omp/agent/prime-bridge/token` | Bridge bearer token. The bridge creates this file with mode `0600`. |
| `~/.prime/agent/omp-bridge.json` | Prime pointer containing only the bridge URL and token-file path. The bridge creates it with mode `0600`. |

Use a different state directory when you need an isolated bridge:

```sh
omp-prime-bridge \
  --state-dir "$HOME/.omp/agent/prime-bridge" \
  --port 8787 \
  --token-file "$HOME/.omp/agent/prime-bridge/token" \
  --prime-config-file "$HOME/.prime/agent/omp-bridge.json"
```

The CLI supports `--state-dir`, `--port`, `--token-file`, and `--prime-config-file`. It prints the listening URL after startup. The bridge always binds to loopback. The default CLI port is `0`, which lets the operating system select a free port.

## Enable OMP

Set the bridge settings in the active OMP global configuration:

```sh
omp config set primeBridge.enabled true
omp config set primeBridge.url http://127.0.0.1:8787
omp config set primeBridge.tokenPath "$HOME/.omp/agent/prime-bridge/token"
```

The settings are:

| Setting | Default | Meaning |
| --- | --- | --- |
| `primeBridge.enabled` | `false` | Allows OMP to create the external Prime peer provider. |
| `primeBridge.url` | unset | The loopback bridge URL. Auto-start requires a URL with a fixed port. |
| `primeBridge.tokenPath` | unset | The file that contains the bridge bearer token. |
| `primeBridge.autoStart` | `false` | Asks the OMP launch broker to ensure the detached bridge is running. |

Start the bridge yourself, or enable broker start:

```sh
omp config set primeBridge.autoStart true
```

`autoStart` uses the machine-global launch broker. It starts the `omp-prime-bridge` application with the configured port and token path. It does not start a bridge with an operating-system service manager.

`hub list` shows Prime sessions with `prime://` addresses. Use the exact listed address with `hub send` or `hub wait`; reserved addresses never route to local peers.

## Token and trust

The bridge creates the token on first start and reads it for each authenticated request. OMP sends it as `Authorization: Bearer <token>`. Do not copy the token into the Prime pointer file or into logs.

The bridge accepts `/health` without authentication. Every `/v1/*` route requires the bearer token. The bridge rejects a non-empty `Origin` unless the origin is explicitly allowlisted by server configuration. The public server options have no default allowed origins.

## Recovery

The SQLite database is the recovery record. Keep `bridge.sqlite` and the token file together. To recover after a clean or unclean bridge stop, start the bridge with the same state directory and token path.

Completed OMP-to-Prime sends retain their receipt. A repeated request with the same idempotency key returns the stored receipt and does not send another Prime command. The Prime command journal retries the exact stored mutation envelope. It does not create a new command ID when the result is uncertain.

Prime event cursors store a generation and sequence for each active session. When the Prime daemon supports `event_sequence`, the bridge sends the stored cursor during the next attach. A changed generation starts a new cursor stream.

## Supervision limits

The OMP launch broker starts one machine-global bridge named `prime-bridge` with `detached: true`, `persist: true`, and `restart: "always"`. The detached bridge can survive an OMP or broker exit.

`restart: "always"` only works while the launch broker has its lifecycle record. If the bridge crashes while the broker is down, OMP does not promise an immediate restart. The bridge starts again when the broker recovers and OMP calls the ensure path. Use an external supervisor when you need restart guarantees during broker downtime.

The bridge is not an OMP session. OMP external Prime peers stay outside `AgentRegistry`, and the bridge cannot access live OMP tools. A disconnected OMP session can therefore make a target unavailable without damaging Prime or OMP session state.
