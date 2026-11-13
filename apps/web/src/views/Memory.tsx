import { useEffect, useState } from "react";
import type { MeaningStatus } from "@jarvis/contracts";
import { post } from "../api.ts";
import { useResource } from "../live.ts";
import { Empty, ErrorState, Link, Loading, navigate, StatusPill, Time, useLocation } from "../components/ui.tsx";
import { useRevealDetail } from "../components/reveal-detail.ts";
import { SourceView, useOpenEvidence } from "../components/Evidence.tsx";
import { ProposalReview } from "../components/ProposalReview.tsx";
import { Tabs } from "../components/Tabs.tsx";
import { RecentSaves } from "./RecentSaves.tsx";

interface Hit {
  chunkId: number;
  root: string;
  relPath: string;
  area: string;
  docType: string | null;
  title: string;
  heading: string | null;
  section: string;
  startLine: number;
  endLine: number;
  snippet: string;
  review: string | null;
  unverified: boolean;
}
interface DocListItem {
  id: string;
  root: string;
  relPath: string;
  area: string;
  docType: string | null;
  title: string;
  mtimeMs: number;
  meta: Record<string, unknown>;
}
interface StateEntry {
  subject: string;
  date: string;
  /** The day after which the fact should be checked again. */
  review?: string;
  /** Past its Review date: kept, but to be checked before relying on it. */
  unverified: boolean;
  value: string;
  source?: string;
  line: number;
}

/** A fact's Review date, and a warning once it has passed. */
function ReviewDate({ entry }: { entry: StateEntry }) {
  if (!entry.review) return null;
  if (!entry.unverified)
    return (
      <span className="small muted state-review" data-review={entry.review} title="The day after which this fact should be checked again">
        review after {entry.review}
      </span>
    );
  return (
    <span className="row state-review" data-review={entry.review} title={`Its Review date ${entry.review} has passed. Check it, then save the current value with a new Review date.`}>
      <StatusPill state="partial" label="unverified" />
      <span className="small">review was due {entry.review}</span>
    </span>
  );
}
interface Doc {
  root: string;
  relPath: string;
  raw: string;
  title: string;
  area: string;
  state: StateEntry[];
  protected: boolean;
  frontmatter: Record<string, unknown>;
  changes: Array<{ id: string; change: string; subject: string | null; beforeValue: string | null; afterValue: string | null; reason: string | null; actor: string; status: string; createdAt: string }>;
}

const TABS: Array<{ id: string; label: string; query: string }> = [
  { id: "person", label: "People", query: "area=memory&type=person" },
  { id: "project", label: "Projects", query: "area=memory&type=project" },
  { id: "decision", label: "Decisions", query: "area=memory&type=decision" },
  { id: "note", label: "Notes", query: "area=memory&type=note" },
  { id: "import", label: "Imported", query: "area=import" },
  { id: "evidence", label: "Evidence", query: "area=evidence" },
  { id: "deliverables", label: "Deliverables", query: "area=deliverables" },
];

/** A History line as the note stores it, with its `**Subject**` markers shown as bold instead of asterisks. */
function HistoryLine({ text }: { text: string }) {
  return <>{text.split(/\*\*(.+?)\*\*/).map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part))}</>;
}

