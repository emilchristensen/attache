import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useResource } from "../live.ts";
import { Empty, ErrorState, Loading, navigate, useLocation } from "../components/ui.tsx";
import { ChipNav } from "../components/ChipNav.tsx";
import { Icon } from "../components/icons.tsx";
import { useMenuDismiss } from "../components/menu.ts";
import { usePageRoom, useRevealDetail } from "../components/reveal-detail.ts";
import { useOpenEvidence } from "../components/Evidence.tsx";
import { tabId, Tabs } from "../components/Tabs.tsx";
import { hitDestination, type SearchAnswer } from "../search.ts";
import { RankingNote, SearchResultRow } from "../components/SearchField.tsx";
import { brainHref, brainPlace, collection, COLLECTIONS, type BrainPlace } from "../brain.ts";
import { NoteReader } from "./NoteReader.tsx";
import { RecentSaves } from "./RecentSaves.tsx";
import { useRebuildIndex } from "./RebuildIndex.tsx";

interface DocListItem {
  id: string;
  root: string;
  relPath: string;
  area: string;
  title: string;
  mtimeMs: number;
}

type LibraryPlace = Extract<BrainPlace, { view: "library" }>;

/** The Brain's own search field; Clear search puts focus back in it. */
const BRAIN_SEARCH_ID = "brain-search";
/** The most passages the Brain's search lists: the service's own limit. */
const BRAIN_RESULTS = 50;
/** How long typing pauses before the query is written to the address. */
const QUERY_TO_ADDRESS_MS = 250;
const VIEWS = [
  { id: "library", label: "Library" },
  { id: "recent", label: "Recent saves" },
] as const;
const VIEW_PANEL = "brain-view";

/** The Brain's menu: actions that need no room on the page. Rebuild index is also in Settings. */
function BrainMenu() {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const chosen = useMenuDismiss(open, close, root, button);
  const { rebuild, busy } = useRebuildIndex();
  return (
    <div className="brain-menu" ref={root}>
      <button ref={button} className="icon-button" aria-label="Brain menu" aria-expanded={open} aria-controls={menuId} onClick={() => setOpen(!open)}>
        <Icon name="more" size={20} />
      </button>
      {open && (
        <div id={menuId} className="menu-pop" role="group" aria-label="Brain menu" onClick={chosen}>
          <button className="menu-item" disabled={busy} onClick={rebuild}>
            <span>Rebuild index</span>
            <span className="menu-help">Read every note into search again, when search misses one. Notes are not changed.</span>
          </button>
        </div>
      )}
    </div>
  );
}

/** The Brain's search field, full width: what the owner types replaces the Library with every result. */
function BrainSearch({ q, onChange }: { q: string; onChange: (q: string) => void }) {
  return (
    <div className="search brain-search" role="search" aria-label="Brain">
      <div className="search-box">
        <Icon name="search" size={22} />
        <input id={BRAIN_SEARCH_ID} type="search" value={q} onChange={(e) => onChange(e.target.value)} placeholder="Search the Brain" aria-label="Search the Brain" autoComplete="off" spellCheck={false} />
      </div>
    </div>
  );
}

const COLLECTION_LINKS = COLLECTIONS.map((c) => ({ id: c.id, label: c.label, href: brainHref({ view: "library", collection: c.id }) }));

/** The collections, without counts: a column beside the list on a wide screen, a row of chips on a narrow one. */
function Collections({ place }: { place: LibraryPlace }) {
  return <ChipNav label="Collections" className="collections" items={COLLECTION_LINKS} current={place.collection} />;
}

