const path = require("node:path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

/**
 * The app lives inside the omp workspace and imports `@ompd/core` from a
 * sibling directory. Metro treats the project root as the world and refuses to
 * serve a file outside it, so the fork root has to be named explicitly or every
 * native target fails at the first workspace import with "unable to resolve".
 *
 * `nodeModulesPaths` is the other half: bun hoists dependencies to the fork
 * root, so the app's own `node_modules` is mostly empty and Metro's default
 * upward walk from `projectRoot` is what finds react itself.
 */
const projectRoot = __dirname;
const forkRoot = path.resolve(projectRoot, "..", "..", "..");

const config = {
  projectRoot,
  watchFolders: [forkRoot],
  resolver: {
    nodeModulesPaths: [path.join(projectRoot, "node_modules"), path.join(forkRoot, "node_modules")],
    /**
     * One tree, several platforms. `web` is served by Vite rather than Metro,
     * but keeping it in the list means a `.web.tsx` sibling is never picked up
     * by a native bundle by accident.
     */
    platforms: ["ios", "android", "macos", "windows", "native"],
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
