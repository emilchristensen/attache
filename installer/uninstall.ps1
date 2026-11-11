# Remove Jarvis from Windows. By default your data folder, service state
# (settings, jobs, drafts, receipts, backups) and stored credentials are
# KEPT, so reinstalling picks up where you left off.
#
#   jarvis-uninstall                      remove the app and the logon task, keep data
#   jarvis-uninstall --delete-data --yes  also delete service state, credentials and the data folder
#
# The logon task, the secret store and the command-line wrappers are removed
# by the installed `jarvis` itself, through its platform modules.
# This file is plain ASCII on purpose (see install.ps1).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version 3
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }

$Here = $PSScriptRoot
$Node = Join-Path $Here 'runtime\node.exe'
$Service = Join-Path $Here 'service\jarvis-service.mjs'
function Jarvis { & $Node $Service @args }

# `jarvis-uninstall` passes the install, its state folder and instance as options (a batch file's own
# variables end with it); the JARVIS_* variables are the fallback, as on macOS and Linux.
$Delete = $false
$Yes = $false
$Given = @{}
for ($i = 0; $i -lt $args.Count; $i++) {
  switch ($args[$i]) {
    '--delete-data' { $Delete = $true }
    '--yes' { $Yes = $true }
    { $_ -in '--prefix', '--state-dir', '--instance' } {
      if ($i + 1 -ge $args.Count) { [Console]::Error.WriteLine("$($args[$i]) needs a value"); exit 2 }
      $Given[$args[$i]] = [string]$args[$i + 1]
      $i++
    }
    default { [Console]::Error.WriteLine("Unknown option $($args[$i])"); exit 2 }
  }
}
if ($Given.ContainsKey('--instance')) { $env:JARVIS_INSTANCE = $Given['--instance'] }
if ($Given.ContainsKey('--prefix')) { $env:JARVIS_PREFIX = [IO.Path]::GetFullPath($Given['--prefix']) }
if ($Given.ContainsKey('--state-dir')) { $env:JARVIS_STATE_DIR = [IO.Path]::GetFullPath($Given['--state-dir']) }

if (-not $env:JARVIS_INSTANCE) { $env:JARVIS_INSTANCE = 'default' }
$Prefix = if ($env:JARVIS_PREFIX) { $env:JARVIS_PREFIX } else { [string](Jarvis paths installPrefix) }
# The same state folder the installer chose.
$State = if ($env:JARVIS_STATE_DIR) { $env:JARVIS_STATE_DIR } elseif ($env:JARVIS_PREFIX) { Join-Path $env:JARVIS_PREFIX 'state' } else { [string](Jarvis paths stateDir) }
$Current = Join-Path $Prefix 'current'

if (-not (Test-Path -LiteralPath (Join-Path $Current 'runtime\node.exe'))) {
  [Console]::Error.WriteLine("Jarvis is not installed in ${Prefix}: $Current is missing.")
  exit 1
}
# Run everything from the installed version, as the POSIX uninstaller does.
$Node = Join-Path $Current 'runtime\node.exe'
$Service = Join-Path $Current 'service\jarvis-service.mjs'
$Locks = [string](Jarvis paths locksDir)

$DataFolder = ''
$Owned = @()
$CreatedFolder = $false
if ($Delete) {
  # The data folder and what Jarvis created in it; only those entries are ever deleted, files the owner already had stay.
  $Plan = [string](Jarvis data-folder --state-dir $State)
  if ($LASTEXITCODE -eq 0) {
    $Record = $Plan | ConvertFrom-Json
    if ($Record.dataFolder) { $DataFolder = [string]$Record.dataFolder }
    $CreatedFolder = $Record.createdFolder -eq $true
    $Owned = @($Record.created)
  } else {
    [Console]::Error.WriteLine('Could not tell which data folder this install uses (see the message above), so no data folder will be deleted; remove it yourself if you want it gone.')
  }
}

if ($Delete -and -not $Yes) {
  $What = if ($DataFolder) { " and your data folder $DataFolder" } else { '' }
  $Answer = Read-Host "This deletes Jarvis service state, stored credentials$What. Type DELETE to continue"
  if ($Answer -ne 'DELETE') { Write-Host 'Cancelled; nothing was deleted.'; exit 1 }
}

$null = Jarvis service uninstall
if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine('Could not remove the Jarvis logon task; see the message above.') }

# Harnesses would otherwise keep calling a hook that no longer exists. Only this install's hooks are removed.
# Failures are reported per Harness on stderr; the uninstall carries on either way.
$env:JARVIS_STATE_DIR = $State
$null = Jarvis agent-hooks uninstall --state-dir $State

# The notification sender Jarvis registered for itself goes with the app.
$null = Jarvis notifications forget
if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine('Could not remove the Jarvis notification sender; see the message above.') }

if ($Delete) {
  $null = Jarvis credentials clear --state-dir $State
  if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine('Could not delete every stored credential; see the message above.') }
}

$null = Jarvis wrappers uninstall --prefix $Prefix
# The junction goes first and by itself, so nothing it points at is followed.
if (Test-Path -LiteralPath $Current) { [IO.Directory]::Delete($Current) }
$Apps = Join-Path $Prefix 'app'
# A service that was just stopped can take a moment to exit; Windows refuses to delete a program that still runs.
for ($i = 0; Test-Path -LiteralPath $Apps; $i++) {
  try { Remove-Item -LiteralPath $Apps -Recurse -Force }
  catch {
    if ($i -lt 30) { Start-Sleep -Milliseconds 500; continue }
    [Console]::Error.WriteLine("Could not remove $Apps, because a program is still using it: $($_.Exception.Message) Close each Harness that uses Jarvis (such as Claude Code or Codex) and remove the folder.")
    exit 1
  }
}

function RemoveIfEmpty([string]$Folder) {
  if ((Test-Path -LiteralPath $Folder) -and -not (Get-ChildItem -LiteralPath $Folder -Force)) { Remove-Item -LiteralPath $Folder -Force }
}
RemoveIfEmpty (Join-Path $Prefix 'bin')

if ($Delete) {
  if (Test-Path -LiteralPath $State) { Remove-Item -LiteralPath $State -Recurse -Force }
  if ($DataFolder -and (Test-Path -LiteralPath $DataFolder)) {
    if ($CreatedFolder) {
      Remove-Item -LiteralPath $DataFolder -Recurse -Force
    } else {
      foreach ($Entry in $Owned) {
        $Path = Join-Path $DataFolder $Entry
        if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
      }
      Write-Host "Kept your own files in $DataFolder; removed only what Jarvis created there."
    }
  }
  # Writer locks are released when the service stops; the folder is shared by every instance, so only an empty one goes.
  RemoveIfEmpty $Locks
  RemoveIfEmpty $Prefix
  Write-Host 'Jarvis removed, including its data.'
} else {
  Write-Host "Jarvis removed. Your data folder and service state in $State were kept; reinstall to continue where you left off."
}
exit 0
