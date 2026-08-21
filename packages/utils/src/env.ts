import { applyDotenvFiles } from "./env-core";

export * from "./env-core";

// Eagerly parse the user's $HOME/.env, the config-root `.env`, the agent
// `.env`, and the current project's `.env` (from cwd) and apply them to
// `Bun.env`. Importing this entrypoint is what applies the files — the
// `@oh-my-pi/pi-utils` barrel re-exports side-effect-free `env-core` instead,
// so CLI/SDK import graphs that must not touch the default profile's `.env`
// at module load stay clean.
applyDotenvFiles();
