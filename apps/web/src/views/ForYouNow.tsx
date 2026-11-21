import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { AttentionDraftBody, AttentionItemView, BriefingView, JobView } from "@attache/contracts";
import { post } from "../api.ts";
import { useResource } from "../live.ts";
import { useSignals } from "../nav-signals.ts";
import type { HeadsUpClock } from "../heads-up-clock.ts";
import { curateForYouNow, type ForYouNowResult } from "../for-you-now.ts";
import { useHold } from "../hold.ts";
import { navigate } from "../components/ui.tsx";
import { draftHref } from "../routes.ts";
import { InboxRow, type RowActions, type RowDecision } from "./InboxRow.tsx";

function useLatestBriefing(enabled: boolean) {
  const r = useResource<{ briefing: BriefingView | null }>(enabled ? "/briefings/latest" : null, ["briefing.created"]);
  return { briefing: r.data?.briefing ?? null, failed: !!r.error, retry: r.reload };
}

function useFrozenResult(live: ForYouNowResult, held: boolean) {
  const frozen = useRef(live);
  if (!held) frozen.current = live;
  return frozen.current;
}

export function ForYouNow({ attentionOn, clock, onAbove }: { attentionOn: boolean; clock: HeadsUpClock; onAbove: (ids: ReadonlySet<string>) => void }) {
  const headingId = useId();
  const openInbox = useSignals().openInbox;
  const latest = useLatestBriefing(attentionOn);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const result = useMemo(() => {
    const items = openInbox.data?.items ?? [];
    return curateForYouNow({ items, briefing: latest.briefing, now: clock.now, timeZone: clock.timeZone });
  }, [openInbox.data, latest.briefing, clock.now, clock.timeZone]);
  const { held, holdProps } = useHold("data-item-key");
  const shown = useFrozenResult(result, held);
  const idsKey = shown.entries.map((entry) => entry.item.id).sort().join(" ");
  useEffect(() => onAbove(new Set(idsKey ? idsKey.split(" ") : [])), [idsKey, onAbove]);

  const decide = async (item: AttentionItemView, decision: RowDecision, until?: string) => {
    setBusy(true);
    try {
      await post(`/attention/${item.id}/decision`, { decision, ...(until ? { until } : {}) });
      setSaid(decision === "start" ? `${item.title} is in progress.` : `${item.title} updated.`);
      if (decision === "done" || decision === "dismiss" || decision === "snooze") setOpenId(null);
      openInbox.reload();
    } finally {
      setBusy(false);
    }
  };
  const prepare = (item: AttentionItemView, body: AttentionDraftBody) => {
    void (async () => {
      setBusy(true);
      try {
        await post<{ job: JobView }>(`/attention/${item.id}/draft`, body);
        openInbox.reload();
      } finally {
        setBusy(false);
      }
    })();
  };
  const actions: RowActions = {
    decide,
    busy,
    prepareDraft: (item) => prepare(item, {}),
    prepareReplacement: (item, draftId) => prepare(item, { replaceUnconfirmed: draftId }),
    viewDraft: (draftId) => navigate(draftHref(draftId)),
  };

  if (!attentionOn)
    return <section className="for-you-now quiet" aria-labelledby={headingId}><h2 id={headingId}>For you now</h2><p>Attention and briefings is switched off.</p></section>;

  const failed = openInbox.error;
  return (
    <section className={`for-you-now${shown.entries.length ? "" : " quiet"}`} aria-labelledby={headingId} data-for-you-now={shown.entries.length ? "entries" : "quiet"} {...holdProps}>
      <div className="for-you-now-head">
        <h2 className="heading-section" id={headingId}>For you now</h2>
      </div>
      {failed ? (
        <p className="for-you-now-failed" role="alert">Could not read the Inbox. <button className="small" onClick={openInbox.reload}>Retry</button></p>
      ) : shown.entries.length ? (
        <>
          <ul className="inbox-rows for-you-now-rows">
            {shown.entries.map(({ item, reasonText }) => <InboxRow key={item.id} item={item} open={openId === item.id} onToggle={() => setOpenId(openId === item.id ? null : item.id)} actions={actions} draftsOn clock={clock} reason={reasonText} />)}
          </ul>
          {shown.moreInInbox > 0 && <p className="for-you-now-more"><a href="#inbox">{shown.moreInInbox} more in the Inbox</a></p>}
        </>
      ) : <p className="for-you-now-quiet-text" role="status">{latest.failed ? <>Could not read the Daily Briefing. <button className="small" onClick={latest.retry}>Retry</button></> : shown.quiet ?? "Checking For you now…"}</p>}
      <span className="sr-only" role="status">{said}</span>
    </section>
  );
}
