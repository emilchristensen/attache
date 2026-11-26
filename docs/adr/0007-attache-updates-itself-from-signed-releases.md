---
status: accepted
---

# Attache updates itself from signed releases

Attache's owners are knowledge workers, not developers, and an Update nobody installs fixes nothing, so Automatic updates install on their own by default; the owner can switch a Machine to ask first, or off, where it never looks for Updates.
Because an Update then reaches every Machine without anyone running anything, a tampered release would too, so every release carries a manifest of its artifacts' SHA-256 checksums signed with one Ed25519 key, and a Machine installs only what that signature covers.
A Machine never moves to an older version, so an old release with a known flaw cannot be pushed back onto it.

## Considered options

- **Trust HTTPS from GitHub alone, or the `SHA256SUMS` already in each release.**
  Both catch a broken download, but whoever can replace a release asset can replace its checksum too.
- **GitHub artifact attestations (Sigstore).**
  No key to keep, but a heavier verifier in the service and a trust root that itself needs updating.
- **Ask first by default.**
  Keeps the owner's hand on every install, but most Machines would sit on old versions.

## Consequences

- Releases are published only by the release workflow in CI, from a tag; the signing key lives in a protected GitHub Actions environment, with an offline backup, and never on a laptop.
- The release workflow publishes only a commit that passed the full CI run, the install test included, since a broken release would otherwise reach every Machine on its own.
- The public key is built into every installed copy.
  It is rotated by a manifest, signed with the current key, that names the next one.
  If the key is lost or leaked, every Machine needs one manual install to take a new key.
- An installer run over an existing install checks the new release with the key the installed version holds; a first install has nothing to check against and trusts the download, as before.
- Releases remain without code signing or notarisation; this signature is Attache's own.