const updated = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** One collection's notes by title. Curated notes open in the reader; other material opens in the evidence view. */
function NoteList({ place, onPick }: { place: LibraryPlace; onPick: () => void }) {
  const c = collection(place.collection);
  const list = useResource<DocListItem[]>(`/memory/documents?${c.query}`, ["memory.changed"]);
  const openEvidence = useOpenEvidence();
  if (list.loading && !list.data) return <Loading label={`Loading ${c.label.toLowerCase()}`} />;
  if (list.error) return <ErrorState error={list.error} retry={list.reload} title={`${c.label} could not load`} />;
  if (!list.data?.length)
    return <Empty title={`No ${c.label.toLowerCase()} yet`}>{c.id === "import" ? "Import a folder from Connections or Setup." : c.folder ? "Notes appear here when a Harness saves them." : "Nothing here yet."}</Empty>;
  return (
    <ul className="note-list" aria-label={c.label}>
      {list.data.map((d) => {
        const body = (
          <>
            <span className="note-list-title">{d.title}</span>
            <span className="note-list-meta">Updated {updated.format(d.mtimeMs)}</span>
          </>
        );
        return (
          <li key={d.id}>
            {d.area === "memory" ? (
              <a
                className="note-list-item"
                href={brainHref({ view: "library", collection: c.id, root: d.root, path: d.relPath })}
                aria-current={place.path === d.relPath && place.root === d.root ? "true" : undefined}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  navigate(e.currentTarget.getAttribute("href")!);
                  onPick();
                }}
              >
                {body}
              </a>
            ) : (
              <button className="note-list-item" onClick={() => openEvidence({ root: d.root, relPath: d.relPath, title: d.title })}>
                {body}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Every passage that matches, in the Library's place, with how they were ranked. */
function Results({ place, onPick, onClear }: { place: LibraryPlace; onPick: () => void; onClear: () => void }) {
  const results = useResource<SearchAnswer>(`/memory/search?q=${encodeURIComponent(place.q)}&limit=${BRAIN_RESULTS}`, ["memory.changed"]);
  const openEvidence = useOpenEvidence();
  const answer = results.data;
  const count = answer?.hits.length ?? 0;
  return (
    <section className="brain-results" aria-labelledby="brain-results-title" aria-busy={results.loading || undefined}>
      <div className="brain-results-head">
        <h2 id="brain-results-title" className="brain-results-title">
          {answer ? (count === BRAIN_RESULTS ? `First ${count} results` : count === 1 ? "1 result" : `${count} results`) : "Results"}
          <span className="sr-only"> for “{place.q}”</span>
        </h2>
        <button className="ghost small" onClick={onClear}>
          Clear search
        </button>
      </div>
      {answer && <RankingNote meaning={answer.meaning} />}
      {results.loading && !answer && <Loading label="Searching" />}
      <ErrorState error={results.error} retry={results.reload} title="Search failed" />
      {answer && count === 0 && <Empty title="No matches">No passage matches “{place.q}”. Try other words. Search looks at titles, headings and text.</Empty>}
      {count > 0 && (
        <ul className="result-list">
          {answer!.hits.map((h) => {
            const to = hitDestination(h, place.q);
            const current = to.kind === "brain" && place.path === h.relPath && place.root === h.root;
            return (
              <li key={h.chunkId}>
                <button
                  className="result-item"
                  aria-current={current || undefined}
                  onClick={() => {
                    if (to.kind === "evidence") return openEvidence(to.target);
                    navigate(to.href);
                    onPick();
                  }}
                >
                  <SearchResultRow hit={h} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * The Library: collections, a collection's notes and the note reader side by side; with a query, every result
 * replaces the collections and the list. On a narrow screen the collections are a row of chips and the reader goes
 * below the list.
 */
function Library({ place, onClear }: { place: LibraryPlace; onClear: () => void }) {
  const { detailRef, revealDetail } = useRevealDetail();
  // A note opened from elsewhere (Home's search, Approvals) shows in view on a phone too, as a note picked here does.
  const arrivedWithNote = useRef(place.path !== null);
  useEffect(() => {
    if (arrivedWithNote.current) revealDetail();
  }, [revealDetail]);
  const searching = place.q !== "";
  // Beside the list the reader scrolls on its own; another note starts at its top.
  useEffect(() => {
    if (detailRef.current) detailRef.current.scrollTop = 0;
  }, [detailRef, place.root, place.path]);
  usePageRoom(detailRef);
  return (
    <div className={`library${searching ? " searching" : ""}`}>
      {!searching && <Collections place={place} />}
      <div className="split library-split">
        <div className="library-list">{searching ? <Results place={place} onPick={revealDetail} onClear={onClear} /> : <NoteList place={place} onPick={revealDetail} />}</div>
        <div ref={detailRef} className="split-detail library-reader sticky-detail">
          {place.path ? (
            <NoteReader key={`${place.root}:${place.path}`} root={place.root} relPath={place.path} />
          ) : (
            <p className="reader-placeholder">{searching ? "Pick a result to read its note here." : "Pick a note to read it here: its current state, sources, History and Change log."}</p>
          )}
        </div>
      </div>
    </div>
  );
}

export function BrainView() {
  const loc = useLocation();
  const place = brainPlace(loc.path, loc.search);
  // The query lives in the address (`/brain?q=`), so "All results in Brain" and the back button carry it.
  const query = place.view === "library" ? place.q : "";
  const [q, setQ] = useState(query);
  const address = `${loc.path}?${loc.search.toString()}`;
  // Typing writes the query to the address after a pause, in the Library. An address that changes before then (Back,
  // a link, a tab) cancels that write and fills the field with its own query.
  useEffect(() => {
    if (q.trim() === query) return;
    const h = setTimeout(() => {
      const params = new URLSearchParams(location.search);
      const library = location.pathname === "/brain";
      if (!library) for (const key of [...params.keys()]) params.delete(key);
      if (q.trim()) params.set("q", q.trim());
      else params.delete("q");
      const search = params.toString();
      navigate(`/brain${search ? `?${search}` : ""}`, { replace: library });
    }, QUERY_TO_ADDRESS_MS);
    return () => clearTimeout(h);
  }, [q, query, address]);
  const shownAddress = useRef(address);
  useEffect(() => {
    if (shownAddress.current === address) return;
    shownAddress.current = address;
    setQ((typed) => (typed.trim() === query ? typed : query));
  }, [address, query]);
  const clear = () => {
    setQ("");
    if (place.view === "library") navigate(brainHref({ ...place, q: "" }), { replace: true });
    document.getElementById(BRAIN_SEARCH_ID)?.focus();
  };
  const selectView = (view: "library" | "recent") => {
    // The view shown already keeps its collection, note and filter.
    if (view === place.view) return;
    navigate(view === "recent" ? brainHref({ view }) : brainHref({ view, q: query }));
  };
  return (
    <div className="page brain">
      <div className="brain-head">
        <h1>Brain</h1>
        <BrainMenu />
      </div>
      <BrainSearch q={q} onChange={setQ} />
      <Tabs label="Brain views" tabs={VIEWS} selected={place.view} onSelect={selectView} panelId={VIEW_PANEL} />
      <div id={VIEW_PANEL} role="tabpanel" aria-labelledby={tabId(VIEW_PANEL, place.view)} className="brain-view">
        {place.view === "recent" ? <RecentSaves show={place.show} /> : <Library place={place} onClear={clear} />}
      </div>
    </div>
  );
}

