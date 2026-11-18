import { useId, useState } from "react";
import type { ProposalView } from "@attache/contracts";
import { useResource } from "../live.ts";
import { ErrorState, Link, Loading, Markdown, Time } from "../components/ui.tsx";
import { Disclosure } from "../components/Disclosure.tsx";
import { Icon } from "../components/icons.tsx";
import { StateTag } from "../components/StateTag.tsx";
import { Tag } from "../components/Tag.tsx";
import { SourceView, useOpenEvidence } from "../components/Evidence.tsx";
import { collectionOf, collection, noteSections, parseSource, waitingProposalsFor, waitingProposalWords, type FactSource } from "../brain.ts";

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

interface NoteChange {
  id: string;
  change: string;
  subject: string | null;
  beforeValue: string | null;
  afterValue: string | null;
  reason: string | null;
  actor: string;
  status: string;
  createdAt: string;
}

interface Doc {
  root: string;
  relPath: string;
  raw: string;
  title: string;
  area: string;
  state: StateEntry[];
  protected: boolean;
  changes: NoteChange[];
}

/** A fact's Review date, and the "unverified" tag once it has passed. */
function ReviewDate({ entry }: { entry: StateEntry }) {
  if (!entry.review) return null;
  if (!entry.unverified)
    return (
      <span className="fact-review" data-review={entry.review} title="The day after which this fact should be checked again">
        review after {entry.review}
      </span>
    );
  return (
    <span className="fact-review" data-review={entry.review} title={`Its Review date ${entry.review} has passed. Check it, then save the current value with a new Review date.`}>
      <Tag tone="attention">unverified</Tag> review was due {entry.review}
    </span>
  );
}

/** What a source opens: the cited lines in the evidence view, or the web page. */
function SourceOpenAction({ source }: { source: FactSource }) {
  const openEvidence = useOpenEvidence();
  const open = source.open;
  if (!open) return null;
  if (open.kind === "url")
    return (
      <a className="btn small" href={open.url} target="_blank" rel="noreferrer">
        Open the page
        <Icon name="external" size={14} />
      </a>
    );
  return (
    <button className="small" onClick={() => openEvidence({ root: open.root, relPath: open.relPath, lines: open.lines })}>
      {open.lines ? `Open lines ${open.lines[0]}–${open.lines[1]}` : "Open the source"}
    </button>
  );
}

/**
 * A fact: subject, value, date, Review date, and its source as a button that opens in place below the fact, never a
 * hover tooltip, so pointer, keyboard and touch all reach it. Open, it shows the source as the note stores it, when it
 * was observed, and the cited lines or page.
 */
function Fact({ entry }: { entry: StateEntry }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const source = entry.source ? parseSource(entry.source) : null;
  return (
    <li className="fact" data-subject={entry.subject} data-unverified={entry.unverified || undefined}>
      <span className="fact-subject">{entry.subject}</span>
      <span className="fact-value">{entry.value}</span>
      <span className="fact-meta">
        <span className="fact-date">{entry.date}</span>
        <ReviewDate entry={entry} />
        {source && (
          <button className="fact-source-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
            <span className="fact-source-word">Source</span>
            {source.summary && <span className="fact-source-summary">{source.summary}</span>}
            <Icon name="chevron" size={14} className="fact-source-chevron" />
          </button>
        )}
      </span>
      {source && (
        <div id={id} className="fact-source" hidden={!open} data-source-detail>
          <p className="fact-source-text">{source.text}</p>
          {(source.kind || source.observed) && <p className="fact-source-meta">{[source.kind, source.observed && `observed ${source.observed}`].filter(Boolean).join(" · ")}</p>}
          <SourceOpenAction source={source} />
        </div>
      )}
    </li>
  );
}

/** A History line as the note stores it, with its `**Subject**` markers shown as bold instead of asterisks. */
function HistoryLine({ text }: { text: string }) {
  return <>{text.split(/\*\*(.+?)\*\*/).map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part))}</>;
}

