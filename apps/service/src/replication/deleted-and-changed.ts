import { createHash } from "node:crypto";
import { basename } from "node:path";
import { parseMarkdown } from "../memory/markdown.ts";
import type { MergeInput, MergeOutcome, MergeRule } from "./seams.ts";

/** The `MergeNotice.kind` this rule raises. */
export const DELETED_AND_CHANGED = "deleted_and_changed";

function noteTitle(path: string, content: string): string {
  try {
    return parseMarkdown(content, basename(path, ".md")).title;
  } catch {
    return basename(path, ".md");
  }
}

/**
 * A note one Machine deleted while another changed it. Deleting loses less
 * when it is undone than a change does, so the changed note is kept on every
 * Machine and the owner is told, to delete it again if that still holds.
 * It settles only that case; a note both sides changed goes to the next rule.
 */
export const deletedAndChangedRule: MergeRule = {
  name: "deleted-and-changed",
  appliesTo: (path) => path.toLowerCase().endsWith(".md"),
  merge(input: MergeInput): MergeOutcome | null {
    const { path, base, ours, theirs, local, remote } = input;
    if (base === null || (ours === null) === (theirs === null)) return null;
    const kept = (ours ?? theirs)!;
    const [deletedOn, changedOn] = ours === null ? [local.name, remote.name] : [remote.name, local.name];
    const title = noteTitle(path, kept);
    return {
      content: kept,
      notices: [
        {
          path,
          kind: DELETED_AND_CHANGED,
          message: `"${title}" was deleted on ${deletedOn} and changed on ${changedOn} before either Machine saw the other's change. Attache kept the changed note on every Machine; delete it again if it should go.`,
          title: `Kept "${title}": deleted on one Machine, changed on another`,
          version: createHash("sha256").update(kept).digest("hex").slice(0, 16),
        },
      ],
    };
  },
};
