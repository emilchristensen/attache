import { useMemo, useState, type ReactNode } from "react";
import type { AttentionItemView, ConnectionStatus, JobView } from "@attache/contracts";
import { post } from "../api.ts";
import { useLiveEvent, useResource } from "../live.ts";
import { Empty, ErrorState, Link, Loading, navigate, Time, useAction } from "../components/ui.tsx";
import { StateTag } from "../components/StateTag.tsx";
import { Tag } from "../components/Tag.tsx";
import { useOpenEvidence } from "../components/Evidence.tsx";
import { briefingLines } from "../briefing-text.ts";
import { openDraftId } from "../linked-draft.ts";
import { homeLine } from "../count.ts";
import { useSignals } from "../nav-signals.ts";
import { AttentionDot } from "../components/AttentionDot.tsx";
import { ReaderLine } from "./ReaderLine.tsx";

interface Briefing {
  id: string;
  kind: string;
  createdAt: string;
  since: string | null;
  summary: string;
  sections: Array<{ id: string; title: string; items: Array<{ id: string; title: string; summary: string; url: string | null; isNew: boolean; changed: boolean; related?: Array<{ title: string; relPath: string; lines: [number, number] }> }> }>;
  counts: { open: number; new: number; changed: number; drafts: number; proposals: number; failedSources: number };
  deliverablePath: string | null;
}

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

const KIND_LABEL: Record<string, string> = { daily: "Daily", away: "Away summary", manual: "On demand" };
// Briefing sections that live on another screen instead of in the attention list below.
const SECTION_ROUTE: Record<string, string> = { prepared: "/approvals", memory: "/approvals" };

