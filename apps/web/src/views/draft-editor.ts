import { useCallback, useEffect, useState } from "react";
import type { ActionView } from "@attache/contracts";
import { draftBodyKey } from "../approvals.ts";
import type { DraftEditor } from "../draft-state.ts";

/** The stored text of a Draft. */
export const storedText = (d: Pick<ActionView, "kind" | "payload">): string => {
  const body = d.payload[draftBodyKey(d.kind)];
  return typeof body === "string" ? body : "";
};

interface Base {
  version: number;
  text: string;
}

export interface DraftEditorState {
  text: string;
  setText: (text: string) => void;
  /** What `draft-state.ts` needs: unsaved, blank, and the version the text started from. */
  editor: DraftEditor;
  /** Take the stored Draft into the editor, dropping any unsaved text (Load vN, Discard changes, after a save). */
  load: (d: ActionView) => void;
}

/**
 * The text box beside a Draft: it follows the stored text while nothing is typed, and holds the owner's words when
 * the Draft changes under them, so the page can offer to copy them (Changed elsewhere) instead of dropping them.
 */
export function useDraftEditor(d: ActionView | null): DraftEditorState {
  const [base, setBase] = useState<Base | null>(null);
  const [text, setText] = useState("");
  const dirty = base !== null && text !== base.text;
  useEffect(() => {
    if (!d || dirty) return;
    const stored = storedText(d);
    setBase((b) => (b && b.version === d.version && b.text === stored ? b : { version: d.version, text: stored }));
    setText(stored);
  }, [d, dirty]);
  const load = useCallback((next: ActionView) => {
    const stored = storedText(next);
    setBase({ version: next.version, text: stored });
    setText(stored);
  }, []);
  return { text, setText, editor: { dirty, empty: !text.trim(), baseVersion: base?.version ?? d?.version ?? 0 }, load };
}
