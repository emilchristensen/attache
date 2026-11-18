import { useMemo, useState, type ReactNode } from "react";
import type { AttentionItemView, JobView } from "@attache/contracts";
import { post } from "../api.ts";
import { useResource } from "../live.ts";
import { Empty, ErrorState, Link, Loading, navigate, Time, useAction } from "../components/ui.tsx";
import { StateTag } from "../components/StateTag.tsx";
import { Tag } from "../components/Tag.tsx";
import { useOpenEvidence } from "../components/Evidence.tsx";
import { openDraftId } from "../linked-draft.ts";
import type { InboxCoverage } from "../connection-status.ts";
import { homeLine } from "../count.ts";
import { useSignals } from "../nav-signals.ts";
import { AttentionDot } from "../components/AttentionDot.tsx";

const SOURCE_LABEL: Record<string, string> = { vault: "Notes", github: "GitHub", jira: "Jira", confluence: "Confluence", slack: "Slack", gmail: "Gmail", gcal: "Calendar", replication: "Replication", replication_merge: "Replication" };
const GROUPS: Array<{ id: string; title: string; match: (k: string) => boolean }> = [
  { id: "deadlines", title: "Deadlines", match: (k) => /due|overdue|deadline/.test(k) },
  { id: "reviews", title: "Review queue", match: (k) => /review/.test(k) && k !== "fact-review" },
  { id: "meetings", title: "Meetings", match: (k) => /meeting|invite|event/.test(k) },
  { id: "replies", title: "Pending replies", match: (k) => /reply|mention|dm/.test(k) },
  { id: "facts", title: "Facts to check", match: (k) => k === "fact-review" },
  { id: "other", title: "Other", match: () => true },
];

function snoozeTimes(): Array<{ label: string; iso: string }> {
  const now = new Date();
  const inHour = new Date(now.getTime() + 3_600_000);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const nextWeek = new Date(now);
  nextWeek.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  nextWeek.setHours(9, 0, 0, 0);
  return [
    { label: "1 hour", iso: inHour.toISOString() },
    { label: "Tomorrow 09:00", iso: tomorrow.toISOString() },
    { label: "Next Monday", iso: nextWeek.toISOString() },
  ];
}

