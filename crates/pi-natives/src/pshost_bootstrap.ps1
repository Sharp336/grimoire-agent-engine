#Requires -Version 7.0
<#
    pshost_bootstrap.ps1 — persistent PowerShell host loop for the omp `PsHost`
    native sidecar.

    Spawned once per agent session by crates/pi-natives/src/pshost.rs as:

        pwsh -NoLogo -NoProfile -NonInteractive -File <this> -ParentPid <pid>

    Protocol (both directions): 4-byte big-endian length prefix + UTF-8 JSON body
    over the process's stdin (requests in) / stdout (events out). stderr is left
    free for catastrophic diagnostics only.

    Requests  (Rust -> host): {type:"exec",id,command,cwd?,env?,width}
                              {type:"stop",id}
                              {type:"exit"}
    Events    (host -> Rust): {type:"ready",pid}
                              {type:"chunk",id,stream:"output"|"information"|"warning"|"verbose"|"debug"|"error",text}
                              {type:"done",id,exitCode?,hadErrors,stopped}

    A single shared runspace ($rs) executes every user command at top scope, so
    variables, imported modules, $LASTEXITCODE, and the live result objects in
    $global:__omp persist across tool calls and remain inspectable via
    `Enter-PSHostProcess -Id <pid>`.
#>
[CmdletBinding()]
param(
    # PID of the omp process. The host self-terminates if the parent dies, so a
    # hard omp crash cannot orphan this sidecar.
    [int] $ParentPid = 0,
    # Cap on retained result history (ring of $global:__omp.History entries).
    [int] $HistoryDepth = 20
)

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

# ── Binary framing over raw stdio ────────────────────────────────────────────
$stdin  = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()

# The framed protocol owns the raw stdout stream captured above. User commands
# (or .NET libraries they load) can still write directly to [Console]::Out —
# e.g. [Console]::WriteLine(...) — and raw bytes on the protocol channel would
# desync the frame reader and kill the host. Point Console.Out at a buffer
# instead; Complete-Exec drains it as ordinary output after each command.
$script:consoleOut = New-Object System.IO.StringWriter
[Console]::SetOut($script:consoleOut)

function Write-Frame([hashtable] $obj) {
    $json  = $obj | ConvertTo-Json -Depth 8 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($json)
    $len   = [BitConverter]::GetBytes([int]$bytes.Length)
    if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($len) }
    $stdout.Write($len, 0, 4)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

# PS-native stream colors (SGR). Labels are kept alongside the color so the text
# stays meaningful wherever ANSI is ignored (e.g. the model transcript).
$ESC = [char]27
$NL = [Environment]::NewLine
function Colorize([string] $text, [string] $sgr) {
    if (-not $text) { return '' }
    (($text -split "\r?\n") | ForEach-Object {
        if ($_ -match '\S') { "$ESC[${sgr}m$_$ESC[0m" } else { $_ }
    }) -join $NL
}

# Emit one non-empty stream block as a chunk frame, normalizing a trailing
# newline so merged stream blocks stay visually separated downstream.
function Write-Chunk([int] $id, [string] $stream, [string] $text) {
    if (-not $text) { return }
    if (-not $text.EndsWith("`n")) { $text += $NL }
    Write-Frame @{ type = 'chunk'; id = $id; stream = $stream; text = $text }
}

# ── Shared session runspace (state lives here, across exec calls) ─────────────
$rs = [RunspaceFactory]::CreateRunspace()
$rs.Open()

function Invoke-OnRunspace([string] $script, [object[]] $arguments) {
    $ps = [PowerShell]::Create()
    $ps.Runspace = $rs
    [void]$ps.AddScript($script)
    if ($arguments) { foreach ($a in $arguments) { [void]$ps.AddArgument($a) } }
    try { return $ps.Invoke() } finally { $ps.Dispose() }
}

