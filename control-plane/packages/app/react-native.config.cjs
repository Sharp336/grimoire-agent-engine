/**
 * Platform registry for the community CLI.
 *
 * iOS and Android come from `react-native` itself and need no entry here; their
 * host projects are in `ios/` and `android/`.
 *
 * macOS and Windows are out-of-tree platforms. Their dependencies are installed
 * and pinned, and the JavaScript is already theirs, but the host projects have
 * not been generated: `react-native-macos-init` and the Windows CLI both shell
 * out to `npm install`, which refuses to run inside a bun workspace
 * (`ENOWORKSPACES`). Adding `macos` / `windows` entries here before those
 * directories exist would make `run-macos` fail with a missing directory rather
 * than with the truth, so they are named in the README instead of faked here.
 *
 * `assets` is what links the vendored typefaces into a native build. Without it
 * Archivo and IBM Plex Mono exist in the repository and nowhere on a device, and
 * the native targets silently fall back to the system face.
 */
module.exports = {
  project: {
    ios: {},
    android: {},
  },
  assets: ["./src/design/fonts"],
};
