# Attache installer for Windows. Runs from an extracted release, with the
# Windows PowerShell every Windows 10 and 11 has; the Node.js runtime is
# bundled, and everything else (where files go, the logon task, the
# command-line wrappers) is done by the bundled `attache` itself through its
# platform modules, as on macOS and Linux.
#
#   install.cmd                    install or upgrade, start the service, open setup
#   set ATTACHE_NO_OPEN=1           do not open the browser (and do not wait for a key)
#
# Environment overrides (for tests and advanced use):
#   ATTACHE_PREFIX     install location   (default: %LOCALAPPDATA%\Attache)
#   ATTACHE_STATE_DIR  service state      (default: <prefix>\state)
#   ATTACHE_PORT       service port       (default: 7427)
#   ATTACHE_INSTANCE   instance name      (default: default; also names the logon task)
#   ATTACHE_RELEASE_DIR  the release folder holding the signed manifest, its signature and the
#                      archive this release came from (default: the folder this release was unpacked in,
#                      which is where the one-step installer puts them)
#   ATTACHE_UNATTENDED=1  an Update the running service started: never pair or open the browser, and write
#                      the outcome to <state>\updates\outcome.json, where the service reads it after the restart
#
# This file is plain ASCII on purpose: Windows PowerShell reads a script
# without a byte order mark in the computer's legacy code page.

$ErrorActionPreference = 'Stop'
# Progress bars would reach a redirected error stream as serialized records.
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 3
# The bundled attache prints UTF-8; read it as such, so paths with letters like ae, o-slash or a-ring survive.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }

$Src = $PSScriptRoot
$Version = (Get-Content -Raw -LiteralPath (Join-Path $Src 'VERSION')).Trim()
$Target = (Get-Content -Raw -LiteralPath (Join-Path $Src 'TARGET')).Trim()
$NewNode = Join-Path $Src 'runtime\node.exe'
$NewService = Join-Path $Src 'service\attache-service.mjs'
$Unattended = $env:ATTACHE_UNATTENDED -eq '1'
$Previous = ''
$State = ''
$Prefix = ''
# How far the install got: an outcome was written, the running service was stopped, `current` was switched.
$script:Done = $false
$script:Stopped = $false
$script:Switched = $false

function Say([string]$Message) { Write-Host $Message }

# Unattended, the outcome goes where the service reads it: { outcome, from, to, at, reason? }
# (apps/service/src/updates/install-records.ts). The bundled runtime writes the JSON, so any reason is escaped;
# the values travel in the environment, where Windows PowerShell cannot drop an empty one or mangle a quote.
$OutcomeScript = "const fs = require('node:fs'); const e = process.env; const r = { outcome: e.ATTACHE_OUTCOME, from: e.ATTACHE_OUTCOME_FROM, to: e.ATTACHE_OUTCOME_TO, at: new Date().toISOString() }; if (e.ATTACHE_OUTCOME_REASON) r.reason = e.ATTACHE_OUTCOME_REASON; fs.writeFileSync(e.ATTACHE_OUTCOME_FILE + '.tmp', JSON.stringify(r, null, 2) + String.fromCharCode(10)); fs.renameSync(e.ATTACHE_OUTCOME_FILE + '.tmp', e.ATTACHE_OUTCOME_FILE);"
function Write-Outcome([string]$Kind, [string]$Reason) {
  $script:Done = $true
  if (-not $Unattended) { return }
  $Dir = if ($State) { $State } else { $env:ATTACHE_STATE_DIR }
  if (-not $Dir) { return }
  try {
    New-Item -ItemType Directory -Force -Path (Join-Path $Dir 'updates') | Out-Null
    $env:ATTACHE_OUTCOME_FILE = Join-Path $Dir 'updates\outcome.json'
    $env:ATTACHE_OUTCOME = $Kind
    $env:ATTACHE_OUTCOME_FROM = $Previous
    $env:ATTACHE_OUTCOME_TO = $Version
    $env:ATTACHE_OUTCOME_REASON = $Reason
    & $NewNode -e $OutcomeScript
    if ($LASTEXITCODE -ne 0) { throw "exit code $LASTEXITCODE" }
  } catch {
    [Console]::Error.WriteLine("Attache install: could not write the outcome to $env:ATTACHE_OUTCOME_FILE ($_)")
  }
}

# Stopped before anything changed: an installed version that was stopped runs again.
function Fail([string]$Message) {
  [Console]::Error.WriteLine("Attache install failed: $Message")
  if ($script:Stopped -and -not $script:Switched) { & $NewNode $NewService service start | Out-Null }
  Write-Outcome 'failed' $Message
  exit 1
}

