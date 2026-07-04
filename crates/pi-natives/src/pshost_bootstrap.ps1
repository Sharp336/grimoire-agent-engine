#Requires -Version 7.0
<#
    pshost_bootstrap.ps1 — persistent PowerShell host loop for the omp `PsHost`
    native sidecar.

    Spawned once per host instance (one warm host per agent session; ephemeral
    runs get their own) by crates/pi-natives/src/pshost.rs as:

        pwsh -NoLogo -NoProfile -NonInteractive -File <this> -ParentPid <pid> -HistoryDepth <n>

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

# Hard cap on a single frame in either direction; must match MAX_FRAME_BYTES in
# pshost.rs. Outbound chunks are split below it, inbound violations mean the
# stream is desynced beyond recovery.
$MaxFrameBytes = 64MB

# ── Binary framing over raw stdio ────────────────────────────────────────────
$stdin  = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()

# The framed protocol owns the raw stdout stream captured above. User commands
# (or .NET libraries they load) can still write directly to [Console]::Out —
# e.g. [Console]::WriteLine(...) — and raw bytes on the protocol channel would
# desync the frame reader and kill the host. Point Console.Out at a buffer
# instead; Complete-Exec drains it as ordinary output after each command.
$script:consoleOut = [System.IO.StringWriter]::new()
[Console]::SetOut($script:consoleOut)