function jumpTo(sectionId: string) {
  const route = SECTION_ROUTE[sectionId];
  if (route) return navigate(route);
  document.getElementById(`attention-${sectionId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function BriefingOverview({ briefing }: { briefing: Briefing }) {
  const fresh = [briefing.counts.new && `${briefing.counts.new} new`, briefing.counts.changed && `${briefing.counts.changed} changed`].filter(Boolean).join(" · ");
  return (
    <div className="briefing-counts" role="group" aria-label="Briefing at a glance">
      {briefing.sections.map((s) => (
        <button key={s.id} className="count-chip" onClick={() => jumpTo(s.id)} title={SECTION_ROUTE[s.id] ? `Open ${s.title.toLowerCase()}` : `Jump to ${s.title.toLowerCase()}`}>
          <b>{s.items.length}</b>
          {s.title}
        </button>
      ))}
      {fresh && <Tag hue="blue">{briefing.kind === "away" ? `${fresh} while away` : `${fresh} since last briefing`}</Tag>}
    </div>
  );
}

function BriefingCard({ canRun }: { canRun: boolean }) {
  const b = useResource<{ briefing: Briefing | null }>("/briefings/latest", ["briefing.created"]);
  const [job, setJob] = useState<{ id: string; progress: number; note: string | null; status: string } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const open = useOpenEvidence();
  const { run } = useAction();
  useLiveEvent((ev) => {
    if (ev.type !== "job.event" || !job) return;
    const e = ev.event as { jobId: string; type: string; data: { progress?: number; note?: string; error?: string } };
    if (e.jobId !== job.id) return;
    if (e.type === "progress") setJob({ ...job, progress: e.data.progress ?? job.progress, note: e.data.note ?? job.note });
    if (["succeeded", "failed", "cancelled", "blocked"].includes(e.type)) setJob({ ...job, status: e.type, note: e.data.error ?? null });
  });
  const start = (kind: string, since?: string) =>
    run("brief", async () => {
      const r = await post<{ job: JobView }>("/briefings", { kind, ...(since ? { since } : {}) });
      setJob({ id: r.job.id, progress: 0, note: "Queued", status: "queued" });
    });
  const br = b.data?.briefing;
  const running = job && !["succeeded", "failed", "cancelled", "blocked"].includes(job.status);
  return (
    <div className="briefing" aria-live="polite">
      <div className="briefing-head">
        <h2>Briefing</h2>
        {br && (
          <span className="small muted">
            {KIND_LABEL[br.kind] ?? br.kind} · <Time iso={br.createdAt} />
          </span>
        )}
      </div>
      {b.loading && !b.data && <Loading lines={2} />}
      {br ? (
        <>
          <ul className="briefing-lines">
            {briefingLines(br.summary).map((l, n) => (
              <li key={n} className={l.caveat ? "caveat" : undefined}>
                {l.text}
              </li>
            ))}
          </ul>
          {br.sections.length > 0 && <BriefingOverview briefing={br} />}
        </>
      ) : (
        !b.loading && <p className="briefing-empty">No briefing yet. Prepare one to see what changed across your sources.</p>
      )}
      {running && (
        <div className="stack-sm" style={{ marginTop: 8 }}>
          <div className="progress" aria-label="Briefing progress">
            <span style={{ width: `${Math.round(job!.progress * 100)}%` }} />
          </div>
          <span className="small muted">{job!.note ?? "Working…"} — keeps running if you close this tab.</span>
        </div>
      )}
      {job?.status === "failed" && <p className="small error-text">Briefing failed: {job.note}</p>}
      {br && expanded && (
        <div className="briefing-meetings" aria-label="Meeting context">
          {br.sections.filter((s) => s.id === "meetings").flatMap((s) => s.items).map((i) => (
            <div key={i.id} className="small">
              <strong>{i.title}</strong>
              {(i.related ?? []).length > 0 ? (
                <div className="row" style={{ marginTop: 4 }}>
                  {i.related!.map((r) => (
                    <button key={`${r.relPath}:${r.lines.join("-")}`} className="source-chip" onClick={() => open({ root: "data", relPath: r.relPath, lines: r.lines, title: r.title })}>
                      {r.title}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="muted">No related notes found.</div>
              )}
            </div>
          ))}
          {br.deliverablePath && (
            <button className="small ghost" style={{ alignSelf: "flex-start" }} onClick={() => open({ root: "data", relPath: br.deliverablePath!, title: "Full briefing" })}>
              Open the full briefing
            </button>
          )}
        </div>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="small primary" disabled={!canRun || !!running} onClick={() => start("manual")}>
          {running ? "Preparing…" : "Prepare briefing"}
        </button>
        <button className="small" disabled={!canRun || !!running} onClick={() => start("away", new Date(Date.now() - 3 * 86_400_000).toISOString())} title="Summarise what changed in the last three days">
          Away summary
        </button>
        {br && (
          <button className="small ghost" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
            {expanded ? "Less" : "Meeting context"}
          </button>
        )}
      </div>
    </div>
  );
}

export function Coverage({ connections }: { connections: ConnectionStatus[] }) {
  const sources = connections.filter((c) => c.kind in SOURCE_LABEL && c.status !== "not_configured");
  if (!sources.length) return <p className="small muted">No sources connected beyond your notes. <Link to="/connections">Connect sources</Link></p>;
  return (
    <div className="coverage" aria-label="Source freshness">
      {sources.map((s) => (
        <div key={s.id} className="src" data-source={s.id}>
          <StateTag state={s.status === "connected" ? (s.coverage?.state ?? "never_run") : s.status} label={s.status === "connected" ? (s.coverage?.state === "empty" ? "up to date" : (s.coverage?.state ?? "never refreshed").replace(/_/g, " ")) : s.status.replace(/_/g, " ")} />
          <span>{s.label}</span>
          <span className="when">
            {s.lastSuccessAt ? (
              <>
                ok <Time iso={s.lastSuccessAt} />
              </>
            ) : (
              "never succeeded"
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Nothing is promoted above the Inbox yet; the Heads-ups (#25, #26 of spec #14) fill this with meeting prep items. */
const NOTHING_PROMOTED: ReadonlySet<string> = new Set();

/**
 * The Inbox heading with Home's decision count beside it ("4 need you here"), while the navigation leaves Home's
 * number out, and the line that relates the rows to the decisions when they differ.
 */
function InboxHeading({ children }: { children: ReactNode }) {
  const signals = useSignals();
  const home = signals?.count.home;
  const needYou = home && home.count > 0 ? `${home.exact ? "" : "At least "}${home.count} ${home.count === 1 && home.exact ? "needs" : "need"} you here` : null;
  const line = signals && home ? homeLine(signals.inbox, home, NOTHING_PROMOTED) : null;
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

export function Inbox({ attentionOn, draftsOn }: { attentionOn: boolean; draftsOn: boolean }) {
  const [showHidden, setShowHidden] = useState(false);
  const items = useResource<{ items: AttentionItemView[] }>(attentionOn ? `/attention?state=${showHidden ? "dismissed,snoozed" : "open"}` : null, ["attention.changed", "briefing.created", "actions.changed"]);
  const conns = useResource<ConnectionStatus[]>("/connections", ["connections.changed"]);
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
  const failed = (conns.data ?? []).filter((c) => c.status !== "not_configured" && c.status !== "disconnected" && (c.status !== "connected" || (c.coverage && !["complete", "empty"].includes(c.coverage.state))));
  return (
    <div>
      <BriefingCard canRun={attentionOn} />
      <div className="section-title">
        Sources
        <Link to="/connections">manage</Link>
      </div>
      <ReaderLine />
      {conns.data ?<Coverage connections={conns.data} /> : <Loading lines={2} />}
      {failed.length > 0 && (
        <div className="state partial small" style={{ marginTop: 10 }} role="status">
          <strong style={{ color: "var(--warn)" }}>Incomplete coverage</strong>
          <span>{failed.map((f) => `${f.label}: ${f.status !== "connected" ? f.status.replace(/_/g, " ") : f.coverage?.state}`).join(" · ")}. Items from these sources may be missing below.</span>
        </div>
      )}
      <InboxHeading>
        <button className="small ghost" onClick={() => setShowHidden(!showHidden)}>
          {showHidden ? "Show open" : "Show dismissed"}
        </button>
      </InboxHeading>
      {showHidden && <div className="section-title">Dismissed and snoozed</div>}
      {items.loading && !items.data && <Loading />}
      <ErrorState error={items.error} retry={items.reload} />
      {items.data && items.data.items.length === 0 && (
        <Empty title={showHidden ? "Nothing dismissed or snoozed" : failed.length ? "Nothing found in the sources that answered" : "Nothing needs your attention"}>
          {showHidden ? null : failed.length ? "Some sources failed, so this may not be complete." : "Items appear here when deadlines approach, reviews are requested, meetings need prep or replies are pending."}
        </Empty>
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
