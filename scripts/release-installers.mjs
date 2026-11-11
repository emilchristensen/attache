/**
 * The one-step installers: a small script with the release archive appended,
 * which unpacks the archive into a temporary folder and runs the release's
 * own installer from there.
 */

/** macOS and Linux: a shell header; the tarball follows the marker line. */
export function posixInstallerHeader({ version, label, installer, tar }) {
  return `#!/bin/sh
# Jarvis ${version} installer for ${label}. Run: sh "${installer}"
set -eu
WORK="$(mktemp -d "\${TMPDIR:-/tmp}/jarvis-install.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
LINE=$(awk '/^__JARVIS_PAYLOAD__$/ { print NR + 1; exit 0 }' "$0")
tail -n +"$LINE" "$0" | ${tar} -xzf - -C "$WORK"
/bin/sh "$WORK/jarvis-${version}/install.sh"
STATUS=$?
exit $STATUS
__JARVIS_PAYLOAD__
`;
}

const POWERSHELL = "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
/** Room for the payload's byte offset, which is only known once the header is written. */
const OFFSET_DIGITS = 12;

/** What the Windows header runs: copy the zip after the header out, unpack it with .NET, run install.ps1. */
function unpackScript(version, offset) {
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$work = Join-Path ([IO.Path]::GetTempPath()) ('jarvis-install-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($work)
try {
  $zip = Join-Path $work 'jarvis.zip'
  $in = [IO.File]::OpenRead($env:JARVIS_INSTALLER)
  try {
    [void]$in.Seek(${offset}, [IO.SeekOrigin]::Begin)
    $out = [IO.File]::Create($zip)
    try { $in.CopyTo($out) } finally { $out.Dispose() }
  } finally { $in.Dispose() }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory($zip, $work)
  & (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -NoProfile -ExecutionPolicy Bypass -File (Join-Path $work 'jarvis-${version}\\install.ps1')
  $status = $LASTEXITCODE
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
exit $status
`;
}

/**
 * Windows: a batch file whose header is plain ASCII (cmd.exe reads batch
 * files in the console's code page) and finds itself with `%~f0`, so it runs
 * from any folder. cmd.exe stops at `exit /b` and never reads the zip after
 * the marker line. The window waits for a key when the installer was
 * double-clicked, so its messages can be read.
 */
export function windowsInstallerHeader({ version, label, installer }) {
  const header = (offset) => {
    const encoded = Buffer.from(unpackScript(version, String(offset).padStart(OFFSET_DIGITS, "0")), "utf16le").toString("base64");
    return [
      "@echo off",
      `rem Jarvis ${version} installer for ${label}. Double-click ${installer}, or run it in a terminal.`,
      "setlocal",
      'set "JARVIS_INSTALLER=%~f0"',
      `"${POWERSHELL}" -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
      'set "JARVIS_STATUS=%ERRORLEVEL%"',
      'if not "%JARVIS_NO_OPEN%"=="1" pause',
      "exit /b %JARVIS_STATUS%",
      "__JARVIS_PAYLOAD__",
      "",
    ].join("\r\n");
  };
  // The header's length does not depend on the offset written into it, which is padded to a fixed width.
  const text = header(Buffer.byteLength(header(0)));
  if (!/^[\x20-\x7e\r\n]*$/.test(text)) throw new Error("The Windows installer header must be plain ASCII");
  return text;
}

/** `install.cmd` inside the Windows release, for an owner who unpacked the zip by hand. */
export const WINDOWS_INSTALL_CMD = ["@echo off", "setlocal", `"${POWERSHELL}" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*`, 'set "JARVIS_STATUS=%ERRORLEVEL%"', 'if not "%JARVIS_NO_OPEN%"=="1" pause', "exit /b %JARVIS_STATUS%", ""].join("\r\n");
