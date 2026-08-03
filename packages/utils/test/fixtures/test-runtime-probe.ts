import { isBunTestRuntime } from "@oh-my-pi/pi-utils/runtime";

process.stdout.write(JSON.stringify(isBunTestRuntime()));