function Item({ item, draftsOn, onChanged }: { item: AttentionItemView; draftsOn: boolean; onChanged: () => void }) {
  const { busy, run } = useAction();
  const open = useOpenEvidence();
  const [snoozing, setSnoozing] = useState(false);
  const decide = (decision: string, until?: string) => run(decision, () => post(`/attention/${item.id}/decision`, { decision, ...(until ? { until } : {}) }).then(onChanged));
  const ev = item.evidence[0];
  const draftId = openDraftId(item);
  return (
    <article className={`item${item.priority >= 70 ? " priority-high" : ""}`} data-item-key={item.key} aria-label={item.title}>
      <div className="title">{item.title}</div>
      <div className="summary">{item.summary}</div>
      <div className="meta">
        <Tag>{SOURCE_LABEL[item.sourceKind] ?? item.sourceKind}</Tag>
        {item.dueAt && <span>due {item.dueAt.slice(0, 10)}</span>}
        <span>
          first seen <Time iso={item.firstSeenAt} />
        </span>
        {item.state === "snoozed" && item.snoozeUntil && (
          <span>
            snoozed until {new Date(item.snoozeUntil).toLocaleString()}
          </span>
        )}
        {item.state === "dismissed" && <StateTag state="expired" label="dismissed" />}
        {item.changedSinceDecision && item.state === "open" && <StateTag state="partial" label="changed since your decision" />}
      </div>
      {item.why && <div className="small muted">Why: {item.why}</div>}
      <div className="item-actions">
        {item.url && (
          <a className="btn small" href={item.url} target="_blank" rel="noopener noreferrer">
            Open
          </a>
        )}
        {ev?.relPath && (
          <button className="small" onClick={() => open({ root: item.connectionId === "vault-data" || !item.connectionId ? "data" : `import:${item.connectionId}`, relPath: ev.relPath!, lines: ev.lines, title: item.title })}>
            Evidence
          </button>
        )}
        {draftsOn && item.draftable && (
          <button
            className="small"
            disabled={busy !== null}
            onClick={() =>
              run("draft", async () => {
                if (draftId) return navigate(`/approvals?id=${draftId}`);
                await post<{ job: JobView }>(`/attention/${item.id}/draft`, {});
                onChanged();
              }, draftId ? undefined : "Preparing a draft in the background")
            }
          >
            {draftId ? "View draft" : "Prepare draft"}
          </button>
        )}
        {item.state === "open" ? (
          <>
            <button className="small ghost" disabled={busy !== null} onClick={() => decide("done")}>
              Done
            </button>
            <button className="small ghost" disabled={busy !== null} onClick={() => decide("dismiss")}>
              Dismiss
            </button>
            <button className="small ghost" aria-expanded={snoozing} onClick={() => setSnoozing(!snoozing)}>
              Snooze
            </button>
          </>
        ) : (
          <button className="small ghost" onClick={() => decide("reopen")}>
            Reopen
          </button>
        )}
      </div>
      {snoozing && (
        <div className="row" role="group" aria-label="Snooze until">
          {snoozeTimes().map((t) => (
            <button key={t.label} className="small" onClick={() => { setSnoozing(false); void decide("snooze", t.iso); }}>
              {t.label}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

const EMPTY: Record<InboxCoverage, { title: string; body: string }> = {
  all: { title: "Nothing needs your attention", body: "Items appear here when deadlines approach, reviews are requested, meetings need prep or replies are pending." },
  notes: { title: "Nothing needs your attention in your notes", body: "No work source is connected, so only your notes were read." },
  incomplete: { title: "Nothing found in the sources that were read", body: "Connections above says what was not read, so this may not be complete." },
};

/** Nothing is promoted above the Inbox yet; the Heads-ups (#25, #26 of spec #14) fill this with meeting prep items. */
const NOTHING_PROMOTED: ReadonlySet<string> = new Set();

/**
 * The Inbox heading with Home's decision count beside it ("4 need you here"), while the navigation leaves Home's
 * number out, and the line that relates the rows to the decisions when they differ.
 */
function InboxHeading({ children, open }: { children: ReactNode; open: boolean }) {
  const signals = useSignals();
  const home = signals.count.home;
  const needYou = home.count > 0 ? `${home.exact ? "" : "At least "}${home.count} ${home.count === 1 && home.exact ? "needs" : "need"} you here` : null;
  const line = open ? homeLine(signals.inbox, NOTHING_PROMOTED) : null;
  return (
    <>
      <div className="inbox-head">
        <div className="inbox-title">
          <h2 className="heading-section">Inbox</h2>
          {needYou && (
            <span className="need-you" data-need-you>
              <AttentionDot decorative />
              {needYou}
            </span>
          )}
        </div>
        {children}
      </div>
      {line && <p className="count-line">{line}</p>}
    </>
  );
}

/**
 * The Inbox list. `coverage` comes from Home's Connections area: an empty list says nothing needs the owner only
 * when every source was read, and names what was read otherwise.
 */
export function Inbox({ attentionOn, draftsOn, coverage }: { attentionOn: boolean; draftsOn: boolean; coverage: InboxCoverage }) {
  const [showHidden, setShowHidden] = useState(false);
  // The open rows are the shell's request behind the count, so the rows, their Retry and the count agree.
  const open = useSignals().openInbox;
  const hidden = useResource<{ items: AttentionItemView[] }>(attentionOn && showHidden ? "/attention?state=dismissed,snoozed" : null, ["attention.changed", "briefing.created", "actions.changed"]);
  const items = showHidden ? hidden : open;
  const grouped = useMemo(() => {
    const out = new Map<string, AttentionItemView[]>();
    for (const it of items.data?.items ?? []) {
      const g = GROUPS.find((x) => x.match(it.kind))!;
      out.set(g.id, [...(out.get(g.id) ?? []), it]);
    }
    return GROUPS.filter((g) => out.has(g.id)).map((g) => ({ ...g, items: out.get(g.id)! }));
  }, [items.data]);
  if (!attentionOn)
    return (
      <Empty title="Attention and briefings is off" action={<Link to="/settings">Turn it on in Settings</Link>}>
        Search still works.
      </Empty>
    );
  return (
    <div id="inbox">
      <InboxHeading open={!showHidden}>
        <button className="small ghost" onClick={() => setShowHidden(!showHidden)}>
          {showHidden ? "Show open" : "Show dismissed"}
        </button>
      </InboxHeading>
      {showHidden && <div className="section-title">Dismissed and snoozed</div>}
      {items.loading && !items.data && <Loading label="Loading the Inbox" />}
      <ErrorState error={items.error} retry={items.reload} />
      {items.data && items.data.items.length === 0 && (
        <Empty title={showHidden ? "Nothing dismissed or snoozed" : EMPTY[coverage].title}>{showHidden ? null : EMPTY[coverage].body}</Empty>
      )}
      {grouped.map((g) => (
        <section key={g.id} id={`attention-${g.id}`} className="attention-group" aria-label={g.title}>
          <div className="section-title">
            {g.title} <span className="muted">{g.items.length}</span>
          </div>
          {g.items.map((it) => (
            <Item key={it.id} item={it} draftsOn={draftsOn} onChanged={items.reload} />
          ))}
        </section>
      ))}
    </div>
  );
}
