import * as fs from "node:fs";

function runCommand(command: string, args: string[]): string | null {
  try {
    const result = new Deno.Command(command, {
      args,
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    if (!result.success) return null;
    return new TextDecoder().decode(result.stdout).trim();
  } catch {
    return null;
  }
}

export function detectHostAvx2Support(): boolean {
  if (Deno.build.arch !== "x86_64") return false;

  if (Deno.build.os === "linux") {
    try {
      const cpuInfo = Deno.readTextFileSync("/proc/cpuinfo");
      return /\bavx2\b/i.test(cpuInfo);
    } catch {
      return false;
    }
  }

  if (Deno.build.os === "darwin") {
    const leaf7 = runCommand("sysctl", ["-n", "machdep.cpu.leaf7_features"]);
    if (leaf7 && /\bAVX2\b/i.test(leaf7)) return true;
    const features = runCommand("sysctl", ["-n", "machdep.cpu.features"]);
    return Boolean(features && /\bAVX2\b/i.test(features));
  }

  if (Deno.build.os === "windows") {
    const output = runCommand("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[System.Runtime.Intrinsics.X86.Avx2]::IsSupported",
    ]);
    return output?.toLowerCase() === "true";
  }

  return false;
}
