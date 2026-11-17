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
#
# This file is plain ASCII on purpose: Windows PowerShell reads a script
# without a byte order mark in the computer's legacy code page.

$ErrorActionPreference = 'Stop'
# Progress bars would reach a redirected error stream as serialized records.
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 3
# The bundled attache prints UTF-8; read it as such, so paths with letters like ae, o-slash or a-ring survive.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }

function Say([string]$Message) { Write-Host $Message }
function Fail([string]$Message) {
  [Console]::Error.WriteLine("Attache install failed: $Message")
  exit 1
}

$Src = $PSScriptRoot
$Version = (Get-Content -Raw -LiteralPath (Join-Path $Src 'VERSION')).Trim()
$Target = (Get-Content -Raw -LiteralPath (Join-Path $Src 'TARGET')).Trim()
$NewNode = Join-Path $Src 'runtime\node.exe'
$NewService = Join-Path $Src 'service\attache-service.mjs'

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
$Previous = ''
$Link = Get-Item -LiteralPath $Current -Force -ErrorAction SilentlyContinue
if ($Link -and $Link.LinkType -eq 'Junction') { $Previous = Split-Path -Leaf ([string]@($Link.Target)[0]) }

Say ("Installing Attache $Version" + $(if ($Previous) { " (currently $Previous)" } else { '' }))
New-Item -ItemType Directory -Force -Path (Join-Path $Prefix 'app'), (Join-Path $State 'logs') | Out-Null

# If a service is already installed, back it up before changing anything.
$OldNode = Join-Path $Current 'runtime\node.exe'
if ($Previous -and (Test-Path -LiteralPath $OldNode)) {
  Say 'Backing up the existing installation'
  $Stamp = Get-Date -Format 'yyyyMMddHHmmss'
  $env:ATTACHE_STATE_DIR = $State
  $null = & $OldNode (Join-Path $Current 'service\attache-service.mjs') backup --out (Join-Path $State "backups\pre-upgrade-$Previous-to-$Version-$Stamp.tar.gz")
  if ($LASTEXITCODE -ne 0) { Fail 'could not back up the existing installation; nothing was changed' }
}

# Stop the running service (if any) and wait until it has really stopped.
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
if ($Link) { [IO.Directory]::Delete($Current) }
Rename-Item -LiteralPath $Tmp -NewName $Version
New-Item -ItemType Junction -Path $Current -Value $App | Out-Null
$Switched = Join-Path $Current 'VERSION'
if (-not (Test-Path -LiteralPath $Switched) -or (Get-Content -Raw -LiteralPath $Switched).Trim() -ne $Version) { Fail "could not switch to version $Version" }
if ($Replaced) { Remove-Item -LiteralPath $Replaced -Recurse -Force -ErrorAction SilentlyContinue }

# Command-line entry points, and the logon task: starts at logon, restarts on crash, independent of any browser.
$null = NewAttache 'could not install the attache command' wrappers install --prefix $Prefix --state-dir $State --port $Port
$null = NewAttache 'could not set up the logon task' service install --prefix $Prefix --state-dir $State --port $Port

function Rollback([string]$Why) {
  $Before = Join-Path $Prefix "app\$Previous"
  if ($Previous -and (Test-Path -LiteralPath $Before)) {
    Say "Rolling back to $Previous"
    & $NewNode $NewService service stop | Out-Null
    [IO.Directory]::Delete($Current)
    New-Item -ItemType Junction -Path $Current -Value $Before | Out-Null
    & $NewNode $NewService service start | Out-Null
  }
  Fail $Why
}

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
$Attache = Join-Path $Bin 'attache.cmd'
if ($env:ATTACHE_NO_OPEN -eq '1') { & $Attache pair } else { & $Attache pair --open }
Say ''
Say "Command line: $Attache (status, pair, backup, restore). Uninstall: $(Join-Path $Bin 'attache-uninstall.cmd')"
exit 0
