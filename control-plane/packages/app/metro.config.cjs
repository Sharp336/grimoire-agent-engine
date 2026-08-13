const path = require("node:path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

/**
 * The app lives inside the omp workspace and imports `@ompd/core` from a
 * sibling directory. Metro treats the project root as the world and refuses to
 * serve a file outside it, so the fork root has to be named explicitly or every
 * native target fails at the first workspace import with "unable to resolve".
 *
 * `nodeModulesPaths` is the other half: Bun keeps React Native at the fork
 * root, while this app pins React 19.1.4 there in its own node_modules.
 * Hierarchical lookup would let renderer files under the fork root discover
 * its React 19.2.7 first, producing React's version-mismatch redbox.
 */
const projectRoot = __dirname;
const forkRoot = path.resolve(projectRoot, "..", "..", "..");

const config = {
  projectRoot,
  watchFolders: [forkRoot],
  resolver: {
    disableHierarchicalLookup: true,
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
