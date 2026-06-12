# Kitty subagent panes

Kitty subagent panes are an optional, local frontend for direct `task` children. The normal OMP TUI stays in its original Kitty window. Each admitted child gets a separate transcript-and-prompt window; Agent Hub remains the complete child view and the fallback when a pane is unavailable.

This guide covers the npm/Bun package on one local device. It was written against Kitty 0.47.2. Standalone compiled OMP binaries and other terminals are not supported by this example integration.

## Behavior and limits

- The integration is off unless the user extension is installed **and** `OMP_KITTY_SUBAGENT_PANES=1` reaches OMP.
- Installing the extension in `~/.omp/agent/extensions/` enables it for OMP sessions started from every folder on this device. A project-local `<cwd>/.omp/extensions/` copy affects only that exact working directory.
- Only direct children of the top-level interactive session are eligible. Nested children do not get panes; they remain visible in Agent Hub.
- At most four children are admitted per session generation, in child-start order. Overflow, failed launches, and manually closed panes are not backfilled or relaunched in that generation. The next successful new/switch/branch/tree session generation resets admission and manual-close suppression.
- A pane is a view of an in-process agent, not a second agent process. Closing a pane does not abort, release, or otherwise change its child. Use Agent Hub for abort and release.
- Pane sends use existing child behavior: steer a running child, prompt an idle child, or revive-then-prompt a revivable parked child. Aborted, unavailable, and non-revivable parked children are transcript-only.
- A pane reconnects only to the same live loopback sidecar and control generation. A session-generation change revokes it. A parent/sidecar restart is not reconnectable. After connection loss the pane freezes its transcript, disables sends, and exits after the bounded loss timeout.
- Non-Kitty launches, OMP over SSH (`SSH_CONNECTION`, `SSH_CLIENT`, or `SSH_TTY` set), missing executables, and denied Kitty authorization keep agents running with Agent Hub only. The extension emits at most one unavailable notice.

## Security boundary

Treat every process running as your local user as trusted. This integration does not defend against another same-UID process that can read your owner-only files or inspect your processes.

The implemented boundary is narrower than unrestricted Kitty remote control:

- The sidecar binds an ephemeral port on `127.0.0.1`. It requires an exact Host header and one child-and-generation bearer capability; it rejects browser origins, cross-site requests, query credentials, oversized requests, and excess requests/streams/sends.
- A capability permits snapshot, transcript, invalidation stream, and send for one direct child only. It cannot abort or release.
- Endpoint and bearer are written to a one-shot handoff under `${TMPDIR}/omp-agent-pane-<uid>/`: directory mode `0700`, file mode `0600`. The viewer verifies, consumes, and unlinks it before connecting. The handoff locator in the viewer command line is not itself a reusable credential.
- Kitty window ownership is checked by numeric window ID plus two generated user variables before cleanup. Titles and child labels are not trusted.
- The supplied custom authorization program permits only the exact packaged OMP viewer launch, structured `ls`, and ownership-qualified `close-window`. It denies socket-origin requests, arbitrary executables, broad matches, extra environment, `--allow-remote-control`, and other commands.
- The Kitty remote-control password and the file containing the generated `remote_control_password` line are secrets. Keep both owner-only. Never paste raw `kitten @ ls`, request headers, handoff contents, or OMP debug logs into tickets.

The viewer launch explicitly removes `OMP_KITTY_SUBAGENT_PANES`, every `OMP_KITTY_*` control variable, `KITTY_RC_PASSWORD`, `KITTY_LISTEN_ON`, and `KITTY_PUBLIC_KEY`. In Kitty's `launch --env` syntax, a bare variable name removes it from the child environment. The viewer receives only its non-secret handoff locator and ownership variables.

Do not replace the supplied custom authorization policy with an action-name-only password or `allow_remote_control yes`.

Do not forward Kitty control, the password, handoff locators, or the loopback sidecar over SSH.

## Install for npm/Bun OMP

### 1. Prerequisites

Install Kitty 0.47.2 or later and Bun 1.3.14 or later. Install the published OMP package with one package manager:

```sh
bun install -g @oh-my-pi/pi-coding-agent
# Or, with Bun already installed for the omp shebang/runtime:
# npm install -g @oh-my-pi/pi-coding-agent
```

This example depends on package-shipped `examples/` and the hidden packaged `__agent-pane` command. It is not the setup path for the Homebrew/compiled binary.

Resolve the exact packaged OMP executable and package root. Keep these absolute paths; Kitty's authorization program compares the real OMP path exactly.

