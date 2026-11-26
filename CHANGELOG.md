# Changelog

What changed in each version of Attache, newest first.
Each section is that release's notes: the release workflow copies it into the GitHub release and into the signed manifest, which the Dashboard shows under What changed.
Write it for owners, in the words of `GLOSSARY.md`.

## 0.7.0-beta.1

**Install this release by hand once.**
Earlier versions of Attache cannot install Updates, so run the installer for your platform over your existing install, as before.
From this release on, Attache keeps itself current.

### What's new

**Automatic updates.**
Each Machine looks for an Update when the service starts and every 6 hours, and installs it on its own when no Job is running.
In Settings, under Updates, you choose per Machine whether Updates install on their own, wait for your click, or are off; Off makes no request at all.

**Update channels.**
Each Machine follows Stable, or Beta, which also takes each Stable release that is newer.
A Machine never moves to an older version.

**Signed releases.**
Every release is built by CI and signed with Attache's own key, and a Machine installs only a release whose signature and checksums match.
An installer run by hand over an existing install checks the same signature before it changes anything.

**Safe rollback.**
When an Update does not start, Attache switches back to the previous version, restores the database from the backup taken just before, and never tries that version again.

**Machines on different versions keep replicating.**
Settings shows each Machine's version.
A Machine that finds Brain files newer than it can read pauses Replication and asks to be updated, instead of changing them.

### Installing

| Platform | File |
| --- | --- |
| macOS (Apple silicon) | `Attache-Installer-0.7.0-beta.1-macos-arm64.command`: double-click it |
| Linux (x86_64 with systemd) | `Attache-Installer-0.7.0-beta.1-linux-x64.sh`: run it with `sh` |
| Windows 10 or 11 (x86_64) | `Attache-Installer-0.7.0-beta.1-windows-x64.cmd`: double-click it |

The installers are not code-signed by Apple or Microsoft, so macOS may ask you to right-click the installer and choose **Open** the first time, and Windows SmartScreen may ask you to confirm.
`SHA256SUMS` lists the checksum of every file.
