import { useEffect, useState } from "react";
import { post } from "../api.ts";
import { useResource } from "../live.ts";
import { Empty, ErrorState, Loading, navigate, StatusPill, Time, useAction, useLocation } from "../components/ui.tsx";
import { SourceView, useOpenEvidence } from "../components/Evidence.tsx";
import { ProposalReview } from "../components/ProposalReview.tsx";

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
  value: string;
  source?: string;
  line: number;
}
interface Doc {
  root: string;
  relPath: string;
  raw: string;
  title: string;
  area: string;
  state: StateEntry[];
  editable: boolean;
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

function Correction({ doc, entry, onDone }: { doc: Doc; entry: StateEntry; onDone: () => void }) {
  const [value, setValue] = useState(entry.value);
  const [reason, setReason] = useState("");
  const { busy, run } = useAction();
  return (
    <form
      className="stack-sm card"
      onSubmit={(e) => {
        e.preventDefault();
        void run("correct", () => post("/memory/correct", { relPath: doc.relPath, subject: entry.subject, value, reason }).then(onDone), "Corrected. The old value is kept in History.");
      }}
    >
      <label className="field">
        New value for “{entry.subject}”
        <textarea value={value} onChange={(e) => setValue(e.target.value)} rows={2} autoFocus />
      </label>
      <label className="field">
        Why is it changing?
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Confirmed in Monday's standup" />
      </label>
      <div className="row">
        <button className="primary" disabled={busy !== null || !value.trim() || !reason.trim() || value === entry.value}>
          Save correction
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function DocPanel({ root, relPath }: { root: string; relPath: string }) {
  const doc = useResource<Doc>(`/memory/document?root=${encodeURIComponent(root)}&path=${encodeURIComponent(relPath)}`, ["memory.changed"]);
  const [editing, setEditing] = useState<string | null>(null);
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
            <div key={s.subject} className="stack-sm" style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }} data-subject={s.subject}>
              <div className="row">
                <strong style={{ minWidth: 110 }}>{s.subject}</strong>
                <span style={{ flex: 1 }}>{s.value}</span>
                <span className="small muted">{s.date}</span>
                {d.editable && editing !== s.subject && (
                  <button className="small" onClick={() => setEditing(s.subject)}>
                    Correct
                  </button>
                )}
              </div>
              {s.source && <span className="small muted">Source: {s.source}</span>}
              {editing === s.subject && <Correction doc={d} entry={s} onDone={() => { setEditing(null); doc.reload(); }} />}
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
              <li key={i}>{h.slice(2)}</li>
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

function Capture({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [asDecision, setAsDecision] = useState(false);
  const [decision, setDecision] = useState("");
  const [project, setProject] = useState("");
  const { busy, run } = useAction();
  return (
    <form
      className="card stack"
      onSubmit={(e) => {
        e.preventDefault();
        void run(
          "capture",
          async () => {
            const r = await post<{ capture: { relPath: string }; decision: { relPath: string } | null }>("/memory/capture", {
              text,
              ...(title ? { title } : {}),
              source: { kind: "user", ref: "browser capture", label: "Typed in Jarvis" },
              ...(asDecision && decision ? { decision: { title: title || decision.slice(0, 60), decision, ...(project ? { project } : {}) } } : {}),
            });
            setText("");
            setTitle("");
            setDecision("");
            onDone();
            navigate(`/memory?path=${encodeURIComponent(r.decision?.relPath ?? r.capture.relPath)}`);
          },
          "Captured",
        );
      }}
    >
      <h3>Capture</h3>
      <label className="field">
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Optional" />
      </label>
      <label className="field">
        Note or source text
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} placeholder="Paste meeting notes, a message or a thought. It is archived as evidence." />
      </label>
      <label className="check small">
        <input type="checkbox" checked={asDecision} onChange={(e) => setAsDecision(e.target.checked)} /> This contains a decision; record it in memory linked to this evidence
      </label>
      {asDecision && (
        <div className="grid-2">
          <label className="field">
            Decision
            <input value={decision} onChange={(e) => setDecision(e.target.value)} placeholder="e.g. Launch Atlas on 14 October" />
          </label>
          <label className="field">
            Project
            <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="Optional" />
          </label>
        </div>
      )}
      <div>
        <button className="primary" disabled={busy !== null || !text.trim() || (asDecision && !decision.trim())}>
          Save capture
        </button>
      </div>
    </form>
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
  const results = useResource<{ hits: Hit[] }>(query ? `/memory/search?q=${encodeURIComponent(query)}` : null, ["memory.changed"]);
  const [capturing, setCapturing] = useState(false);
  const open = useOpenEvidence();
  useEffect(() => {
    const h = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(h);
  }, [q]);
  const select = (root: string, relPath: string) => navigate(`/memory?root=${encodeURIComponent(root)}&path=${encodeURIComponent(relPath)}&tab=${tab}`);
  return (
    <div className="page">
      <div className="page-header">
        <h1>Memory</h1>
        <span className="subtitle">Curated memory, imported notes, evidence and deliverables. Search works without a model.</span>
        <div className="actions">
          <button onClick={() => setCapturing(!capturing)} aria-expanded={capturing}>
            {capturing ? "Close capture" : "Capture"}
          </button>
          <button className="ghost" onClick={() => void post("/memory/reindex")}>
            Rebuild index
          </button>
        </div>
      </div>
      {capturing && <Capture onDone={() => { setCapturing(false); list.reload(); }} />}
      <ProposalReview />
      <div className="split" style={{ marginTop: 14 }}>
        <div className="stack">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search memory and notes" aria-label="Search memory" />
          {!query && (
            <div className="tabs" role="tablist" aria-label="Memory type">
              {TABS.map((x) => (
                <button key={x.id} role="tab" aria-selected={x.id === tab} onClick={() => setTab(x.id)}>
                  {x.label}
                </button>
              ))}
            </div>
          )}
          {query ? (
            <>
              {results.loading && !results.data && <Loading />}
              <ErrorState error={results.error} retry={results.reload} />
              {results.data?.hits.length === 0 && <Empty title="No matches">Try other words. Search looks at titles, headings and text.</Empty>}
              <div className="list">
                {results.data?.hits.map((h) => (
                  <button key={h.chunkId} className="list-item" onClick={() => (h.root === "data" && h.relPath.startsWith("memory/") ? select(h.root, h.relPath) : open({ root: h.root, relPath: h.relPath, lines: [h.startLine, h.endLine], title: h.title }))}>
                    <div className="stack-sm" style={{ minWidth: 0 }}>
                      <strong>{h.title}</strong>
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
              {list.data?.length === 0 && <Empty title={`No ${t.label.toLowerCase()} yet`}>{t.id === "import" ? "Import a folder from Connections or Setup." : "Capture notes or decisions to build memory."}</Empty>}
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
        <div>{selected ? <DocPanel root={selectedRoot} relPath={selected} /> : <Empty title="Select a note">People, projects, decisions and notes show their current state, history and change log here.</Empty>}</div>
      </div>
    </div>
  );
}

