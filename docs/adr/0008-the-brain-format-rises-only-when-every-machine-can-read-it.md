---
status: accepted
---

# The Brain format rises only when every Machine can read it

Replicated files (notes, evidence, Inbox items, Machine records, Preferences) carry a Brain format version, and with a Beta Update channel, Machines running different versions are normal.
A change to the format ships in two steps: one release learns to read the new format, and a later one writes it, and a Machine writes the new format only once every active Machine's record says it can read it.
A Machine not heard from in 30 days does not count; if it returns to a format it does not understand, it pauses Replication without writing and asks to be updated.

## Considered options

- **The first Machine to update raises the format at once.**
  Simple, but a Beta Machine would stop every Stable Machine from replicating until the change reached Stable, possibly weeks later.
- **No format version.**
  An older Machine would misread newer files, and its merge could quietly damage them.

## Consequences

- Each Machine record carries the Machine's version and the newest Brain format it can read.
- A Machine rewriting a file keeps the fields it does not understand.
- The SQLite database and the Machine's configuration never replicate, so their migrations stay per Machine and are not governed by this rule.
