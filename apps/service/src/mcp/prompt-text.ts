import { WRAP_UP_POINTS_MAX } from "@attache/contracts";

/**
 * The save, audit and wrap-up procedures a Harness offers its user as MCP prompts.
 * They replace the `save` and `audit` skills Attache used to install: the same
 * procedure, with Attache's MCP tools (`search`, `read`, `save`, `audit`) in
 * place of shell commands.
 */

const SAVE_EXAMPLE = [
  "```json",
  '{ "items": [',
  '  { "action": "create", "type": "decision", "title": "…", "facts": [{ "subject": "Decision", "value": "…" }], "notes": "Why, and what was rejected", "events": ["…"] },',
  '  { "action": "update", "path": "memory/projects/….md", "facts": [{ "subject": "Status", "value": "…", "reason": "what changed", "review": "2026-12-15" }], "events": ["…"] }',
  "] }",
  "```",
].join("\n");

const CORRECTION_EXAMPLE = [
  "```json",
  '{ "items": [',
  '  { "action": "update", "path": "memory/projects/….md", "facts": [{ "subject": "Status", "value": "…", "reason": "Superseded by evidence/sessions/2026-09-12.md:14" }] }',
  "] }",
  "```",
].join("\n");

/** The tool the wrap-up prompt asks the agent to call (registered in `wrap-up-tool.ts`). */
export const WRAP_UP_TOOL = "wrap_up";

const HANDS_OFF = "Never write, edit or delete files in the Brain yourself; Attache's tools are the only way in.";

const SAVE_BODY = `# Save to Attache

The owner wants what matters from the last turn kept in Attache, their Brain.
The last turn is their most recent request before this prompt, and your work and answer to it.

## Decide what is worth keeping

Keep what a future session would need and could not get from the code or git history:

- decisions, with the reason and the alternatives that were rejected
- lessons that should change how the next piece of work is done
- current facts about people and projects: status, owner, deadline, where something lives, who to ask
- commitments made to or by someone

Leave out the play-by-play of what you did, anything temporary, anything Attache already has unchanged, and every secret, token or password.
If nothing is worth keeping, say so and save nothing.
Three precise items beat ten vague ones.

## Sort each item into a fact or an event

- A **fact** has one current value that can change (a status, an owner, a decision in force).
  It goes in \`facts\` as a subject and value; saving replaces the subject's old value and Attache moves the old one to History.
- An **event** is something that happened (a meeting, a slip, a fix that shipped).
  It goes in \`events\` and is appended to History, never replacing anything.

A fact you expect to change, such as a status, a plan or a deadline, can carry a Review date: \`review\`, a day (YYYY-MM-DD) after today, after which it should be checked again.
Past that day Attache keeps the fact but shows it as unverified.
Leave it out for facts that stay true, such as a repository's name; a correction without one clears the old Review date.

Write every value so it makes sense months from now without this conversation.
Name the project, the person and the system, use absolute dates (YYYY-MM-DD), and never write "this", "today" or "the bug".

## Update before you create

Search the Brain with the \`search\` tool for every person, project and decision you are about to save.
When a note under \`memory/\` already covers it, update that note by the path \`search\` returned (the part from \`memory/\` on); use \`read\` when you need the whole note.
Attache refuses a second note with the same type and title.
Note types are \`person\`, \`project\`, \`decision\` and \`note\`.
A decision gets its own decision note with the subject \`Decision\` and the reasoning in \`notes\`; also add an event to the project it belongs to, when there is one.

## Save

Call the \`save\` tool once with every item; Attache checks them all and writes nothing if any is wrong.
Its arguments look like this:

${SAVE_EXAMPLE}

Attache asks the owner to confirm the items before it writes them, and records which Harness and session they came from.
If the owner switched on auto-accept for this Harness, Attache writes them without asking; the reply says so.
If the owner declines, nothing is saved: say so, and do not call the tool again unless they ask.
If the reply says the items await review, tell the owner they can approve them in the Attache Dashboard.
If the tool returns an error, read its message, fix the items and call it again.
If it says Attache is not running, pass that message on to the owner.
${HANDS_OFF}

## Report

List each saved note, one line each: created or updated, its title, and its path.
Then, in one sentence, say what you chose to leave out, if anything.
`;