```sh
OMP_EXECUTABLE="$(realpath "$(command -v omp)")"
OMP_PACKAGE_DIR="$(dirname "$(dirname "$OMP_EXECUTABLE")")"
KITTEN_EXECUTABLE=/Applications/kitty.app/Contents/MacOS/kitten

test -x "$OMP_EXECUTABLE"
test -x "$KITTEN_EXECUTABLE"
test -f "$OMP_PACKAGE_DIR/examples/extensions/kitty-subagent-panes.ts"
test -f "$OMP_PACKAGE_DIR/examples/kitty/authorize-omp-panes.py"
```

### 2. Install the user extension and authorization program

A user extension applies to OMP sessions from all folders on this device.

```sh
mkdir -p "$HOME/.omp/agent/extensions" "$HOME/.config/kitty"
cp "$OMP_PACKAGE_DIR/examples/extensions/kitty-subagent-panes.ts" \
  "$HOME/.omp/agent/extensions/kitty-subagent-panes.ts"
cp "$OMP_PACKAGE_DIR/examples/kitty/authorize-omp-panes.py" \
  "$HOME/.config/kitty/authorize-omp-panes.py"
chmod 600 "$HOME/.omp/agent/extensions/kitty-subagent-panes.ts" \
  "$HOME/.config/kitty/authorize-omp-panes.py"
```

Do not copy the extension into both the user and project discovery paths. OMP de-duplicates resolved paths, but duplicate copies are distinct modules and can compete for the same panes.

### 3. Create the Kitty remote-control password files

Use a dedicated random password. The launcher always calls `kitten @ --password-file`; it never puts the password in argv.

```sh
umask 077
OMP_KITTY_RC_PASSWORD_FILE="$HOME/.config/kitty/omp-panes.rc-pass"
OMP_KITTY_SECRET_CONF="$HOME/.config/kitty/omp-panes-secret.conf"

test -s "$OMP_KITTY_RC_PASSWORD_FILE" || openssl rand -base64 32 > "$OMP_KITTY_RC_PASSWORD_FILE"
printf 'allow_remote_control password\nremote_control_password "%s" authorize-omp-panes.py\n' \
  "$(tr -d '\n' < "$OMP_KITTY_RC_PASSWORD_FILE")" > "$OMP_KITTY_SECRET_CONF"
chmod 600 "$OMP_KITTY_RC_PASSWORD_FILE" "$OMP_KITTY_SECRET_CONF"
```

Add this line once to `~/.config/kitty/kitty.conf`:

```conf
include omp-panes-secret.conf
```

Do not use `allow_remote_control yes`. The required value is `password`, paired with `authorize-omp-panes.py`.

These commands are safe to repeat: they retain an existing non-empty password and regenerate the matching secret include. Before the first edit, keep an owner-only backup of your existing `kitty.conf` for full rollback; do not overwrite that backup on later updates.

### 4. Set the OMP opt-in and exact paths for Kitty children

Add these lines to `~/.config/kitty/kitty.conf`, replacing every value with its absolute path from step 1:

```conf
# Required for the OMP extension
# env OMP_KITTY_SUBAGENT_PANES=1
# env OMP_KITTY_OMP_EXECUTABLE=/absolute/path/to/packaged/omp-or-cli.js
# env OMP_KITTY_RC_PASSWORD_FILE=/Users/you/.config/kitty/omp-panes.rc-pass

# Optional when kitten is not discoverable on the GUI PATH; recommended on macOS
# env OMP_KITTY_KITTEN_EXECUTABLE=/Applications/kitty.app/Contents/MacOS/kitten
```

Remove the leading `# ` after replacing the paths. `OMP_KITTY_SUBAGENT_PANES=1`, an absolute owner-only `OMP_KITTY_RC_PASSWORD_FILE`, and resolvable executable paths are required at OMP startup. `OMP_KITTY_KITTEN_EXECUTABLE` is optional because the extension also searches `PATH` and `/Applications/kitty.app/Contents/MacOS/kitten`.

| Variable | Requirement | Implemented behavior |
| --- | --- | --- |
| `OMP_KITTY_SUBAGENT_PANES` | Required opt-in | Must equal `1`; any other value leaves the extension inactive. |
| `OMP_KITTY_OMP_EXECUTABLE` | Required for this fail-closed setup | Must resolve to an absolute executable. The extension can otherwise fall back to its current argv or `PATH`, but the supplied authorization program deliberately requires the exact path in Kitty's own environment. |
| `OMP_KITTY_RC_PASSWORD_FILE` | Required | Absolute path to a regular, non-symlink, current-UID file with no group/other permission bits. |
| `OMP_KITTY_KITTEN_EXECUTABLE` | Optional | Absolute `kitten` override; fallback is `PATH`, then the macOS app path. |
| `KITTY_WINDOW_ID` | Set by Kitty; required at runtime | Must be a positive integer or the extension stays inactive. |
| `SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY` | Suppression inputs | If any is set, the extension stays inactive. |
| `KITTY_RC_PASSWORD`, `KITTY_LISTEN_ON`, `KITTY_PUBLIC_KEY` | Removed from viewer | The launcher uses bare `--env NAME` arguments, which Kitty defines as removal from the child environment. |