# Initialize the object-retention store inside the shared runspace. The
# PostCommandLookupAction flags any Application (native executable) lookup so
# per-invocation exit codes can be attributed without ever resetting
# $LASTEXITCODE — user commands read the true persisted value at all times.
[void](Invoke-OnRunspace @'
$global:__omp = [ordered]@{}
$global:__omp.Last    = $null
$global:__omp.Counter = 0
$global:__omp.History = [ordered]@{}
$ProgressPreference   = 'SilentlyContinue'
$ErrorActionPreference = 'Continue'
$ExecutionContext.InvokeCommand.PostCommandLookupAction = {
    param($CommandName, $CommandLookupEventArgs)
    if ($CommandLookupEventArgs.Command -and
        $CommandLookupEventArgs.Command.CommandType -eq [System.Management.Automation.CommandTypes]::Application) {
        $global:__ompNativeRan = $true
    }
}
'@)

# ── Exec lifecycle ───────────────────────────────────────────────────────────
# $current holds the single in-flight pipeline (the runspace runs one at a time;
# the omp manager serializes calls, the host enforces it).
$script:current = $null

function Start-Exec($req) {
    $id      = [int]$req.id
    $command = [string]$req.command
    $width   = if ($req.width) { [int]$req.width } else { 120 }

    # cwd + env are injected as data (a session-state variable / the process env),
    # never string-interpolated, so user values cannot inject code. cwd is applied
    # via Set-Location inside the pipeline (see $wrapped): a bad path fails the run
    # fast instead of silently running the command in the previous directory.
    $__cwd = if ($req.cwd) { [string]$req.cwd } else { $null }
    $rs.SessionStateProxy.SetVariable('__ompCwd', $__cwd)
    if ($req.env) {
        foreach ($p in $req.env.PSObject.Properties) {
            [Environment]::SetEnvironmentVariable($p.Name, [string]$p.Value)
        }
    }

    # Retain result objects AND keep user variables at top scope: @() is an
    # array-subexpression and try/finally is a plain block — neither (unlike
    # & {}) opens a child scope, so `$x = 1` in the user command persists into
    # the next call. $LASTEXITCODE is never written by the wrapper, so user
    # commands always read the true persisted value; this invocation's native
    # exit is attributed via the PostCommandLookupAction flag (or an observed
    # value change, covering path-invoked executables that skip name lookup)
    # inside a finally, so it is recorded even when the command throws, calls
    # exit, or the pipeline is stopped. Newlines guard against a trailing
    # line-comment swallowing the closing paren.
    # ONE pipeline per call carries everything: run the user command at top
    # scope, retain its live objects in $global:__omp, then render them as the
    # pipeline's output (captured in $out). Exit code is read afterwards via the
    # session-state proxy — a direct API call, not another pipeline.
    $wrapped = @"
`$global:__ompExit = `$null
if (`$__ompCwd) {
    try { Set-Location -LiteralPath `$__ompCwd -ErrorAction Stop }
    catch { Write-Error "Set-Location failed: `$(`$_.Exception.Message)"; return }
}
`$global:__ompPrevExit = `$global:LASTEXITCODE
`$global:__ompNativeRan = `$false
try {
`$global:__omp.Last = @(
$command
)
} finally {
if ((`$global:__ompNativeRan -or `$global:LASTEXITCODE -ne `$global:__ompPrevExit) -and `$null -ne `$global:LASTEXITCODE) {
    `$global:__ompExit = [int]`$global:LASTEXITCODE
}
}
`$global:__omp.Counter++
`$global:__omp.History[[string]`$global:__omp.Counter] = `$global:__omp.Last
while (`$global:__omp.History.Count -gt $HistoryDepth) {
    `$k = @(`$global:__omp.History.Keys)[0]
    `$global:__omp.History.Remove(`$k)
}
`$global:__omp.Last | Out-String -Width $width
"@

    $ps = [PowerShell]::Create()
    $ps.Runspace = $rs
    [void]$ps.AddScript($wrapped)
    $out   = New-Object System.Management.Automation.PSDataCollection[psobject]
    $async = $ps.BeginInvoke([System.Management.Automation.PSDataCollection[psobject]]$null, $out)
    $script:current = @{ Id = $id; PS = $ps; Async = $async; Out = $out; Width = $width; Stopped = $false }
}

function Complete-Exec {
    $cur = $script:current
    $script:current = $null

    try { $cur.PS.EndInvoke($cur.Async) | Out-Null }
    catch { } # terminating/stopped errors surface via HadErrors / Streams.Error

    $hadErrors = [bool]$cur.PS.HadErrors -or ($cur.PS.Streams.Error.Count -gt 0)

    # Streams, in a stable order (the SDK collects each separately, so true
    # cross-stream interleaving is not preserved). Success + Information stay
    # plain; Warning/Verbose/Debug render yellow and Error red — matching the
    # PowerShell console — with their conventional labels retained.
    Write-Chunk $cur.Id 'output' ($cur.Out -join '')
    # Drain direct [Console]::Out writes (redirected at startup) as output.
    if ($script:consoleOut.GetStringBuilder().Length -gt 0) {
        Write-Chunk $cur.Id 'output' $script:consoleOut.ToString()
        [void]$script:consoleOut.GetStringBuilder().Clear()
    }
    if ($cur.PS.Streams.Information.Count -gt 0) {
        Write-Chunk $cur.Id 'information' (($cur.PS.Streams.Information | ForEach-Object { [string]$_.MessageData }) -join $NL)
    }
    if ($cur.PS.Streams.Warning.Count -gt 0) {
        Write-Chunk $cur.Id 'warning' (Colorize (($cur.PS.Streams.Warning | ForEach-Object { "WARNING: $($_.Message)" }) -join $NL) '33;1')
    }
    if ($cur.PS.Streams.Verbose.Count -gt 0) {
        Write-Chunk $cur.Id 'verbose' (Colorize (($cur.PS.Streams.Verbose | ForEach-Object { "VERBOSE: $($_.Message)" }) -join $NL) '33;1')
    }
    if ($cur.PS.Streams.Debug.Count -gt 0) {
        Write-Chunk $cur.Id 'debug' (Colorize (($cur.PS.Streams.Debug | ForEach-Object { "DEBUG: $($_.Message)" }) -join $NL) '33;1')
    }
    if ($cur.PS.Streams.Error.Count -gt 0) {
        Write-Chunk $cur.Id 'error' (Colorize ($cur.PS.Streams.Error | Out-String -Width $cur.Width) '31;1')
    }

    # Per-invocation exit code: the wrapped script records __ompExit only when
    # this pipeline ran a native command (lookup flag or exit-code change), so a
    # stale code from an earlier call never marks a later PS-only command as
    # failed, while $LASTEXITCODE itself stays untouched and readable.
    $ec = $null
    try { $ec = $rs.SessionStateProxy.GetVariable('__ompExit') } catch { }
    $exitCode = if ($null -ne $ec) { [int]$ec } else { $null }

    $cur.PS.Dispose()
    Write-Frame @{ type = 'done'; id = $cur.Id; exitCode = $exitCode; hadErrors = $hadErrors; stopped = [bool]$cur.Stopped }
}

# ── Main event loop: async stdin reads + cooperative pipeline polling ─────────
Write-Frame @{ type = 'ready'; pid = $PID }

$buf      = New-Object byte[] 65536
$pending  = New-Object System.Collections.Generic.List[byte]
$readTask = $stdin.ReadAsync($buf, 0, $buf.Length)
$alive    = $true
$watchdog = [System.Diagnostics.Stopwatch]::StartNew()

while ($alive) {
    # Parent-liveness watchdog (orphan guard for a hard omp crash), polled at
    # ~1s rather than every tick to keep idle CPU negligible.
    if ($ParentPid -gt 0 -and $watchdog.ElapsedMilliseconds -ge 1000) {
        $watchdog.Restart()
        if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
    }

    if ($readTask.Wait(10)) {
        $n = $readTask.Result
        if ($n -le 0) { break }            # stdin EOF -> shut down
        $slice = New-Object byte[] $n
        [Array]::Copy($buf, 0, $slice, 0, $n)
        $pending.AddRange($slice)
        $readTask = $stdin.ReadAsync($buf, 0, $buf.Length)
    }

    while ($pending.Count -ge 4) {
        $lenBytes = $pending.GetRange(0, 4).ToArray()
        if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($lenBytes) }
        $flen = [BitConverter]::ToInt32($lenBytes, 0)
        if ($pending.Count -lt 4 + $flen) { break }
        $body = $pending.GetRange(4, $flen).ToArray()
        $pending.RemoveRange(0, 4 + $flen)
        $req = [Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json

        switch ([string]$req.type) {
            'exec' {
                if ($null -eq $script:current) { Start-Exec $req }
                else { Write-Frame @{ type = 'done'; id = [int]$req.id; exitCode = $null; hadErrors = $true; stopped = $false } }
            }
            'stop' {
                if ($script:current -and $script:current.Id -eq [int]$req.id) {
                    $script:current.Stopped = $true
                    try { $script:current.PS.Stop() } catch { }
                }
            }
            'exit' { $alive = $false }
        }
    }

    if ($script:current -and $script:current.Async.IsCompleted) { Complete-Exec }
}

try { $rs.Close() } catch { }
exit 0