function DocPanel({ root, relPath }: { root: string; relPath: string }) {
  const doc = useResource<Doc>(`/memory/document?root=${encodeURIComponent(root)}&path=${encodeURIComponent(relPath)}`, ["memory.changed"]);
  const [showSource, setShowSource] = useState(false);
  const d = doc.data;
  if (doc.loading && !d) return <Loading lines={6} />;
  if (doc.error) return <ErrorState error={doc.error} retry={doc.reload} />;
  if (!d) return null;
  const history = d.raw.split(/^## History\s*$/m)[1]?.split("\n").filter((l) => l.startsWith("- ")) ?? [];
  return (
    <div className="stack">
      <div className="row">
        <h2 style={{ flex: 1 }}>{d.title}</h2>
        <StatusPill state={d.area === "memory" ? "ready" : "draft"} label={d.area} />
        {d.protected && <StatusPill state="partial" label="protected" />}
      </div>
      <p className="small muted mono">{root !== "data" ? `${root} › ` : ""}{relPath}</p>
      {d.state.length > 0 && (
        <div className="card stack-sm">
          <h3>Current state</h3>
          {d.state.map((s) => (
            <div key={s.subject} className="stack-sm state-entry" data-subject={s.subject} data-unverified={s.unverified || undefined}>
              <div className="state-row">
                <strong>{s.subject}</strong>
                <span className="small muted state-date">{s.date}</span>
                <span className="state-value">{s.value}</span>
                <ReviewDate entry={s} />
              </div>
              {s.source && <span className="small muted">Source: {s.source}</span>}
            </div>
          ))}
          {d.protected && <p className="small muted">This identity record changes only from Settings.</p>}
        </div>
      )}
      {history.length > 0 && (
        <div className="card">
          <h3>History</h3>
          <ul className="small" style={{ paddingLeft: 18, margin: "6px 0 0", color: "var(--text-2)" }}>
            {history.map((h, i) => (
              <li key={i}>
                <HistoryLine text={h.slice(2)} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {d.changes.length > 0 && (
        <div className="card">
          <h3>Change log</h3>
          <ul className="timeline" style={{ marginTop: 6 }}>
            {d.changes.map((c) => (
              <li key={c.id}>
                <Time iso={c.createdAt} />
                <span>
                  {c.change} {c.subject ? `“${c.subject}”` : ""} by {c.actor}
                  {c.beforeValue ? ` — was “${c.beforeValue}”` : ""}
                  {c.reason ? ` (${c.reason})` : ""} <StatusPill state={c.status} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <button className="ghost small" style={{ alignSelf: "flex-start" }} onClick={() => setShowSource(!showSource)}>
        {showSource ? "Hide file" : "Show the Markdown file"}
      </button>
      {showSource && <SourceView raw={d.raw} />}
    </div>
  );
}

/** Why search results match keywords only, for as long as search does not rank by meaning on this Machine. */
function KeywordsOnly({ meaning }: { meaning: MeaningStatus }) {
  if (meaning.ranking === "meaning" || meaning.state === "ready") return null;
  const why: Record<Exclude<MeaningStatus["state"], "ready">, string> = {
    missing: "the meaning model is not downloaded",
    downloading: "the meaning model is downloading",
    failed: "meaning-based search stopped with an error",
    building: `search vectors are being built (${meaning.vectors.embedded} of ${meaning.vectors.chunks})`,
  };
  const reason = why[meaning.state];
  return (
    <p className="small muted" data-keywords-only>
      Matching keywords only: {reason}. <Link to="/settings">Settings</Link>
    </p>
  );
}

export function MemoryView() {
  const loc = useLocation();
  const [tab, setTab] = useState(loc.search.get("tab") ?? "decision");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const selected = loc.search.get("path");
  const selectedRoot = loc.search.get("root") ?? "data";
  const t = TABS.find((x) => x.id === tab) ?? TABS[0]!;
  const list = useResource<DocListItem[]>(query ? null : `/memory/documents?${t.query}`, ["memory.changed"]);
  const results = useResource<{ hits: Hit[]; meaning: MeaningStatus }>(query ? `/memory/search?q=${encodeURIComponent(query)}` : null, ["memory.changed"]);
  const open = useOpenEvidence();
  useEffect(() => {
    const h = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(h);
  }, [q]);
  const { detailRef, revealDetail } = useRevealDetail();
  const select = (root: string, relPath: string) => {
    navigate(`/memory?root=${encodeURIComponent(root)}&path=${encodeURIComponent(relPath)}&tab=${tab}`);
    revealDetail();
  };
  return (
    <div className="page">
      <div className="page-header">
        <h1>Memory</h1>
        <span className="subtitle">Curated memory, imported notes, evidence and deliverables. Search works without a model.</span>
        <div className="actions">
          <button className="ghost" onClick={() => void post("/memory/reindex")}>
            Rebuild index
          </button>
        </div>
      </div>
      <ProposalReview />
      <RecentSaves />
      <div className="split" style={{ marginTop: 14 }}>
        <div className="stack">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search memory and notes" aria-label="Search memory" />
          {!query && (
            <Tabs label="Memory type" tabs={TABS} selected={t.id} onSelect={setTab} />
          )}
          {query ? (
            <>
              {results.loading && !results.data && <Loading />}
              <ErrorState error={results.error} retry={results.reload} />
              {results.data && <KeywordsOnly meaning={results.data.meaning} />}
              {results.data?.hits.length === 0 && <Empty title="No matches">Try other words. Search looks at titles, headings and text.</Empty>}
              <div className="list">
                {results.data?.hits.map((h) => (
                  <button key={h.chunkId} className="list-item" onClick={() => (h.root === "data" && h.relPath.startsWith("memory/") ? select(h.root, h.relPath) : open({ root: h.root, relPath: h.relPath, lines: [h.startLine, h.endLine], title: h.title }))}>
                    <div className="stack-sm" style={{ minWidth: 0 }}>
                      <span className="row">
                        <strong>{h.title}</strong>
                        {h.unverified && <StatusPill state="partial" label="unverified" />}
                      </span>
                      <span className="small muted">{h.snippet}</span>
                      <span className="small mono muted">
                        {h.relPath}:{h.startLine} · {h.area}
                        {h.section === "history" ? " · superseded" : ""}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              {list.loading && !list.data && <Loading />}
              <ErrorState error={list.error} retry={list.reload} />
              {list.data?.length === 0 && <Empty title={`No ${t.label.toLowerCase()} yet`}>{t.id === "import" ? "Import a folder from Connections or Setup." : "Notes appear here when a Harness saves them."}</Empty>}
              <div className="list">
                {list.data?.map((d) => (
                  <button key={d.id} className="list-item" aria-current={selected === d.relPath} onClick={() => (d.area === "memory" ? select(d.root, d.relPath) : open({ root: d.root, relPath: d.relPath, title: d.title }))}>
                    <div className="stack-sm" style={{ minWidth: 0 }}>
                      <strong>{d.title}</strong>
                      <span className="small mono muted">{d.relPath}</span>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div ref={detailRef} className="split-detail">{selected ? <DocPanel root={selectedRoot} relPath={selected} /> : <Empty title="Select a note">People, projects, decisions and notes show their current state, history and change log here.</Empty>}</div>
      </div>
    </div>
  );
}