The authorization program reads `OMP_KITTY_OMP_EXECUTABLE` from the **Kitty process** environment when Kitty loads it. Kitty's `env` directive configures children, not the already-running Kitty process. On macOS, either launch Kitty from a shell that exports the exact value, or set the GUI-session value before starting Kitty:

```sh
launchctl setenv OMP_KITTY_OMP_EXECUTABLE "$OMP_EXECUTABLE"
```

If the real OMP path changes, update both the `env` line and the Kitty-process environment before restarting Kitty.

### 5. Start or reload

Quit all Kitty instances and start Kitty again. A config reload is not sufficient after changing the authorization program, password, or Kitty-process environment because the policy captures the allowed OMP path when Kitty imports it.

Then start a fresh interactive `omp` inside Kitty. Restart OMP after installing, removing, or replacing the extension; extension discovery occurs at OMP startup. The feature does not activate in print/RPC modes, a child extension context, a non-Kitty terminal, or SSH.

## Using a pane

Each pane shows text-labelled connection, availability/capability, and last-outcome fields.

- Prompt mode: `Enter` sends; `Shift+Enter` inserts a newline; `Tab` enters transcript navigation; `Esc` clears a draft or closes an empty pane; `Ctrl+C` closes.
- Transcript mode: arrows, `PgUp`/`PgDn`, `Home`, and `End` scroll; `Tab` or `Esc` returns to prompt mode; `Ctrl+C` closes.
- When scrolled away from the bottom, new output does not move the current entry anchor and the footer reports new transcript entries.
- During reconnect, revocation, generation close, protocol error, unknown send outcome, or parent loss, sends are disabled and the displayed transcript freezes. An unknown send outcome is never retried automatically.

Agent Hub remains available from the parent TUI (`ctrl+s` or `alt+a`) for all children, nested descendants, abort, release, and any pane failure.

## Troubleshooting

`Kitty subagent panes are unavailable; agents continue in Agent Hub.` is intentionally nonspecific and emitted once. Check locally, without sharing secrets:

1. Confirm this is a fresh interactive OMP started inside Kitty and `KITTY_WINDOW_ID` is a positive integer.
2. Confirm no `SSH_CONNECTION`, `SSH_CLIENT`, or `SSH_TTY` is set.
3. Confirm `OMP_KITTY_SUBAGENT_PANES=1` reaches OMP.
4. Confirm `OMP_KITTY_OMP_EXECUTABLE`, `OMP_KITTY_KITTEN_EXECUTABLE` when set, and `OMP_KITTY_RC_PASSWORD_FILE` are absolute; both executables resolve and are executable.
5. Confirm the password file is a regular, non-symlink file owned by the current UID with no group/other permission bits.
6. Confirm Kitty was fully restarted with `allow_remote_control password`, the custom policy, and the same real OMP path in Kitty's process environment.
7. Run narrow `kitten @ --password-file "$OMP_KITTY_RC_PASSWORD_FILE" ls` locally. Authorization denial or malformed output causes Agent Hub-only fallback.
8. Inspect `~/.omp/logs/` only on the device. Do not publish logs or raw Kitty listings.

A manually closed pane, an overflow child beyond the first four, or an earlier failed launch will not be retried in the same generation. Start a new OMP session generation after fixing configuration.

## Update

After updating the npm/Bun package, repeat path resolution and copy both shipped examples again. Recreate `omp-panes-secret.conf` only when rotating the password; do not rotate it merely for an OMP update.

```sh
bun update -g @oh-my-pi/pi-coding-agent
# Or use the corresponding npm global update.
```

If `realpath "$(command -v omp)"` changed, update the configured path, update the Kitty-process environment, and fully restart Kitty. Always restart OMP so it loads the new extension copy.

## Disable, uninstall, and full rollback

To disable without removing files, remove/comment the `env OMP_KITTY_SUBAGENT_PANES=1` line and restart OMP. No listener, credentials, projection, or panes are created while the extension is absent or disabled.

To uninstall only this integration:

