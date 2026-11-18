import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type RefObject } from "react";
import { plural } from "@attache/contracts";
import { brainResultsHref, hitDestination, hitKind, hitPlace, INLINE_RESULTS, moveActive, rankingLine, resultsRoom, type SearchHit } from "../search.ts";
import { shownAnswer, useSearchAnswer, type SearchState } from "../search-answer.ts";
import { browserPlatform, caretAfter, searchKeyLabel } from "../search-keys.ts";
import { useOpenEvidence } from "./Evidence.tsx";
import { Icon } from "./icons.tsx";
import { StateTag } from "./StateTag.tsx";
import { Link, navigate } from "./ui.tsx";
import type { MeaningStatus } from "@attache/contracts";

/**
 * Keeps the open results inside the visible part of the page: the list scrolls on its own, so moving through the
 * results never scrolls the field away, and scrolling the page never makes the list grow past what shows.
 * Measured on open, on each answer, when the window changes size and when the page scrolls.
 */
function useResultsFit(list: RefObject<HTMLUListElement | null>, open: boolean, answer: unknown) {
  useLayoutEffect(() => {
    const el = list.current;
    if (!open || !el) return;
    const page = el.closest(".page");
    const fit = () => {
      const area = page?.getBoundingClientRect();
      const listTop = el.getBoundingClientRect().top;
      const below = el.parentElement!.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom;
      const visibleTop = Math.max(0, area?.top ?? 0);
      const visibleBottom = Math.min(window.innerHeight, area?.bottom ?? window.innerHeight);
      el.style.maxHeight = `${resultsRoom({ listTop, below, visibleTop, visibleBottom })}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    page?.addEventListener("scroll", fit, { passive: true });
    return () => {
      window.removeEventListener("resize", fit);
      page?.removeEventListener("scroll", fit);
    };
  }, [list, open, answer]);
}

/** The chord on the keycap, as this system writes it. */
const KEY_LABEL = searchKeyLabel(browserPlatform());

const SEPARATOR = "\u00a0· ";

/** What one result says: title, snippet, then kind, the part of the note and where it comes from. */
export function SearchResultRow({ hit }: { hit: SearchHit }) {
  const { kind, section } = hitKind(hit);
  return (
    <span className="search-hit">
      <span className="search-hit-title">
        <span className="search-hit-name">{hit.title}</span>
        {hit.unverified && <StateTag state="partial" label="unverified" />}
      </span>
      <span className="search-hit-snippet">{hit.snippet}</span>
      {/* A no-break space before each dot, so a wrapped line never starts with one. */}
      <span className="search-hit-meta">
        <span className="search-hit-kind">{kind}</span>
        {section && `${SEPARATOR}${section}`}
        {SEPARATOR}
        <span className="search-hit-place">{hitPlace(hit)}</span>
      </span>
    </span>
  );
}

/** How the results were ranked; while only by keywords, why, and where to change it. */
export function RankingNote({ meaning }: { meaning: MeaningStatus }) {
  const line = rankingLine(meaning);
  if (line.ranking === "meaning")
    return (
      <p className="search-ranking" data-ranking="meaning">
        {line.text}
      </p>
    );
  return (
    <p className="search-ranking" data-ranking="keywords" data-keywords-only>
      {line.text}: {line.reason}. <Link to="/settings">Settings</Link>
    </p>
  );
}

/** The line under the results that says what is happening when there is nothing, or nothing new, to choose. */
function SearchStatus({ state, count, retry }: { state: SearchState; count: number; retry: () => void }) {
  if (state.status === "failed")
    return (
      <p className="search-status" role="alert">
        Search failed: {state.message}{" "}
        <button type="button" className="ghost small" onClick={retry}>
          Retry
        </button>
      </p>
    );
  if (state.status === "searching" && count === 0) return <p className="search-status">Searching…</p>;
  if (state.status === "ready" && count === 0) return <p className="search-status">No passages match “{state.query}”. Try other words.</p>;
  return null;
}

/**
 * Search the Brain as one field: a combobox whose listbox shows up to six results as the owner types. Arrow keys
 * choose, `Enter` opens the chosen result (or, with none, all results in the Brain), `Esc` closes the results and
 * keeps the text. A memory note opens in the Brain, anything else in the evidence view at the cited lines.
 * Home places it inline; the search palette (#34 of spec #14) places the same field in a dialog.
 */
export function SearchField({ id, className }: { id: string; className?: string }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const { state, retry } = useSearchAnswer(text, INLINE_RESULTS);
  const answer = shownAnswer(state);
  const hits = answer?.hits ?? [];
  // Only the answer to what the field says now can be chosen; an older one stays on screen, dimmed, to keep its place.
  const current = state.status === "ready" && state.query === text.trim();
  const choosable = current ? hits.length : 0;
  const listId = useId();
  const optionId = (i: number) => `${listId}-option-${i}`;
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const expanded = open && text.trim() !== "";
  useResultsFit(list, expanded, answer);
  const openEvidence = useOpenEvidence();

  // Each new answer chooses its first result, so Enter opens the best match, and shows it from the top.
  useEffect(() => {
    setActive(choosable > 0 ? 0 : -1);
    list.current?.scrollTo({ top: 0 });
  }, [answer, choosable]);

  const openHit = (hit: SearchHit) => {
    setOpen(false);
    const to = hitDestination(hit, text);
    if (to.kind === "brain") navigate(to.href);
    else openEvidence(to.target);
  };
  const showAll = () => {
    setOpen(false);
    navigate(brainResultsHref(text));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // While an input method composes text, its keys are its own.
    if (e.nativeEvent.isComposing) return;
    const field = e.currentTarget;
    const caret = caretAfter(e, { start: field.selectionStart ?? 0, end: field.selectionEnd ?? 0, direction: field.selectionDirection ?? "none" }, field.value.length);
    if (caret) {
      e.preventDefault();
      field.setSelectionRange(caret.start, caret.end, caret.direction);
      // Setting the selection does not scroll the text, so show the end the key moved to.
      field.scrollLeft = e.key === "Home" ? 0 : field.scrollWidth;
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(text.trim() !== "");
        return;
      }
      const next = moveActive(active, choosable, e.key);
      setActive(next);
      requestAnimationFrame(() => document.getElementById(optionId(next))?.scrollIntoView({ block: "nearest" }));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = open && current ? hits[active] : undefined;
      if (hit) openHit(hit);
      else if (text.trim()) showAll();
    }
  };
  // Esc from the field or from a control in the results closes them, keeps the text the browser would otherwise
  // clear, and puts the owner back in the field.
  const onEscape = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || e.nativeEvent.isComposing || !expanded) return;
    e.preventDefault();
    setOpen(false);
    input.current?.focus();
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
  };
  return (
    <div className={`search${className ? ` ${className}` : ""}`} role="search" aria-label="Brain" onBlur={onBlur} onKeyDown={onEscape}>
      <div className="search-box">
        <Icon name="search" size={20} />
        <input
          ref={input}
          id={id}
          type="search"
          role="combobox"
          aria-label="Search the Brain"
          placeholder="Search the Brain"
          autoComplete="off"
          spellCheck={false}
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-activedescendant={expanded && current && active >= 0 ? optionId(active) : undefined}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(e.target.value.trim() !== "");
          }}
          onClick={() => setOpen(text.trim() !== "")}
          onKeyDown={onKeyDown}
        />
        <kbd className="search-key" aria-hidden="true">
          {KEY_LABEL}
        </kbd>
      </div>
      {/* The popup keeps focus in the field: a click on a result or a link still works, but the field stays focused. */}
      <div className="search-popup" hidden={!expanded} onMouseDown={(e) => e.preventDefault()}>
        <ul ref={list} id={listId} role="listbox" tabIndex={-1} aria-label="Results" className="search-results" data-stale={!current || undefined}>
          {hits.map((hit, i) => (
            <li
              key={hit.chunkId}
              id={optionId(i)}
              role="option"
              aria-selected={current && i === active}
              aria-disabled={!current || undefined}
              className="search-option"
              onMouseMove={() => current && setActive(i)}
              onClick={() => current && openHit(hit)}
            >
              <SearchResultRow hit={hit} />
            </li>
          ))}
        </ul>
        <SearchStatus state={state} count={hits.length} retry={retry} />
        <div className="search-foot">
          {answer && <RankingNote meaning={answer.meaning} />}
          <a
            className="search-all"
            href={brainResultsHref(text)}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              showAll();
            }}
          >
            All results in Brain
          </a>
        </div>
      </div>
      <p className="sr-only" role="status">
        {expanded && state.status === "ready" ? plural(hits.length, "result") : ""}
      </p>
    </div>
  );
}
