---
status: accepted
---

# Preferences replicate with the Brain

Until now Replication carried the Brain and nothing else, and every setting was one Machine's configuration.
With Home becoming a layout of widgets the owner arranges (#77), we add Preferences: the owner's choices about how Attache looks and behaves, kept as files in the data folder so that they replicate to every Machine.
The owner arranges Attache once and expects to find it that way on whichever Machine they open, the same reason there is one Brain rather than two (ADR 0002).

## Considered options

- **Keep the layout per Machine, in the service's database.**
  Fits a layout to the screen in front of the owner, but every new Machine starts from the default and the owner arranges Home again on each one.
- **Keep it in the browser.**
  Simplest, but lost with the browser's data and different in every browser paired to the same Machine.

## Consequences

- A Machine's configuration stays on that Machine and never becomes a Preference: sign-ins and secrets, which Machine is the Reader, the data folder, schedules that only the Reader runs.
- A Preference is replaced as a whole and the version saved last wins; two Machines' versions are never merged field by field.
- Preferences are not the Brain: recall never indexes them, and a change to one is not a change to the Brain that needs review or can be reverted from Recent saves.
- The Home layout is the first Preference.
  Moving an existing setting into Preferences is decided setting by setting.