function Write-Frame([hashtable] $Object) {
    $json  = $Object | ConvertTo-Json -Depth 8 -Compress
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
$NL  = [Environment]::NewLine
function Format-AnsiText([string] $Text, [string] $Sgr) {
    if (-not $Text) { return '' }
    (($Text -split "\r?\n") | ForEach-Object {
        if ($_ -match '\S') { "$ESC[${Sgr}m$_$ESC[0m" } else { $_ }
    }) -join $NL
}

# Emit one non-empty stream block as chunk frames, normalizing a trailing
# newline so merged stream blocks stay visually separated downstream. Large
# blocks are split so a single frame can never exceed the reader's cap (which
# would tear down the host): 4M chars stays well under $MaxFrameBytes even
# after UTF-8 expansion and JSON escaping.
function Write-Chunk([int] $Id, [string] $Stream, [string] $Text) {
    if (-not $Text) { return }
    if (-not $Text.EndsWith("`n")) { $Text += $NL }
    $sliceChars = 4194304
    for ($offset = 0; $offset -lt $Text.Length; $offset += $sliceChars) {
        $len = [Math]::Min($sliceChars, $Text.Length - $offset)
        Write-Frame @{ type = 'chunk'; id = $Id; stream = $Stream; text = $Text.Substring($offset, $len) }
    }
}

# ── Shared session runspace (state lives here, across exec calls) ─────────────
$rs = [RunspaceFactory]::CreateRunspace()
$rs.Open()

function Invoke-OnRunspace([string] $Script, [object[]] $Arguments) {
    $ps = [PowerShell]::Create()
    $ps.Runspace = $rs
    [void]$ps.AddScript($Script)
    if ($Arguments) { foreach ($a in $Arguments) { [void]$ps.AddArgument($a) } }
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

function Start-Exec([pscustomobject] $Request) {
    $id      = [int]$Request.id
    $command = [string]$Request.command
    $width   = if ($Request.width) { [int]$Request.width } else { 120 }

    # cwd + env are injected as data (a session-state variable / the process env),
    # never string-interpolated, so user values cannot inject code. cwd is applied
    # via Set-Location inside the pipeline (see $wrapped): a bad path fails the run
    # fast instead of silently running the command in the previous directory.
    $requestedCwd = if ($Request.cwd) { [string]$Request.cwd } else { $null }
    $rs.SessionStateProxy.SetVariable('__ompCwd', $requestedCwd)
    if ($Request.env) {
        foreach ($p in $Request.env.PSObject.Properties) {
            # Process-scoped and never unset: per-call env persists for the
            # host's lifetime, consistent with shell-session semantics.
            [Environment]::SetEnvironmentVariable($p.Name, [string]$p.Value)
        }
    }

    # Two evaluation phases in the expandable here-string below: backtick-escaped
    # `$ (e.g. `$global:...) is literal text that executes LATER in the shared
    # runspace; bare $ ($command, $width, $HistoryDepth) interpolates template
    # values NOW, host-side. Edit with that rule in mind.
    #
    # Retain result objects AND keep user variables at top scope: @() is an
    # array-subexpression and try/finally is a plain block — neither (unlike
    # & {}) opens a child scope, so `$x = 1` in the user command persists into
    # the next call. $LASTEXITCODE is never written by the wrapper, so user
    # commands always read the true persisted value; this invocation's native
    # exit is attributed via the PostCommandLookupAction flag (or an observed
    # value change, covering path-invoked executables that skip name lookup)
    # inside a finally, so it is recorded even when the command throws, calls
    # exit, or the pipeline is stopped. $command sits alone on its own line so
    # a trailing line-comment cannot swallow the closing paren.
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
# History keys must stay strings: int indexing of an ordered dictionary is
# positional, while @(Keys)[0] eviction below relies on keyed writes.
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
    $out   = [System.Management.Automation.PSDataCollection[psobject]]::new()
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
    Write-Chunk -Id $cur.Id -Stream 'output' -Text ($cur.Out -join '')
    # Drain direct [Console]::Out writes (redirected at startup) as output.
    if ($script:consoleOut.GetStringBuilder().Length -gt 0) {
        Write-Chunk -Id $cur.Id -Stream 'output' -Text $script:consoleOut.ToString()
        [void]$script:consoleOut.GetStringBuilder().Clear()
    }
    if ($cur.PS.Streams.Information.Count -gt 0) {
        $infoText = ($cur.PS.Streams.Information | ForEach-Object { [string]$_.MessageData }) -join $NL
        Write-Chunk -Id $cur.Id -Stream 'information' -Text $infoText
    }
    if ($cur.PS.Streams.Warning.Count -gt 0) {
        $warnText = ($cur.PS.Streams.Warning | ForEach-Object { "WARNING: $($_.Message)" }) -join $NL
        Write-Chunk -Id $cur.Id -Stream 'warning' -Text (Format-AnsiText $warnText '33;1')
    }
    if ($cur.PS.Streams.Verbose.Count -gt 0) {
        $verboseText = ($cur.PS.Streams.Verbose | ForEach-Object { "VERBOSE: $($_.Message)" }) -join $NL
        Write-Chunk -Id $cur.Id -Stream 'verbose' -Text (Format-AnsiText $verboseText '33;1')
    }
    if ($cur.PS.Streams.Debug.Count -gt 0) {
        $debugText = ($cur.PS.Streams.Debug | ForEach-Object { "DEBUG: $($_.Message)" }) -join $NL
        Write-Chunk -Id $cur.Id -Stream 'debug' -Text (Format-AnsiText $debugText '33;1')
    }
    if ($cur.PS.Streams.Error.Count -gt 0) {
        $errorText = $cur.PS.Streams.Error | Out-String -Width $cur.Width
        Write-Chunk -Id $cur.Id -Stream 'error' -Text (Format-AnsiText $errorText '31;1')
    }

    # Per-invocation exit code: the wrapped script records __ompExit only when
    # this pipeline ran a native command (lookup flag or exit-code change), so a
    # stale code from an earlier call never marks a later PS-only command as
    # failed, while $LASTEXITCODE itself stays untouched and readable.
    $ec = $null
    try { $ec = $rs.SessionStateProxy.GetVariable('__ompExit') } catch { } # best-effort
    $exitCode = if ($null -ne $ec) { [int]$ec } else { $null }

    $cur.PS.Dispose()
    Write-Frame @{ type = 'done'; id = $cur.Id; exitCode = $exitCode; hadErrors = $hadErrors; stopped = [bool]$cur.Stopped }
}

# ── Main event loop: async stdin reads + cooperative pipeline polling ─────────
Write-Frame @{ type = 'ready'; pid = $PID }

$buf      = [byte[]]::new(65536)
$pending  = [System.Collections.Generic.List[byte]]::new()
$readTask = $stdin.ReadAsync($buf, 0, $buf.Length)
$alive    = $true
$watchdog = [System.Diagnostics.Stopwatch]::StartNew()

# PID-reuse guard for the watchdog: remember the parent's start time at launch;
# a recycled PID belonging to some new process will not match it.
$parentStart = $null
if ($ParentPid -gt 0) {
    try { $parentStart = (Get-Process -Id $ParentPid -ErrorAction Stop).StartTime } catch { } # best-effort
}

while ($alive) {
    # Parent-liveness watchdog (orphan guard for a hard omp crash), polled at
    # ~1s rather than every tick to keep idle CPU negligible.
    if ($ParentPid -gt 0 -and $watchdog.ElapsedMilliseconds -ge 1000) {
        $watchdog.Restart()
        $parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
        if (-not $parent) { break }
        if ($parentStart -and $parent.StartTime -ne $parentStart) { break }
    }

    # 50ms tick: an arriving frame completes the read task and unblocks Wait
    # immediately, so this bounds only pipeline-completion polling latency
    # while keeping the idle wakeup rate low.
    if ($readTask.Wait(50)) {
        $n = $readTask.Result
        if ($n -le 0) { break }            # stdin EOF -> shut down
        $slice = [byte[]]::new($n)
        [Array]::Copy($buf, 0, $slice, 0, $n)
        $pending.AddRange($slice)
        $readTask = $stdin.ReadAsync($buf, 0, $buf.Length)
    }

    while ($pending.Count -ge 4) {
        $lenBytes = $pending.GetRange(0, 4).ToArray()
        if ([BitConverter]::IsLittleEndian) { [Array]::Reverse($lenBytes) }
        $frameLength = [BitConverter]::ToInt32($lenBytes, 0)
        if ($frameLength -lt 0 -or $frameLength -gt $MaxFrameBytes) {
            # The stream is desynced beyond recovery; die visibly rather than
            # misparse frames forever. (The shared runspace state is lost either
            # way — there is no realigning a corrupt length-prefixed stream.)
            $alive = $false
            break
        }
        if ($pending.Count -lt 4 + $frameLength) { break }
        $body = $pending.GetRange(4, $frameLength).ToArray()
        $pending.RemoveRange(0, 4 + $frameLength)
        # Framing is still aligned even if one body is garbage: skip it rather
        # than letting a malformed frame tear down the whole session runspace.
        try { $req = [Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json }
        catch { continue }

        switch ([string]$req.type) {
            'exec' {
                if ($null -eq $script:current) { Start-Exec $req }
                else { Write-Frame @{ type = 'done'; id = [int]$req.id; exitCode = $null; hadErrors = $true; stopped = $false } }
            }
            'stop' {
                if ($script:current -and $script:current.Id -eq [int]$req.id) {
                    $script:current.Stopped = $true
                    try { $script:current.PS.Stop() } catch { } # best-effort
                }
            }
            'exit' { $alive = $false }
        }
    }

    if ($script:current -and $script:current.Async.IsCompleted) { Complete-Exec }
}

try { $rs.Close() } catch { } # best-effort
exit 0
