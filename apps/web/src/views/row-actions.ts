import { useCallback, useEffect, useRef } from "react";
import type { AttentionDraftBody, AttentionItemView, JobView } from "@attache/contracts";
import { post } from "../api.ts";
import { navigate, useAction } from "../components/ui.tsx";
import { firstStepFor } from "../inbox-first-step.ts";
import { openDraftId } from "../linked-draft.ts";
import { draftHref } from "../routes.ts";
import type { RowActions, RowDecision, RowPlace } from "./InboxRow.tsx";

interface Options {
  /** Ask the list again after a change. */
  reload: () => void;
  /** A decision that takes the item out of the list succeeded: the row stays in its place as one line with Undo. */
  onDecided: (item: AttentionItemView, decision: RowDecision, until: string | null) => void;
  /** Undo succeeded: the item is open again. */
  onUndone?: (item: AttentionItemView) => void;
  /** Before View draft leaves Home, so the list can keep its place. */
  beforeViewDraft?: () => void;
  /** Whether the owner can prepare Drafts, so Start working on a draftable item prepares one. */
  draftsOn: boolean;
}

/** Meeting prep the owner has not read yet: opening it records that they started on it. */
export const unreadPrep = (item: AttentionItemView) => item.kind === "meeting_prep" && item.state === "open" && !item.startedAt;

/**
 * What an Inbox row and a For you now entry can do, the same in both lists: decide (Start working, Done, Snooze,
 * Dismiss, Reopen), Start working's first step, Undo, prepare a Draft and view one. A failure says so in a
 * notification and never leaves a decision looking made; `decide` answers whether it was.
 */
export function useRowActions({ reload, onDecided, onUndone, beforeViewDraft, draftsOn }: Options): { actions: RowActions; undo: (item: AttentionItemView) => void } {
  const { busy, run } = useAction();
  const decide = useCallback(
    async (item: AttentionItemView, decision: RowDecision, until?: string): Promise<boolean> => {
      const done = await run(`decide:${item.id}`, async () => {
        await post(`/attention/${item.id}/decision`, { decision, ...(until ? { until } : {}) });
        // Marked before the list is asked again, so only a later answer can retire the line. Start working and Not
        // started (a reopen of an open item) only change its tag: the row stays a row.
        if (decision !== "start" && !(decision === "reopen" && item.state === "open")) onDecided(item, decision, until ?? null);
        reload();
        return true;
      });
      return done === true;
    },
    [run, onDecided, reload],
  );
  const undo = (item: AttentionItemView) =>
    void run(`undo:${item.id}`, async () => {
      await post(`/attention/${item.id}/decision`, { decision: "reopen" });
      onUndone?.(item);
      reload();
    });
  const prepare = (item: AttentionItemView, body: AttentionDraftBody) =>
    void run(
      "draft",
      async () => {
        await post<{ job: JobView }>(`/attention/${item.id}/draft`, body);
        reload();
      },
      body.replaceUnconfirmed ? "Preparing a replacement Draft in the background" : "Preparing a draft in the background",
    );
  const viewDraft = (draftId: string) => {
    beforeViewDraft?.();
    navigate(draftHref(draftId));
  };
  const prepareDraft = (item: AttentionItemView) => prepare(item, {});
  /**
   * Start working, from the button or the `w` key: marks the item in progress and takes the first step for its kind
   * (`inbox-first-step.ts`). A waiting Draft opens first; the source or the event opens in a new tab at once, while
   * the key or click still allows it; meeting prep and every other kind open the row in place. Opening unread meeting
   * prep records the start itself (`useReadPrep`), so it is not recorded twice.
   */
  const start = async (item: AttentionItemView, row: RowPlace): Promise<void> => {
    const draftId = openDraftId(item);
    const step = firstStepFor(item);
    const elsewhere = !draftId && (step === "source" || step === "calendar") && item.url ? item.url : null;
    if (elsewhere) window.open(elsewhere, "_blank", "noopener,noreferrer");
    if (!draftId && !row.open && unreadPrep(item)) return row.openRow();
    if (!(await decide(item, "start")) || elsewhere) return;
    if (draftId) viewDraft(draftId);
    else if (step === "draft" && draftsOn) prepareDraft(item);
    else if (!row.open) row.openRow();
  };
  return {
    actions: {
      decide,
      start,
      busy: busy !== null,
      prepareDraft,
      prepareReplacement: (item, draftId) => prepare(item, { replaceUnconfirmed: draftId }),
      viewDraft,
    },
    undo,
  };
}

/**
 * Opening unread meeting prep, by any route (its row, Start working, the `w` key, a briefing's entry), is reading it:
 * the `start` decision is recorded once as the row opens, so the prep leaves For you now on every page and Machine.
 * A later Not started while the row stays open is the owner's word and is not undone.
 */
export function useReadPrep(item: AttentionItemView, open: boolean, decide: RowActions["decide"]): void {
  const recorded = useRef(false);
  const unread = unreadPrep(item);
  useEffect(() => {
    if (!open) {
      recorded.current = false;
      return;
    }
    if (recorded.current) return;
    recorded.current = true;
    if (unread) void decide(item, "start");
  }, [open, unread, item, decide]);
}
