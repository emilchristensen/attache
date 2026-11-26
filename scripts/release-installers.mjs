/**
 * The one-step installers: a small script followed by the release's signed
 * manifest, its signature and the release archive. The script copies the
 * three back out into a temporary folder, the same release folder the build
 * wrote, unpacks the archive there and runs the release's own installer. Run
 * over an existing install, that installer has the installed version check
 * the folder against the signed manifest before it changes anything.
 */
import { manifestFileName, signatureFileName } from "../apps/service/src/release/manifest.ts";
import { RELEASE_TARGETS, releaseArchive } from "./release-targets.mjs";

/**
 * A header whose text names the byte offsets of the payload after it. The
 * offsets depend on the header's own length, so it is written until the
 * length it names is the length it has (two rounds at most, as digits are added).
 */
function headerFor(text, payload) {
  let length = 0;
  for (;;) {
    const parts = { manifest: { offset: length, length: payload.manifest.length }, signature: { offset: length + payload.manifest.length, length: payload.signature.length }, archive: { offset: length + payload.manifest.length + payload.signature.length } };
    const header = text(parts);
    const actual = Buffer.byteLength(header);
    if (actual === length) return header;
    length = actual;
  }
}

/** macOS and Linux: a POSIX shell script; `dd` and `tail` copy the parts out, the system's tar unpacks the archive. */
function posixHeader({ version, target, names }, parts) {
  const t = RELEASE_TARGETS[target];
  const installer = t.installer(version);
  return `#!/bin/sh
# Attache ${version} installer for ${t.label}. Run: sh "${installer}"
# After this script: the signed release manifest, its signature and the release archive.
set -eu
WORK="$(mktemp -d "\${TMPDIR:-/tmp}/attache-install.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
dd if="$0" of="$WORK/${names.manifest}" bs=1 skip=${parts.manifest.offset} count=${parts.manifest.length} 2>/dev/null
dd if="$0" of="$WORK/${names.signature}" bs=1 skip=${parts.signature.offset} count=${parts.signature.length} 2>/dev/null
tail -c +${parts.archive.offset + 1} "$0" > "$WORK/${names.archive}"
${t.tar} -xzf "$WORK/${names.archive}" -C "$WORK"
/bin/sh "$WORK/attache-${version}/install.sh"
STATUS=$?
exit $STATUS
__ATTACHE_PAYLOAD__
`;
}

const POWERSHELL = "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

/** What the Windows header runs: copy the three parts out, unpack the zip with .NET, run install.ps1. */
function unpackScript(version, names, parts) {
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$work = Join-Path ([IO.Path]::GetTempPath()) ('attache-install-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($work)
function Copy-Part($From, [string]$Name, [long]$Count) {
  $out = [IO.File]::Create((Join-Path $work $Name))
  try {
    $buffer = New-Object byte[] 1048576
    while ($Count -ne 0) {
      $n = $From.Read($buffer, 0, $(if ($Count -lt 0 -or $Count -gt $buffer.Length) { $buffer.Length } else { [int]$Count }))
      if ($n -le 0) { if ($Count -lt 0) { break }; throw 'The installer file is incomplete. Download it again.' }
      $out.Write($buffer, 0, $n)
      if ($Count -gt 0) { $Count -= $n }
    }
  } finally { $out.Dispose() }
}
try {
  $in = [IO.File]::OpenRead($env:ATTACHE_INSTALLER)
  try {
    [void]$in.Seek(${parts.manifest.offset}, [IO.SeekOrigin]::Begin)
    Copy-Part $in '${names.manifest}' ${parts.manifest.length}
    Copy-Part $in '${names.signature}' ${parts.signature.length}
    Copy-Part $in '${names.archive}' -1
  } finally { $in.Dispose() }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $work '${names.archive}'), $work)
  & (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -NoProfile -ExecutionPolicy Bypass -File (Join-Path $work 'attache-${version}\\install.ps1')
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
 * from any folder. cmd.exe stops at `exit /b` and never reads the payload after
 * the marker line. The window waits for a key when the installer was
 * double-clicked, so its messages can be read.
 */
function windowsHeader({ version, target, names }, parts) {
  const t = RELEASE_TARGETS[target];
  const encoded = Buffer.from(unpackScript(version, names, parts), "utf16le").toString("base64");
  const text = [
    "@echo off",
    `rem Attache ${version} installer for ${t.label}. Double-click ${t.installer(version)}, or run it in a terminal.`,
    "setlocal",
    'set "ATTACHE_INSTALLER=%~f0"',
    `"${POWERSHELL}" -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
    'set "ATTACHE_STATUS=%ERRORLEVEL%"',
    'if not "%ATTACHE_NO_OPEN%"=="1" pause',
    "exit /b %ATTACHE_STATUS%",
    "__ATTACHE_PAYLOAD__",
    "",
  ].join("\r\n");
  if (!/^[\x20-\x7e\r\n]*$/.test(text)) throw new Error("The Windows installer header must be plain ASCII");
  return text;
}

/**
 * The one-step installer for a target: its header, then the manifest, the
 * signature and the archive, byte for byte as the release folder holds them.
 */
export function oneStepInstaller({ version, target, manifest, signature, archive }) {
  const names = { manifest: manifestFileName(version), signature: signatureFileName(version), archive: releaseArchive(version, target) };
  const header = headerFor((parts) => (RELEASE_TARGETS[target].os === "windows" ? windowsHeader : posixHeader)({ version, target, names }, parts), { manifest, signature });
  return Buffer.concat([Buffer.from(header), manifest, signature, archive]);
}

/** `install.cmd` inside the Windows release, for an owner who unpacked the zip by hand. */
export const WINDOWS_INSTALL_CMD = ["@echo off", "setlocal", `"${POWERSHELL}" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*`, 'set "ATTACHE_STATUS=%ERRORLEVEL%"', 'if not "%ATTACHE_NO_OPEN%"=="1" pause', "exit /b %ATTACHE_STATUS%", ""].join("\r\n");
