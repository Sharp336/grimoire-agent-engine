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

# The sidecar's stdin/stdout are the length-prefixed JSON protocol channel the
# Rust side reads from and writes to. Native executables spawned by user
# commands inherit this process's OS standard handles, so a child that reads
# stdin (most visibly Git for Windows' git.exe, which blocks on it for every
# subcommand) hangs forever and steals request bytes, and a child that writes
# directly to the inherited stdout (e.g. a .NET Process started outside
# PowerShell's pipeline with RedirectStandardOutput=false) emits raw bytes where
# the frame reader expects a length prefix and tears the host down. Detach both
# at startup: keep the real pipes for our own reader/writer, and repoint the
# inheritable STDIN/STDOUT slots at the null device so children see EOF on read
# and discard writes. (Console.SetIn/SetOut only swap this process's managed
# reader/writer; the OS handles a child inherits are separate slots, so the
# redirect needs a P/Invoke.)
Add-Type -Namespace Omp -Name Stdio -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)] static extern System.IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll", SetLastError=true)] static extern bool SetStdHandle(int n, System.IntPtr h);
[DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern System.IntPtr CreateFileW(string name, uint access, uint share, System.IntPtr sec, uint disp, uint flags, System.IntPtr templ);
[DllImport("libc", SetLastError=true)] static extern int open(string path, int flags);
[DllImport("libc", SetLastError=true)] static extern int dup(int fd);
[DllImport("libc", SetLastError=true)] static extern int dup2(int oldfd, int newfd);
[DllImport("libc", SetLastError=true)] static extern int close(int fd);
[DllImport("libc", SetLastError=true)] static extern int fcntl(int fd, int cmd, int arg);
// Preserve the protocol stream on stdHandle/posixFd, then point the inheritable
// slot at the null device so spawned children can't touch the protocol channel.
static System.IO.Stream Detach(int stdHandle, int posixFd, bool forWrite) {
    var access = forWrite ? System.IO.FileAccess.Write : System.IO.FileAccess.Read;
    if (System.Runtime.InteropServices.RuntimeInformation.IsOSPlatform(System.Runtime.InteropServices.OSPlatform.Windows)) {
        // Wrap the original pipe handle (ownsHandle:false — the process still
        // owns it), then point the inheritable slot at NUL.
        System.IntPtr orig = GetStdHandle(stdHandle);
        var keep = new System.IO.FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(orig, false), access, 1);
        uint gen = forWrite ? 0x40000000u : 0x80000000u; // GENERIC_WRITE : GENERIC_READ
        System.IntPtr nul = CreateFileW("NUL", gen, 0x3u, System.IntPtr.Zero, 3u, 0u, System.IntPtr.Zero);
        SetStdHandle(stdHandle, nul);
        return keep;
    }
    // POSIX: dup the real descriptor aside, then swap the fd to /dev/null so
    // children inherit EOF/discard while our stream keeps the pipe. dup(2)
    // never carries FD_CLOEXEC to the duplicate (POSIX-specified), so without
    // explicitly setting it here a forked native command still inherits this
    // now-non-stdio fd; a long-lived orphaned child holding it open would
    // then keep the pipe's write end alive after the host exits/crashes,
    // hiding EOF from the Rust reader and stalling in-flight run() calls
    // until their own timeout instead of promptly reporting host death.
    int saved = dup(posixFd);
    fcntl(saved, 2 /* F_SETFD */, 1 /* FD_CLOEXEC */);
    int nulFd = open("/dev/null", forWrite ? 1 : 0); // O_WRONLY : O_RDONLY
    if (nulFd >= 0) { dup2(nulFd, posixFd); close(nulFd); }
    return new System.IO.FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle((System.IntPtr)saved, true), access, 1);
}
public static System.IO.Stream DetachStdin()  { return Detach(-10, 0, false); }
public static System.IO.Stream DetachStdout() { return Detach(-11, 1, true); }
'@

# ── Binary framing over raw stdio ────────────────────────────────────────────
$stdin  = [Omp.Stdio]::DetachStdin()
$stdout = [Omp.Stdio]::DetachStdout()

# DetachStdout guards children that inherit the OS stdout slot, but managed
# writes to [Console]::Out (e.g. [Console]::WriteLine from a loaded .NET
# library) still target this process's stdout — the private protocol handle
# above — and raw bytes there would desync the frame reader and kill the
# host. [Console]::Error targets the sidecar's separate OS stderr pipe, which
# never carries protocol frames, so it can't desync the reader — but Rust
# only retains that pipe as a startup-failure diagnostic tail (never routed
# to a running exec's result), so an unredirected direct write there would
# silently vanish instead of surfacing as command output. Point both at
# buffers instead; Complete-Exec drains them as ordinary/error output.
$script:consoleOut = [System.IO.StringWriter]::new()
$script:consoleErr = [System.IO.StringWriter]::new()
[Console]::SetOut($script:consoleOut)
[Console]::SetError($script:consoleErr)

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
# PostCommandLookupAction flags Application (native executable) lookups so
# per-invocation exit codes can be attributed without ever resetting
# $LASTEXITCODE — user commands read the true persisted value at all times.
# The action fires only on invocation-time lookups: Get-Command / availability
# probes resolve Applications through CommandDiscovery without triggering it
# (verified on pwsh 7.6.2, both standalone and through this runspace), so a
# lookup-only command never inherits a stale exit code. The TS suite pins that
# contract ("a lookup-only command after a failed native…").
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
    # Clear the per-invocation exit sentinel host-side (via the proxy) BEFORE
    # $wrapped is built and parsed. A syntactically invalid user command throws
    # at parse time, so the in-band reset would never run and Complete-Exec
    # would read a stale __ompExit left by an earlier native command.
    $rs.SessionStateProxy.SetVariable('__ompExit', $null)
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
    $script:current = @{
        Id = $id; PS = $ps; Async = $async; Out = $out; Width = $width; Stopped = $false
        # High-water marks for incremental stream publishing (Publish-Streams).
        InfoIdx = 0; WarnIdx = 0; VerboseIdx = 0; DebugIdx = 0; ErrorIdx = 0
    }
}

