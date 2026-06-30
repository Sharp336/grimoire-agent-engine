Execute PowerShell in a persistent `pwsh` host whose session state is retained across calls.

Unlike one-shot shells, every call runs in the **same runspace**: variables, imported modules, functions, the current location, `$LASTEXITCODE`, and the **live result objects** from previous commands all persist. This makes PowerShell's object pipeline first-class — you can run an expensive command once, then inspect or post-process its results in later calls without re-running it.

## When to use

- Windows administration and any task that benefits from PowerShell's object pipeline (`Get-*` cmdlets, `Where-Object`, `Select-Object`, `Group-Object`, `.NET` types).
- Multi-step investigations where later steps depend on earlier results or imported modules.

For simple POSIX-style commands, prefer `bash`. For reading files, searching, or editing, use the dedicated `read` / `search` / `edit` tools.

## Session state

The most recent command's output objects are retained:

- `$__omp.Last` — the live objects emitted by your previous command. Inspect them without re-running: `$__omp.Last | Get-Member`, `$__omp.Last | Format-List *`, `$__omp.Last[0].SomeProperty`, `$__omp.Last | ConvertTo-Json -Depth 6`.
- `$__omp.History` — an ordered map of recent results, capped to the configured depth.

Variables you set persist too: `$data = Get-Process` in one call, then `$data | Sort-Object CPU` in the next.

## Parameters

- `command` (required): PowerShell to execute in the shared runspace.
- `cwd` (optional): working directory for this command; the location persists into the runspace afterward.
- `timeout` (optional): seconds before the in-flight pipeline is stopped. The runspace and all retained state survive a timeout — only the running pipeline is cancelled.

## Notes

- All PowerShell output streams are captured. Success output and `Write-Host`/`Write-Information` are returned as-is; `Write-Warning`, `Write-Verbose` (with `-Verbose`), and `Write-Debug` (with `-Debug`) are returned with their `WARNING:`/`VERBOSE:`/`DEBUG:` labels; the error stream is surfaced too. Warnings, verbose, debug, and errors are color-coded like the PowerShell console.
- A non-zero `$LASTEXITCODE` or any error-stream write marks the result as failed (warnings do not); the command's output is still returned.
- The host runs one pipeline at a time; calls are serialized.
- For live debugging, the result carries the host PID — attach with `Enter-PSHostProcess -Id <pid>` then `Debug-Runspace`.
