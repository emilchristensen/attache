---
status: accepted
---

# The whole Brain replicates to every Machine

The Brain can hold confidential work material next to personal notes, such as notes about named people, client facts and meeting transcripts.
We replicate all of it, in plaintext, to a private repository on the owner's personal GitHub account and to every Machine the owner adds, including personally owned hardware, because the owner works from those Machines as much as from the work laptop and wants one Brain rather than two.
Attache refuses to push when the repository is public.

## Considered options

- **Two parts, work and personal, with personal Machines replicating only the personal part.**
  Keeps work material on work hardware, but splits the Brain and leaves half of it unreachable from the home Machine.
- **Replicate everything but encrypt it in the repository.**
  GitHub would hold only ciphertext, but every Machine still holds plaintext, and it adds a key to distribute.

## Consequences

- Do not narrow what replicates, or add encryption, without the owner deciding it again: this was chosen on purpose.
- A secret scan before every commit matters more, since the repository is the one copy outside the owner's Machines.