# After the switch: go back to the version that was installed, and start it.
function Rollback([string]$Why) {
  $Before = Join-Path $Prefix "app\$Previous"
  if ($Previous -and $Previous -ne $Version -and (Test-Path -LiteralPath $Before)) {
    Say "Rolling back to $Previous"
    $Current = Join-Path $Prefix 'current'
    & $NewNode $NewService service stop | Out-Null
    if (Test-Path -LiteralPath $Current) { [IO.Directory]::Delete($Current) }
    New-Item -ItemType Junction -Path $Current -Value $Before | Out-Null
    & $NewNode $NewService service start | Out-Null
    [Console]::Error.WriteLine("Attache install failed: $Why")
    Write-Outcome 'rolled_back' $Why
    exit 1
  }
  $script:Switched = $false
  Fail $Why
}

# A command that failed under ErrorActionPreference Stop ends the script without a word: say so, as Fail and Rollback do.
trap {
  if ($script:Done) { break }
  $Why = "the installer stopped unexpectedly: $($_.Exception.Message)"
  if ($script:Switched) { Rollback $Why }
  Fail $Why
}

# Run the attache in this release; returns its output, and fails the install when it fails.
function NewAttache([string]$Why) {
  $out = & $NewNode $NewService @args
  if ($LASTEXITCODE -ne 0) { Fail $Why }
  return $out
}

$Arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$Computer = if ($Arch -eq 'AMD64') { 'windows-x64' } else { "Windows on $Arch" }
if ($Computer -ne $Target) { Fail "this release is for $Target, and this computer is $Computer. Download the release for this computer." }
try { $null = & $NewNode --version } catch { $LASTEXITCODE = 1 }
if ($LASTEXITCODE -ne 0) { Fail 'the bundled runtime does not run on this computer' }

if (-not $env:ATTACHE_INSTANCE) { $env:ATTACHE_INSTANCE = 'default' }
$Prefix = if ($env:ATTACHE_PREFIX) { $env:ATTACHE_PREFIX } else { [string](NewAttache 'could not find the install folder' paths installPrefix) }
$Port = if ($env:ATTACHE_PORT) { $env:ATTACHE_PORT } else { '7427' }
# An install moved with ATTACHE_PREFIX keeps its state inside it, as on macOS.
$State = if ($env:ATTACHE_STATE_DIR) { $env:ATTACHE_STATE_DIR } elseif ($env:ATTACHE_PREFIX) { Join-Path $env:ATTACHE_PREFIX 'state' } else { [string](NewAttache 'could not find the state folder' paths stateDir) }
$App = Join-Path $Prefix "app\$Version"
$Current = Join-Path $Prefix 'current'
$Bin = Join-Path $Prefix 'bin'

# The installed version is the folder the `current` junction points at.
$Link = Get-Item -LiteralPath $Current -Force -ErrorAction SilentlyContinue
if ($Link -and $Link.LinkType -eq 'Junction') { $Previous = Split-Path -Leaf ([string]@($Link.Target)[0]) }

Say ("Installing Attache $Version" + $(if ($Previous) { " (currently $Previous)" } else { '' }))
New-Item -ItemType Directory -Force -Path (Join-Path $Prefix 'app'), (Join-Path $State 'logs') | Out-Null

$OldNode = Join-Path $Current 'runtime\node.exe'
$OldService = Join-Path $Current 'service\attache-service.mjs'

# Over an existing install, the installed version checks this release against its signed manifest with the
# key it holds, before anything changes (ADR 0007). A first install has nothing to check against.
if ($Previous -and (Test-Path -LiteralPath $OldNode)) {
  # A version from before signed releases answers "Unknown command" on its error stream, which must not stop this script.
  $Supported = $false
  try {
    $ErrorActionPreference = 'Continue'
    $null = & $OldNode $OldService verify-release --supported 2>$null
    $Supported = $LASTEXITCODE -eq 0
  } finally { $ErrorActionPreference = 'Stop' }
  if ($Supported) {
    $ReleaseDir = if ($env:ATTACHE_RELEASE_DIR) { $env:ATTACHE_RELEASE_DIR } else { Split-Path -Parent $Src }
    $null = & $OldNode $OldService verify-release $ReleaseDir --version $Version --target $Target --state-dir $State
    if ($LASTEXITCODE -ne 0) { Fail "Attache $Previous could not confirm that this release is signed by Attache; nothing was changed. Download the installer again from the Attache releases page." }
    Say "Attache $Previous checked that this release is signed by Attache."
  } else {
    Say "Attache $Previous cannot check signed releases, so this release is installed without that check."
  }
}

# If a service is already installed, back it up before changing anything.
if ($Previous -and (Test-Path -LiteralPath $OldNode)) {
  Say 'Backing up the existing installation'
  $Stamp = Get-Date -Format 'yyyyMMddHHmmss'
  $env:ATTACHE_STATE_DIR = $State
  $null = & $OldNode $OldService backup --out (Join-Path $State "backups\pre-upgrade-$Previous-to-$Version-$Stamp.tar.gz")
  if ($LASTEXITCODE -ne 0) { Fail 'could not back up the existing installation; nothing was changed' }
}

# Stop the running service (if any) and wait until it has really stopped.
$script:Stopped = $true
$null = NewAttache 'could not stop the running Attache service; nothing was changed' service stop

