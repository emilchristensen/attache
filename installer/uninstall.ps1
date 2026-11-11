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

if (-not $env:JARVIS_INSTANCE) { $env:JARVIS_INSTANCE = 'default' }
$Prefix = if ($env:JARVIS_PREFIX) { $env:JARVIS_PREFIX } else { [string](Jarvis paths installPrefix) }
# The same state folder the installer chose: `jarvis-uninstall` passes it on.
$State = if ($env:JARVIS_STATE_DIR) { $env:JARVIS_STATE_DIR } elseif ($env:JARVIS_PREFIX) { Join-Path $env:JARVIS_PREFIX 'state' } else { [string](Jarvis paths stateDir) }
$Current = Join-Path $Prefix 'current'
$Delete = $false
$Yes = $false
foreach ($a in $args) {
  switch ($a) {
    '--delete-data' { $Delete = $true }
    '--yes' { $Yes = $true }
    default { [Console]::Error.WriteLine("Unknown option $a"); exit 2 }
  }
}

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
$Db = Join-Path $State 'jarvis.sqlite'
if ($Delete -and (Test-Path -LiteralPath $Db)) {
  $DataFolder = [string](& $Node -e "const { DatabaseSync } = require('node:sqlite'); try { const d = new DatabaseSync(process.argv[1], { readOnly: true }); const r = d.prepare('select json from config where id = 1').get(); process.stdout.write(r ? (JSON.parse(r.json).dataFolder ?? '') : ''); } catch {}" $Db)
  $OwnedFile = Join-Path $DataFolder '.jarvis\owned.json'
  if ($DataFolder -and (Test-Path -LiteralPath $OwnedFile)) {
    # Only entries Jarvis created are ever deleted; files the owner already had stay.
    $Record = Get-Content -Raw -Encoding UTF8 -LiteralPath $OwnedFile | ConvertFrom-Json
    $CreatedFolder = ($Record.PSObject.Properties.Name -contains 'createdFolder') -and $Record.createdFolder -eq $true
    if ($Record.PSObject.Properties.Name -contains 'created') { $Owned = @($Record.created | Where-Object { $_ -match '^[A-Za-z.][A-Za-z0-9._-]*$' }) }
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

if ($Delete) {
  $null = Jarvis credentials clear --state-dir $State
  if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine('Could not delete every stored credential; see the message above.') }
}

$null = Jarvis wrappers uninstall --prefix $Prefix
# The junction goes first and by itself, so nothing it points at is followed.
if (Test-Path -LiteralPath $Current) { [IO.Directory]::Delete($Current) }
$Apps = Join-Path $Prefix 'app'
if (Test-Path -LiteralPath $Apps) {
  try { Remove-Item -LiteralPath $Apps -Recurse -Force }
  catch { [Console]::Error.WriteLine("Could not remove $Apps, because a program is still using it: $($_.Exception.Message) Close the coding agents that use Jarvis and remove the folder."); exit 1 }
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
