import { useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { plural } from "@attache/contracts";
import { brainResultsHref, hitDestination, hitKind, hitPlace, INLINE_RESULTS, moveActive, rankingLine, resultsRoom, type SearchHit } from "../search.ts";
import { shownAnswer, useSearchAnswer, type SearchState } from "../search-answer.ts";
import { browserPlatform, caretAfter, searchKeyLabel } from "../search-keys.ts";
import { goToMatches, type GoToEntry } from "../palette.ts";
import { settingsHref, settingsSectionAt } from "../routes.ts";
import { revealSettingsSection } from "../views/settings-section.ts";
import { useOpenEvidence } from "./Evidence.tsx";
import { Icon } from "./icons.tsx";
import { StateTag } from "./StateTag.tsx";
import { navigate } from "./ui.tsx";
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
/**
 * A link inside the results: an ordinary link for a new tab, otherwise `follow`, which the palette uses to close
 * itself before going.
 */
function FollowLink({ href, follow, children }: { href: string; follow: (href: string) => void; children: ReactNode }) {
  return (
    <a
      href={href}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        follow(href);
      }}
    >
      {children}
    </a>
  );
}

export function RankingNote({ meaning, follow = navigate }: { meaning: MeaningStatus; follow?: (href: string) => void }) {
  const line = rankingLine(meaning);
  if (line.ranking === "meaning")
    return (
      <p className="search-ranking" data-ranking="meaning">
        {line.text}
      </p>
    );
  return (
    <p className="search-ranking" data-ranking="keywords" data-keywords-only>
      {line.text}: {line.reason}.{" "}
      <FollowLink href={settingsHref("meaning-search")} follow={follow}>
        Settings
      </FollowLink>
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

/** One choosable place in the palette's Go to group: its glyph, its name and where it is. */
function GoToRow({ place }: { place: GoToEntry }) {
  return (
    <span className="search-place">
      <Icon name={place.icon} size={18} />
      <span className="search-place-name">{place.label}</span>
      <span className="search-place-meta">
        <span className="sr-only">, </span>
        {place.meta}
      </span>
    </span>
  );
}

/** A named group of options inside the listbox (the palette's Go to and Passages). */
function OptionGroup({ label, stale = false, children }: { label: string; stale?: boolean; children: ReactNode }) {
  const id = useId();
  return (
    <li role="group" aria-labelledby={id} className="search-group" data-stale={stale || undefined}>
      <span id={id} className="search-group-label">
        {label}
      </span>
      <ul role="none" className="search-group-options">
        {children}
      </ul>
    </li>
  );
}

/**
 * The field inside the search palette (#34 of spec #14): its results are always shown, with a Go to group of
 * matching screens and Settings sections before the passages, and `leave` closes the palette, then runs `then`
 * (the navigation or evidence the owner chose) once focus is back where it was.
 */
export interface PaletteMode {
  leave: (then?: () => void) => void;
  /** Opens the palette again where the owner left it for evidence. */
  reopen: (resume: PaletteResume) => void;
  /** Where to start: the query, and the passage to choose again once its answer is back. */
  resume: PaletteResume | null;
}

export interface PaletteResume {
  text: string;
  chunkId: number;
}

/**
 * Goes to `href`; for the Settings section the address already names, the address stays and the section comes
 * into view again (Settings only reacts to a changed address).
 */
function goTo(href: string) {
  const section = settingsSectionAt(href);
  if (section && location.pathname === href) revealSettingsSection(section, true);
  else navigate(href);
}

/**
 * Search the Brain as one field: a combobox whose listbox shows up to six results as the owner types. Arrow keys
 * choose, `Enter` opens the chosen result (or, with none, all results in the Brain), `Esc` closes the results and
 * keeps the text. A memory note opens in the Brain, anything else in the evidence view at the cited lines.
 * Home places it inline; the search palette places the same field in a dialog (`palette`), where `Esc` closes it.
 */
export function SearchField({ id, className, palette }: { id: string; className?: string; palette?: PaletteMode }) {
  const [text, setText] = useState(palette?.resume?.text ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const { state, retry } = useSearchAnswer(text, INLINE_RESULTS);
  const answer = shownAnswer(state);
  const hits = answer?.hits ?? [];
  const places = palette ? goToMatches(text) : [];
  // Only the answer to what the field says now can be chosen; an older one stays on screen, dimmed, to keep its place.
  const current = state.status === "ready" && state.query === text.trim();
  // Places come first and are always choosable; the passages follow them.
  const choosable = places.length + (current ? hits.length : 0);
  const listId = useId();
  const optionId = (i: number) => `${listId}-option-${i}`;
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // The palette shows its results all the time; inline, they show while the owner searches.
  const expanded = palette ? true : open && text.trim() !== "";
  useResultsFit(list, expanded && !palette, answer);
  const openEvidence = useOpenEvidence();
  const placesKey = places.map((p) => p.href).join(" ");

  const placeCount = places.length;
  const activeNow = useRef(active);
  activeNow.current = active;
  // The passage the owner opened evidence for from the palette, chosen again when its answer is back.
  const backTo = useRef(palette?.resume?.chunkId ?? null);

  // New places (the owner typed) choose the first option and show the list from the top.
  useEffect(() => {
    setActive(choosable > 0 ? 0 : -1);
    list.current?.scrollTo({ top: 0 });
    // Only the places decide here; an answer has its own effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placesKey]);
  // Each new answer chooses the first option, so Enter opens the best match, unless the owner chose a place, which
  // stays chosen; coming back from evidence, the passage it showed is chosen again.
  useEffect(() => {
    const back = backTo.current;
    const again = back === null || !current ? -1 : (answer?.hits ?? []).findIndex((h) => h.chunkId === back);
    if (again >= 0) {
      backTo.current = null;
      setActive(placeCount + again);
      requestAnimationFrame(() => document.getElementById(optionId(placeCount + again))?.scrollIntoView({ block: "nearest" }));
      return;
    }
    const a = activeNow.current;
    if (a >= 0 && a < placeCount) return;
    setActive(choosable > 0 ? 0 : -1);
    list.current?.scrollTo({ top: 0 });
    // optionId is derived from a stable id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answer, choosable, current, placeCount]);

  const leave = (go: () => void) => {
    setOpen(false);
    if (palette) palette.leave(go);
    else go();
  };
  const openOption = (i: number) => {
    const place = places[i];
    if (place) return leave(() => goTo(place.href));
    const hit = hits[i - places.length];
    if (!hit) return;
    const to = hitDestination(hit, text);
    if (to.kind === "brain") return leave(() => navigate(to.href));
    // From the palette, closing the evidence opens the palette again with this query and this passage chosen, if
    // the owner is still where they opened it (Back or Forward under the drawer leaves the palette closed).
    const resume = { text, chunkId: hit.chunkId };
    const from = location.href;
    const onClosed = () => location.href === from && palette?.reopen(resume);
    leave(() => openEvidence(palette ? { ...to.target, onClosed } : to.target));
  };
  const showAll = () => {
    const href = brainResultsHref(text);
    leave(() => navigate(href));
  };
  /** Follows a link inside the results, closing the palette first. */
  const follow = (href: string) => leave(() => goTo(href));
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
      if (!expanded) {
        setOpen(text.trim() !== "");
        return;
      }
      const next = moveActive(active, choosable, e.key);
      setActive(next);
      requestAnimationFrame(() => document.getElementById(optionId(next))?.scrollIntoView({ block: "nearest" }));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (expanded && active >= 0 && active < choosable) openOption(active);
      else if (text.trim()) showAll();
    }
  };
  // Esc from the field or from a control in the results closes them, keeps the text the browser would otherwise
  // clear, and puts the owner back in the field. In the palette one Esc closes the palette itself.
  const onEscape = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
    if (palette) {
      e.preventDefault();
      palette.leave();
      return;
    }
    if (!expanded) return;
    e.preventDefault();
    setOpen(false);
    input.current?.focus();
  };
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
  };
  const option = (i: number, choosableOption: boolean, row: ReactNode, key: string | number) => (
    <li
      key={key}
      id={optionId(i)}
      role="option"
      aria-selected={choosableOption && i === active}
      aria-disabled={!choosableOption || undefined}
      className="search-option"
      onMouseMove={() => choosableOption && setActive(i)}
      onClick={() => choosableOption && openOption(i)}
    >
      {row}
    </li>
  );
  const hitOptions = hits.map((hit, j) => option(places.length + j, current, <SearchResultRow hit={hit} />, hit.chunkId));
  const searched = text.trim() !== "";
  const spoken = state.status === "ready" ? plural(hits.length, "result") : "";
  return (
    <div className={`search${palette ? " search-palette" : ""}${className ? ` ${className}` : ""}`} role="search" aria-label="Brain" onBlur={palette ? undefined : onBlur} onKeyDown={onEscape}>
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
          aria-activedescendant={expanded && active >= 0 && active < choosable ? optionId(active) : undefined}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(e.target.value.trim() !== "");
          }}
          onClick={() => setOpen(text.trim() !== "")}
          onKeyDown={onKeyDown}
        />
        {!palette && (
          <kbd className="search-key" aria-hidden="true">
            {KEY_LABEL}
          </kbd>
        )}
      </div>
      {/* The popup keeps focus in the field: a click on a result or a link still works, but the field stays focused. */}
      <div className="search-popup" hidden={!expanded} onMouseDown={(e) => e.preventDefault()}>
        <ul ref={list} id={listId} role="listbox" tabIndex={-1} aria-label="Results" className="search-results" data-stale={(!palette && !current) || undefined}>
          {palette ? (
            <>
              {places.length > 0 && <OptionGroup label="Go to">{places.map((place, i) => option(i, true, <GoToRow place={place} />, place.href))}</OptionGroup>}
              {hits.length > 0 && (
                <OptionGroup label="Passages" stale={!current}>
                  {hitOptions}
                </OptionGroup>
              )}
            </>
          ) : (
            hitOptions
          )}
        </ul>
        <SearchStatus state={state} count={hits.length} retry={retry} />
        {searched && (
          <div className="search-foot">
            {answer && <RankingNote meaning={answer.meaning} follow={follow} />}
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
        )}
      </div>
      <p className="sr-only" role="status">
        {expanded && searched ? spoken : ""}
      </p>
    </div>
  );
}
