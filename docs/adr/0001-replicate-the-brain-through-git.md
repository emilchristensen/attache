---
status: accepted
---

# Replicate the Brain through git

The Brain has to be the same on every Machine its owner works from.
We replicate it through a git repository that each Machine's Jarvis commits to, merges and pushes on its own, because the Brain is Markdown files that the owner also reads and edits by hand, and git keeps that true while adding history and offline work.
Each Machine keeps its own search index and job queue, rebuilt or run locally.

## Considered options

- **A shared online SQL database.**
  It would remove merging and share the review inbox for free, but Markdown would stop being the truth: hand edits, grep and file-and-line citations would go, or need a two-way bridge that brings merging back.
  Writes would also need the network.
- **One hub Jarvis with the other Machines as clients.**
  No merging and one inbox, but it needs an always-on host, network sign-in for a service that only listens on loopback, and it gives no recall when a Machine is offline.
- **A file-sync service on the folder (iCloud, Dropbox, Syncthing).**
  No code, but conflict copies, no history, and nothing to stop two Machines rewriting the same file.

## Consequences

- Two Machines can change the same note while apart, so notes need a merge rule that never leaves conflict markers: per fact the newer date wins and the other value moves to that note's History.
- Evidence that several Machines append to must be written per Machine, so that merges never touch the same file.
- Deleting a note does not remove it from the repository's history.
