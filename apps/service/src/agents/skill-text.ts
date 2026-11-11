/**
 * The instructions behind the user-invoked `save` and `audit` skills Jarvis
 * installs in coding agents. `cli` is this install's own command, pinned to
 * its state folder, so a skill works without `jarvis` on PATH.
 */
export interface SkillText {
  /** Suffix after the owner key: `jarvis-save`, `jarvis-audit`. */
  id: "save" | "audit";
  description: string;
  body: string;
}

export function saveSkill(cli: string): SkillText {
  return {
    id: "save",
    description: "Distill the important parts of the last turn into Jarvis memory. Only when the user explicitly invokes it.",
    body: `# Save to Jarvis

The user wants what matters from the last turn kept in Jarvis, their second brain.
The last turn is their most recent request before this command, and your work and answer to it.
Text the user wrote after the command says what to focus on.

## Decide what is worth keeping

Keep what a future session would need and could not get from the code or git history:

- decisions, with the reason and the alternatives that were rejected
- lessons that should change how the next piece of work is done
- current facts about people and projects: status, owner, deadline, where something lives, who to ask
- commitments made to or by someone

Leave out the play-by-play of what you did, anything temporary, anything Jarvis already has unchanged, and every secret, token or password.
If nothing is worth keeping, say so and save nothing.
Three precise items beat ten vague ones.

## Sort each item into state or event

- A **fact** has one current value that can change (a status, an owner, a decision in force).
  It goes in \`facts\` as a subject and value; saving replaces the subject's old value and Jarvis moves the old one to History.
- An **event** is something that happened (a meeting, a slip, a fix that shipped).
  It goes in \`events\` and is appended to History, never replacing anything.

Write every value so it makes sense months from now without this conversation.
Name the project, the person and the system, use absolute dates (YYYY-MM-DD), and never write "this", "today" or "the bug".

## Update before you create

Search Jarvis for every person, project and decision you are about to save:

    ${cli} search "<topic>"

When a note under \`memory/\` already covers it, update that note by its path (the part from \`memory/\` on).
Jarvis refuses a second note with the same type and title.
Note types are \`person\`, \`project\`, \`decision\` and \`note\`.
A decision gets its own decision note with the subject \`Decision\` and the reasoning in \`notes\`; also add an event to the project it belongs to, when there is one.

## Save

Pass every item in one call; Jarvis checks them all and writes nothing if any is wrong:

    ${cli} save <<'JSON'
    {
      "items": [
        { "action": "create", "type": "decision", "title": "…", "facts": [{ "subject": "Decision", "value": "…" }], "notes": "Why, and what was rejected", "events": ["…"] },
        { "action": "update", "path": "memory/projects/….md", "facts": [{ "subject": "Status", "value": "…", "reason": "what changed" }], "events": ["…"] }
      ]
    }
    JSON

Jarvis records which agent session the items came from.
Never write files in the Jarvis data folder yourself; \`save\` is the only way in.
If \`save\` fails, read its message, fix the items and run it again.
If Jarvis is not running, say so and show the user the command to start it, \`jarvis start\`.

## Report

List each saved note, one line each: created or updated, its title, and its path.
Then, in one sentence, say what you chose to leave out, if anything.
`,
  };
}

export function auditSkill(cli: string): SkillText {
  return {
    id: "audit",
    description: "Audit Jarvis memory for facts that have quietly stopped being true, and fix the worst. Only when the user explicitly invokes it.",
    body: `# Audit Jarvis memory

Memory rots quietly: a fact stops being true, the note keeps saying it, and every new session repeats it.
Find those facts, show the user the worst ones, and fix what they agree to.
Text the user wrote after the command narrows the audit to a topic.

Every Jarvis note has a \`## Current State\` section with one dated entry per subject, which a correction replaces, and an append-only \`## History\`.
The structure already separates state from events, so the audit is about whether each current value is still true.

## 1. Run the report

    ${cli} audit

It lists every current fact with its date, age, source and flags, plus newer passages about that fact.
Notes marked "first fact in every session's index" are the ones every new agent session reads; check those first, because a stale fact there misleads every session.
Pass \`--stale-days <n>\` to change when a fact counts as stale (60 by default) and \`--json\` for structured output.

The flags are leads, not verdicts:

- \`stale\`: not re-dated for longer than the threshold. Old is not the same as wrong.
- \`unsourced\`: nothing records where the fact came from.
- \`missing-source\`: the file it cites is gone.
- \`duplicate-subject\`: the note has two current values for one subject.
- \`newer:\` lines: passages dated after the fact that name the note, found by searching for the note and the fact's subject. This is where contradictions show up.

The counts line is deterministic; quote it, so the next audit can be compared with this one.

## 2. Judge each fact

For every fact with newer evidence, and every stale fact in the session index, read the newer documents at the cited lines and put it in one pile:

- **Contradicted:** something newer disagrees. This is rot, and the headline.
- **Unsupported:** nothing backs it up. Often it was true once and the evidence was never written down.
- **Confirmed:** newer evidence agrees.

Also look for what the report cannot see: a project marked active whose history records it being cancelled, or two notes that describe the same thing under different names.
Search when you need more context:

    ${cli} search "<topic>"

## 3. Report

Lead with the single most damaging finding, for example: "The session index says the Orion cutover is in October; the 2026-09-12 session log says it moved to November."
Then list the contradicted facts, then the unsupported ones, each with the note path, the current value, and the evidence path and line.
List possible duplicate notes, but never merge them yourself; a wrong merge loses information.
Say plainly when a value that should be in memory was never written down anywhere, because no correction can fix that.

## 4. Fix what the user agrees to

Propose each correction as one \`save\` payload and show it to the user first.
Every fact needs a \`reason\` that cites the evidence; Jarvis moves the old value to History with that reason:

    ${cli} save <<'JSON'
    { "items": [ { "action": "update", "path": "memory/projects/….md", "facts": [{ "subject": "Status", "value": "…", "reason": "Superseded by evidence/sessions/2026-09-12.md:14" }] } ] }
    JSON

Apply it only after the user says yes, and only the corrections they accept.
For an unsupported fact, ask the user for the current value rather than guessing.
Never edit files in the data folder directly.
The identity record (\`memory/self.md\`) can only be changed in Jarvis Settings; point the user there.
Afterwards, run \`${cli} audit\` again and report how the counts moved.
`,
  };
}