const AUDIT_BODY = `# Audit Attache memory

Memory rots quietly: a fact stops being true, the note keeps saying it, and every new session repeats it.
Find those facts, show the owner the worst ones, and fix what they agree to.

Every Attache note has a \`## Current State\` section with one dated entry per subject, which a correction replaces, and an append-only \`## History\`.
The structure already separates state from events, so the audit is about whether each current value is still true.

## 1. Get the report

Call the \`audit\` tool.
It lists every current fact with its date, Review date, age, source and flags, plus newer passages about that fact.
Notes marked "in a project's session context" are the ones every new session in that project reads; check those first, because a stale fact there misleads every one of those sessions.

The flags are leads, not verdicts:

- \`stale\`: past its Review date, the day it was due to be checked again. A fact without a Review date is never stale, however old it is.
- \`unsourced\`: nothing records where the fact came from.
- \`missing-source\`: the file it cites is gone.
- \`duplicate-subject\`: the note has two current values for one subject.
- \`newer:\` lines: passages dated after the fact that name the note, found by searching for the note and the fact's subject. This is where contradictions show up.

The counts line is deterministic; quote it, so the next audit can be compared with this one.

## 2. Judge each fact

For every fact with newer evidence, and every stale fact, read the newer passages at the cited lines with the \`read\` tool and put the fact in one pile:

- **Contradicted:** something newer disagrees. This is rot, and the headline.
- **Unsupported:** nothing backs it up. Often it was true once and the evidence was never written down.
- **Confirmed:** newer evidence agrees.

Also look for what the report cannot see: a project marked active whose history records it being cancelled, or two notes that describe the same thing under different names.
Use the \`search\` tool when you need more context.

## 3. Report

Lead with the single most damaging finding, for example: "The Orion session context says the cutover is in October; the 2026-09-12 session log says it moved to November."
Then list the contradicted facts, then the unsupported ones, each with the note path, the current value, and the evidence path and line.
List possible duplicate notes, but never merge them yourself; a wrong merge loses information.
Say plainly when a value that should be in memory was never written down anywhere, because no correction can fix that.

## 4. Fix what the owner agrees to

Show each correction to the owner first, as the item you would pass to the \`save\` tool.
Every fact needs a \`reason\` that cites the evidence; Attache moves the old value to History with that reason:

${CORRECTION_EXAMPLE}

Make the corrections through the \`save\` tool only after the owner says yes, and only the ones they accept.
Attache then asks the owner to confirm the save once more before it writes, unless they switched on auto-accept for this Harness.
For an unsupported fact, ask the owner for the current value rather than guessing.
A stale fact the owner confirms is still true is saved again with the same value and a later Review date; a correction without one clears it.
${HANDS_OFF}
The identity record (\`memory/self.md\`) can only be changed in Attache Settings; point the owner there.
Afterwards, call the \`audit\` tool again and report how the counts moved.
`;

/** What the owner typed with the prompt, as a last line the agent cannot miss. */
function withRequest(body: string, label: string, request: string | undefined): string {
  const text = request?.trim();
  return text ? `${body}\n${label}: ${text}\n` : body;
}

export function savePrompt(focus?: string): string {
  return withRequest(SAVE_BODY, "Focus on", focus);
}

export function auditPrompt(topic?: string): string {
  return withRequest(AUDIT_BODY, "Limit the audit to", topic);
}

/**
 * What the agent is asked to do when the owner runs the wrap-up prompt. It is
 * meant for conversations Attache cannot capture itself, such as Claude
 * Desktop's Chat tab: the agent distils them, and `wrap_up` stores the result
 * as evidence.
 */
const WRAP_UP_BODY = [
  "Wrap up this conversation for Attache.",
  "",
  "Read back over the conversation so far and pick out its durable points: what will still matter in a week or a month.",
  "That means decisions and why they were made, facts about people, projects and the owner's work, commitments with who owns them and by when, and preferences the owner stated.",
  "Leave out small talk, the step-by-step of the work itself, and anything secret such as passwords, tokens or keys.",
  "",
  "Write each point as one sentence that makes sense without the conversation: name the people and projects, and write dates as YYYY-MM-DD.",
  `Keep to the points that matter, at most ${WRAP_UP_POINTS_MAX}.`,
  "",
  `Then call the \`${WRAP_UP_TOOL}\` tool once, with a short \`title\` for the conversation and the points.`,
  "Attache stores them in the Brain as evidence of this conversation, not as curated memory: none of them becomes a current fact unless it is saved to a note later.",
  "",
  `If the conversation holds nothing durable, call \`${WRAP_UP_TOOL}\` with an empty \`points\` list: Attache stores nothing.`,
  "",
  "Finish by telling the owner in a line or two what was stored and where, or that there was nothing durable to store.",
].join("\n");

export function wrapUpPrompt(): string {
  return WRAP_UP_BODY;
}