# Move a folder out of the way. Windows refuses while a program still runs from it; a service that
# was just stopped can take a moment to exit, so this waits up to 15 seconds before giving up.
function Move-Aside([string]$Path) {
  $Aside = "$Path.replaced.$PID"
  for ($i = 0; ; $i++) {
    try { Rename-Item -LiteralPath $Path -NewName (Split-Path -Leaf $Aside); return $Aside }
    catch { if ($i -ge 30) { throw }; Start-Sleep -Milliseconds 500 }
  }
}

# Copy this version into place, then point `current` at it.
$Tmp = Join-Path $Prefix "app\.$Version.installing.$PID"
if (Test-Path -LiteralPath $Tmp) { Remove-Item -LiteralPath $Tmp -Recurse -Force }
New-Item -ItemType Directory -Path $Tmp | Out-Null
foreach ($Part in 'runtime', 'service', 'web', 'bin', 'VERSION', 'uninstall.ps1') { Copy-Item -LiteralPath (Join-Path $Src $Part) -Destination $Tmp -Recurse }
# Reinstalling the same version replaces its folder; nothing else changes until that folder is free.
$Replaced = $null
if (Test-Path -LiteralPath $App) {
  try { $Replaced = Move-Aside $App }
  catch {
    Remove-Item -LiteralPath $Tmp -Recurse -Force
    Fail "could not replace $App, because a program is still using it: $($_.Exception.Message) Close each Harness that uses Attache (such as Claude Code or Codex) and run the installer again."
  }
}
# Removes the junction itself, never what it points at.
$script:Switched = $true
if ($Link) { [IO.Directory]::Delete($Current) }
Rename-Item -LiteralPath $Tmp -NewName $Version
New-Item -ItemType Junction -Path $Current -Value $App | Out-Null
$SwitchedTo = Join-Path $Current 'VERSION'
if (-not (Test-Path -LiteralPath $SwitchedTo) -or (Get-Content -Raw -LiteralPath $SwitchedTo).Trim() -ne $Version) { Rollback "could not switch to version $Version" }
if ($Replaced) { Remove-Item -LiteralPath $Replaced -Recurse -Force -ErrorAction SilentlyContinue }

# Command-line entry points, and the logon task: starts at logon, restarts on crash, independent of any browser.
& $NewNode $NewService wrappers install --prefix $Prefix --state-dir $State --port $Port | Out-Null
if ($LASTEXITCODE -ne 0) { Rollback 'could not install the attache command' }
& $NewNode $NewService service install --prefix $Prefix --state-dir $State --port $Port | Out-Null
if ($LASTEXITCODE -ne 0) { Rollback 'could not set up the logon task' }

& $NewNode $NewService service start | Out-Null
if ($LASTEXITCODE -ne 0) { Rollback 'the background service could not be started' }

Say "Starting the Attache service on http://127.0.0.1:$Port"
# The bundled runtime asks the service for its version, so no other tool is needed.
$Probe = "fetch(process.argv[1]).then((r) => r.json()).then((h) => process.exit(h.version === process.argv[2] ? 0 : 1), () => process.exit(1))"
$Healthy = $false
for ($i = 0; $i -lt 60 -and -not $Healthy; $i++) {
  & $NewNode -e $Probe "http://127.0.0.1:$Port/api/v1/health" $Version
  $Healthy = $LASTEXITCODE -eq 0
  if (-not $Healthy) { Start-Sleep -Milliseconds 500 }
}
if (-not $Healthy) { Rollback "the service did not become healthy; see the logs in $State\logs" }

Say "Attache $Version is running."

# Keep this version and the one it replaced, for going back; remove the rest, and folders an earlier install left.
# Windows refuses to rename a folder a program still runs from (such as a Harness's MCP server): that one stays,
# whole, until the next install. A folder that could be renamed aside is no longer in use and is removed.
if ($Previous -and $Previous -ne $Version) {
  foreach ($Old in @(Get-ChildItem -LiteralPath (Join-Path $Prefix 'app') -Directory -Force)) {
    if ($Old.Name -eq $Version -or $Old.Name -eq $Previous) { continue }
    $Gone = $Old.FullName
    if (-not $Old.Name.StartsWith('.')) {
      $Gone = Join-Path $Old.Parent.FullName ".$($Old.Name).removing.$PID"
      try { Rename-Item -LiteralPath $Old.FullName -NewName (Split-Path -Leaf $Gone) }
      catch { Say "Attache $($Old.Name) is still in use, so it stays until the next install."; continue }
    }
    Remove-Item -LiteralPath $Gone -Recurse -Force -ErrorAction SilentlyContinue
  }
}

if ($Unattended) {
  Write-Outcome 'updated' ''
  exit 0
}
$Attache = Join-Path $Bin 'attache.cmd'
if ($env:ATTACHE_NO_OPEN -eq '1') { & $Attache pair } else { & $Attache pair --open }
Say ''
Say "Command line: $Attache (status, pair, backup, restore). Uninstall: $(Join-Path $Bin 'attache-uninstall.cmd')"
exit 0
