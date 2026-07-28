import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { initTheme } from "../modes/theme/theme";
import { runSidecarCommand, type SidecarAction, type SidecarCommandArgs } from "../cli/sidecar-cli";

const ACTIONS: SidecarAction[] = ["unlock", "lock", "status", "stop"];

/**
 * Manage the secret-broker sidecar daemon.
 *
 * `omp-secret sidecar unlock` — prompt for the Bitwarden master password
 * (masked input), unlock, push BW_SESSION to the daemon vault.
 * `omp-secret sidecar lock` — clear the vault (daemon keeps running).
 * `omp-secret sidecar status` — show daemon state: running/locked/unlocked,
 *   which credentials are present (names only, never values).
 * `omp-secret sidecar stop` — kill the daemon (vault dies with it).
 */
export default class Sidecar extends Command {
 static description = "Manage the secret-broker sidecar daemon";

 static args = {
  action: Args.string({
   description: "Daemon action",
   required: false,
   options: ACTIONS,
  }),
 };

 static flags = {
  json: Flags.boolean({ description: "Output JSON" }),
 };

 async run(): Promise<void> {
  const { args, flags } = await this.parse(Sidecar);
  const action = (args.action ?? "status") as SidecarAction;

  const cmd: SidecarCommandArgs = {
   action,
   flags: { json: flags.json ?? false },
  };

  await initTheme();
  await runSidecarCommand(cmd);
 }
}
