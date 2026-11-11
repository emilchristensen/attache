/**
 * The Windows PowerShell script behind the Credential Manager store. It calls
 * CredRead, CredWrite and CredDelete (advapi32) through a small C# class,
 * because Windows has no command-line tool that reads a stored secret back.
 *
 * Each secret is a generic credential, persisted for this computer only (not
 * roamed), whose target is `dev.jarvis.<instance>/<key>`. Credential Manager
 * holds at most 2,560 bytes per credential, so a longer value continues in
 * `<target>#2`, `<target>#3` and so on. Values travel as base64 of their
 * UTF-8 bytes.
 *
 * Requests (`op`): `probe` writes, reads back and removes a throwaway
 * credential; `read` answers `found` and `secret`; `write` takes `user` and
 * `secret`; `delete` answers `found`.
 */
export const CREDENTIAL_MANAGER_SCRIPT = String.raw`
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class JarvisCredentials {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct Credential {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredWrite(ref Credential credential, uint flags);
  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("advapi32.dll")]
  private static extern void CredFree(IntPtr buffer);

  private const uint Generic = 1;
  private const uint PersistLocalMachine = 2;
  private const int NotFound = 1168;
  private const int PartSize = 2560;

  private static Exception Failure(string what, string target, int code) {
    return new Exception(String.Format("Credential Manager could not {0} {1}: {2} (Windows error {3})", what, target, new Win32Exception(code).Message, code));
  }

  private static string Part(string target, int i) {
    return i == 0 ? target : target + "#" + (i + 1);
  }

  private static byte[] ReadPart(string target) {
    IntPtr found;
    if (!CredRead(target, Generic, 0, out found)) {
      int code = Marshal.GetLastWin32Error();
      if (code == NotFound) return null;
      throw Failure("read", target, code);
    }
    try {
      Credential c = (Credential)Marshal.PtrToStructure(found, typeof(Credential));
      byte[] bytes = new byte[c.CredentialBlobSize];
      if (bytes.Length > 0) Marshal.Copy(c.CredentialBlob, bytes, 0, bytes.Length);
      return bytes;
    } finally {
      CredFree(found);
    }
  }

  private static void WritePart(string target, string user, byte[] value, int offset, int length) {
    IntPtr blob = Marshal.AllocHGlobal(Math.Max(length, 1));
    try {
      Marshal.Copy(value, offset, blob, length);
      Credential c = new Credential();
      c.Type = Generic;
      c.TargetName = target;
      c.UserName = user;
      c.Comment = "Jarvis";
      c.CredentialBlobSize = (uint)length;
      c.CredentialBlob = blob;
      c.Persist = PersistLocalMachine;
      if (!CredWrite(ref c, 0)) throw Failure("write", target, Marshal.GetLastWin32Error());
    } finally {
      for (int i = 0; i < length; i++) Marshal.WriteByte(blob, i, 0);
      Marshal.FreeHGlobal(blob);
    }
  }

  private static bool DeletePart(string target) {
    if (CredDelete(target, Generic, 0)) return true;
    int code = Marshal.GetLastWin32Error();
    if (code == NotFound) return false;
    throw Failure("delete", target, code);
  }

  public static string Read(string target) {
    byte[] first = ReadPart(target);
    if (first == null) return null;
    System.IO.MemoryStream all = new System.IO.MemoryStream();
    all.Write(first, 0, first.Length);
    for (int i = 1; ; i++) {
      byte[] next = ReadPart(Part(target, i));
      if (next == null) break;
      all.Write(next, 0, next.Length);
    }
    return Convert.ToBase64String(all.ToArray());
  }

  public static void Write(string target, string user, string base64) {
    byte[] value = Convert.FromBase64String(base64);
    int parts = Math.Max(1, (value.Length + PartSize - 1) / PartSize);
    // The first part last, so a reader never finds a first part without the rest.
    for (int i = parts - 1; i >= 0; i--) WritePart(Part(target, i), user, value, i * PartSize, Math.Min(PartSize, value.Length - i * PartSize));
    for (int i = parts; DeletePart(Part(target, i)); i++) { }
  }

  public static bool Delete(string target) {
    bool found = DeletePart(target);
    for (int i = 1; DeletePart(Part(target, i)); i++) found = true;
    return found;
  }
}
'@

function Invoke-Request($req) {
  Add-Type -TypeDefinition $source
  $target = [string]$req.target
  switch ([string]$req.op) {
    'read' {
      $secret = [JarvisCredentials]::Read($target)
      if ($null -eq $secret) { return @{ ok = $true; found = $false } }
      return @{ ok = $true; found = $true; secret = $secret }
    }
    'write' {
      [JarvisCredentials]::Write($target, [string]$req.user, [string]$req.secret)
      return @{ ok = $true }
    }
    'delete' {
      return @{ ok = $true; found = [JarvisCredentials]::Delete($target) }
    }
    'probe' {
      $value = [Convert]::ToBase64String([Guid]::NewGuid().ToByteArray())
      try {
        [JarvisCredentials]::Write($target, [string]$req.user, $value)
        $back = [JarvisCredentials]::Read($target)
      } finally {
        $null = [JarvisCredentials]::Delete($target)
      }
      if ($back -ne $value) { return @{ ok = $false; error = 'Credential Manager returned a different value than was stored' } }
      return @{ ok = $true }
    }
  }
  return @{ ok = $false; error = "unknown request $($req.op)" }
}
`;
