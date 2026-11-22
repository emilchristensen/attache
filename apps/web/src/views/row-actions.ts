import { useCallback } from "react";
import type { AttentionDraftBody, AttentionItemView, JobView } from "@attache/contracts";
import { post } from "../api.ts";
import { navigate, useAction } from "../components/ui.tsx";
import { draftHref } from "../routes.ts";
import type { RowActions, RowDecision } from "./InboxRow.tsx";

interface Options {
  /** Ask the list again after a change. */
  reload: () => void;
  /** A decision that takes the item out of the list succeeded: the row stays in its place as one line with Undo. */
  onDecided: (item: AttentionItemView, decision: RowDecision, until: string | null) => void;
  /** Undo succeeded: the item is open again. */
  onUndone?: (item: AttentionItemView) => void;
  /** Before View draft leaves Home, so the list can keep its place. */
  beforeViewDraft?: () => void;
}

/**
 * What an Inbox row and a For you now entry can do, the same in both lists: decide (Start working, Done, Snooze,
 * Dismiss, Reopen), Undo, prepare a Draft and view one. A failure says so in a notification and never leaves a
 * decision looking made; `decide` answers whether it was.
 */
export function useRowActions({ reload, onDecided, onUndone, beforeViewDraft }: Options): { actions: RowActions; undo: (item: AttentionItemView) => void } {
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
  return {
    actions: {
      decide,
      busy: busy !== null,
      prepareDraft: (item) => prepare(item, {}),
      prepareReplacement: (item, draftId) => prepare(item, { replaceUnconfirmed: draftId }),
      viewDraft: (draftId) => {
        beforeViewDraft?.();
        navigate(draftHref(draftId));
      },
    },
    undo,
  };
}