function ChangeLog({ changes }: { changes: readonly NoteChange[] }) {
  return (
    <Disclosure className="reader-change-log" title="Change log" meta={changes.length === 1 ? "1 change" : `${changes.length} changes`}>
      <ul className="timeline">
        {changes.map((c) => (
          <li key={c.id}>
            <Time iso={c.createdAt} />
            <span>
              {c.change} {c.subject ? `“${c.subject}”` : ""} by {c.actor}
              {c.beforeValue ? ` - was “${c.beforeValue}”` : ""}
              {c.reason ? ` (${c.reason})` : ""} <StateTag state={c.status} />
            </span>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

/** The Proposals that wait to change this note, as one line linking to Approvals. */
function WaitingProposals({ relPath }: { relPath: string }) {
  const res = useResource<{ proposals: ProposalView[] }>("/memory/proposals?status=proposed&limit=100", ["memory.changed"]);
  const waiting = waitingProposalsFor(relPath, res.data?.proposals ?? []);
  if (!waiting.length) return null;
  return (
    <p className="reader-proposal" data-waiting-proposals={waiting.length}>
      <Icon name="change" size={18} />
      <span>
        {waitingProposalWords(waiting.length)} <Link to="/approvals">Review {waiting.length === 1 ? "it" : "them"} in Approvals</Link>
      </span>
    </p>
  );
}

/**
 * One note, read-only: Current state first, each fact with its date, Review date and source; the Notes prose; History
 * exactly as stored; the Change log, closed; and the Markdown file at its original path.
 */
export function NoteReader({ root, relPath }: { root: string; relPath: string }) {
  const doc = useResource<Doc>(`/memory/document?root=${encodeURIComponent(root)}&path=${encodeURIComponent(relPath)}`, ["memory.changed"]);
  const titleId = useId();
  const d = doc.data;
  if (doc.loading && !d) return <Loading lines={6} label="Loading the note" />;
  if (doc.error) return <ErrorState error={doc.error} retry={doc.reload} title="This note could not be read" />;
  if (!d) return null;
  const { notes, history } = noteSections(d.raw);
  const kind = collectionOf(d.relPath);
  return (
    <article className="note-reader" aria-labelledby={titleId} data-note={d.relPath}>
      <header className="reader-head">
        {kind && <p className="reader-kind">{collection(kind).one}</p>}
        <h2 id={titleId} className="detail-title">
          {d.title}
        </h2>
        {d.protected && (
          <p className="reader-identity" data-identity>
            <Icon name="key" size={16} />
            <span>
              Your identity. It changes only from <Link to="/settings">Settings</Link>.
            </span>
          </p>
        )}
        {root === "data" && <WaitingProposals relPath={d.relPath} />}
      </header>
      {d.state.length > 0 && (
        <section className="reader-section" aria-labelledby={`${titleId}-state`}>
          <h3 id={`${titleId}-state`} className="reader-rule">
            Current state
          </h3>
          <ul className="facts">
            {d.state.map((s) => (
              <Fact key={`${s.subject}:${s.line}`} entry={s} />
            ))}
          </ul>
        </section>
      )}
      {notes && (
        <section className="reader-section" aria-labelledby={`${titleId}-notes`}>
          <h3 id={`${titleId}-notes`} className="reader-rule">
            Notes
          </h3>
          <Markdown className="reader-notes" text={notes} />
        </section>
      )}
      {history.length > 0 && (
        <section className="reader-section" aria-labelledby={`${titleId}-history`}>
          <h3 id={`${titleId}-history`} className="reader-rule">
            History
          </h3>
          <ul className="reader-history">
            {history.map((h, i) => (
              <li key={i}>
                <HistoryLine text={h} />
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="reader-foot">
        {d.changes.length > 0 && <ChangeLog changes={d.changes} />}
        <Disclosure className="reader-file" title="Markdown file" lazy meta={<span className="mono">{root !== "data" ? `${root} › ` : ""}{d.relPath}</span>}>
          <SourceView raw={d.raw} />
        </Disclosure>
      </div>
    </article>
  );
}