# Publish new entries from the pipeline's data streams as labeled chunks.
# Called from the poll loop while the pipeline runs — so Write-Host /
# Write-Warning / Write-Verbose / Write-Debug / Write-Error progress reaches
# the TUI live instead of buffering until completion — and once more from
# Complete-Exec for the tail. PSDataCollection is documented thread-safe for
# concurrent producer/consumer access, so indexed reads here are safe while
# the pipeline thread appends. Success output is NOT streamed: PowerShell's
# table formatting needs the whole collection to size columns, so rendering
# per-object would regress every tabular result (see Complete-Exec).
function Publish-Streams([hashtable] $Cur) {
    $s = $Cur.PS.Streams

    $n = $s.Information.Count
    if ($n -gt $Cur.InfoIdx) {
        $lines = for ($i = $Cur.InfoIdx; $i -lt $n; $i++) { [string]$s.Information[$i].MessageData }
        $Cur.InfoIdx = $n
        Write-Chunk -Id $Cur.Id -Stream 'information' -Text (@($lines) -join $NL)
    }
    $n = $s.Warning.Count
    if ($n -gt $Cur.WarnIdx) {
        $lines = for ($i = $Cur.WarnIdx; $i -lt $n; $i++) { "WARNING: $($s.Warning[$i].Message)" }
        $Cur.WarnIdx = $n
        Write-Chunk -Id $Cur.Id -Stream 'warning' -Text (Format-AnsiText (@($lines) -join $NL) '33;1')
    }
    $n = $s.Verbose.Count
    if ($n -gt $Cur.VerboseIdx) {
        $lines = for ($i = $Cur.VerboseIdx; $i -lt $n; $i++) { "VERBOSE: $($s.Verbose[$i].Message)" }
        $Cur.VerboseIdx = $n
        Write-Chunk -Id $Cur.Id -Stream 'verbose' -Text (Format-AnsiText (@($lines) -join $NL) '33;1')
    }
    $n = $s.Debug.Count
    if ($n -gt $Cur.DebugIdx) {
        $lines = for ($i = $Cur.DebugIdx; $i -lt $n; $i++) { "DEBUG: $($s.Debug[$i].Message)" }
        $Cur.DebugIdx = $n
        Write-Chunk -Id $Cur.Id -Stream 'debug' -Text (Format-AnsiText (@($lines) -join $NL) '33;1')
    }
    $n = $s.Error.Count
    if ($n -gt $Cur.ErrorIdx) {
        $text = $(for ($i = $Cur.ErrorIdx; $i -lt $n; $i++) { $s.Error[$i] }) | Out-String -Width $Cur.Width
        $Cur.ErrorIdx = $n
        Write-Chunk -Id $Cur.Id -Stream 'error' -Text (Format-AnsiText $text '31;1')
    }
}

function Complete-Exec {
    $cur = $script:current
    $script:current = $null

    try { $cur.PS.EndInvoke($cur.Async) | Out-Null }
    catch { } # terminating/stopped errors surface via HadErrors / Streams.Error

    $consoleErrText = if ($script:consoleErr.GetStringBuilder().Length -gt 0) { $script:consoleErr.ToString() } else { $null }
    $hadErrors = [bool]$cur.PS.HadErrors -or ($cur.PS.Streams.Error.Count -gt 0) -or ($null -ne $consoleErrText)

    # Success output renders once, from the whole collection: per-object
    # rendering would break table formatting (columns are sized from every
    # row). The data streams have been flowing live via Publish-Streams; the
    # tail is drained below.
    Write-Chunk -Id $cur.Id -Stream 'output' -Text ($cur.Out -join '')
    # Drain direct [Console]::Out writes (redirected at startup) as output.
    # Completion-only on purpose: the pipeline thread appends to this
    # StringBuilder while running, and StringBuilder is not safe to read
    # concurrently with a writer.
    if ($script:consoleOut.GetStringBuilder().Length -gt 0) {
        Write-Chunk -Id $cur.Id -Stream 'output' -Text $script:consoleOut.ToString()
        [void]$script:consoleOut.GetStringBuilder().Clear()
    }
    # Drain direct [Console]::Error writes (redirected at startup) as error
    # output, mirroring Console.Out — completion-only for the same
    # StringBuilder-thread-safety reason.
    if ($null -ne $consoleErrText) {
        Write-Chunk -Id $cur.Id -Stream 'error' -Text (Format-AnsiText $consoleErrText '31;1')
        [void]$script:consoleErr.GetStringBuilder().Clear()
    }
    Publish-Streams $cur

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
                    # BeginStop, never Stop: a synchronous Stop() blocks this
                    # event loop until the pipeline yields, and a pipeline stuck
                    # in an uncooperative native/.NET call never does — the loop
                    # must stay responsive so completion (or the Rust side's
                    # stop-ack timeout) can proceed.
                    try { [void]$script:current.PS.BeginStop($null, $null) } catch { } # best-effort
                }
            }
            'exit' { $alive = $false }
        }
    }

    if ($script:current) {
        Publish-Streams $script:current
        if ($script:current.Async.IsCompleted) { Complete-Exec }
    }
}

try { $rs.Close() } catch { } # best-effort
exit 0