1. Quit OMP parents and their viewer panes.
2. Remove `include omp-panes-secret.conf` and the four OMP Kitty `env` lines from `kitty.conf`.
3. Remove `~/.omp/agent/extensions/kitty-subagent-panes.ts`, `~/.config/kitty/authorize-omp-panes.py`, `~/.config/kitty/omp-panes-secret.conf`, and `~/.config/kitty/omp-panes.rc-pass`.
4. Remove a stale `${TMPDIR%/}/omp-agent-pane-$(id -u)` directory only after no OMP parent/viewer using it remains.
5. If used, run `launchctl unsetenv OMP_KITTY_OMP_EXECUTABLE`.
6. Fully restart Kitty and OMP.

This preserves unrelated Kitty and OMP configuration. For a full rollback, restore your pre-change `kitty.conf` backup, perform the integration uninstall above, and uninstall `@oh-my-pi/pi-coding-agent` with the package manager used to install it if OMP was installed only for this feature.

## Acceptance checklist

### Packaged-install smoke

Run from a directory outside the source checkout:

- [ ] `omp` resolves to the intended npm/Bun package; both example files exist under its resolved package root.
- [ ] Normal `omp --help` does not advertise the hidden `__agent-pane` command.
- [ ] With the extension absent or `OMP_KITTY_SUBAGENT_PANES` unset, direct children run normally and no panes open.
- [ ] With the user extension and opt-in enabled, two direct children open two viewer panes while the parent TUI remains responsive.
- [ ] Text sent in pane A reaches only child A; child B is unchanged. The original async task result remains settled.
- [ ] A nested grandchild opens no pane but is visible in Agent Hub.
- [ ] Starting five direct children opens at most four panes. Closing one or making a launch fail does not backfill during that generation; a new generation resets admission.
- [ ] Closing a viewer does not abort or release its child. Agent Hub can still view/control it.
- [ ] Running OMP outside Kitty, over SSH, or with authorization denied produces Agent Hub-only behavior and at most one unavailable notice.

### Real-Kitty security and ownership

Perform these checks locally. Do not save or paste raw listings, process output, logs, password contents, or handoff contents.

- [ ] Kitty reports 0.47.2 or later and has been fully restarted after policy changes.
- [ ] The password file and secret include are owned by the current UID with mode `0600`; the active handoff directory is `0700` and any active handoff is `0600`.
- [ ] While a viewer is active, inspect `kitten @ --password-file "$OMP_KITTY_RC_PASSWORD_FILE" ls` locally: viewer argv/user variables contain only the non-secret handoff locator and ownership UUIDs, not a `127.0.0.1:<port>` endpoint or bearer token.
- [ ] The narrow launcher `ls` request succeeds, while the viewer has no Kitty control variables and cannot issue arbitrary control. Metadata-expanding requests such as `ls --all-env-vars` are denied by the custom policy.
- [ ] A broad `close-window --match all`, arbitrary `launch`, and socket-origin remote-control request are denied.
- [ ] Graceful OMP exit closes only windows whose numeric ID and both ownership variables still match. Manually created/unrelated Kitty windows remain open.
- [ ] Forced parent termination never closes unrelated windows; viewers freeze and self-exit after endpoint loss.
- [ ] A same-generation stream interruption reconnects and catches up; a new session generation freezes/exits the old viewer instead of reconnecting across generations.
- [ ] Uninstall removes the extension, policy include, password/secret files, and stale handoffs while preserving unrelated Kitty configuration.

## Optional Warp-like Kitty preferences

The following preferences are independent of OMP subagent panes. They neither enable nor secure the feature. Add only the pieces you want to a non-secret Kitty config file and adjust key bindings for conflicts:

```conf
# Side-by-side/stacked splits and focus
shell_integration enabled
enabled_layouts splits,stack
map cmd+d launch --location=vsplit --cwd=current
map cmd+shift+d launch --location=hsplit --cwd=current
map cmd+left neighboring_window left
map cmd+right neighboring_window right
map cmd+up neighboring_window up
map cmd+down neighboring_window down

# Prompt/output navigation (requires shell integration)
map cmd+shift+up scroll_to_prompt -1
map cmd+shift+down scroll_to_prompt 1

# Command palette
map cmd+shift+p command_palette

# Hyperlinks and keyboard URL hints
detect_urls yes
map cmd+shift+u open_url_with_hints

# Notify when a command runs at least 10 seconds and its window is not visible
notify_on_cmd_finish invisible 10.0

# Optional session startup; create and maintain this file separately
# startup_session ~/.config/kitty/work.session
```

Kitty sessions can also be opened explicitly with `kitty --session ~/.config/kitty/work.session` and saved with Kitty's `save_as_session` action. These layout, navigation, palette, hyperlink, session, and notification settings are user preferences, not feature prerequisites.
