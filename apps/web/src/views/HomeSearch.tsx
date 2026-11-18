import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "../components/icons.tsx";
import { SearchField } from "../components/SearchField.tsx";
import { Link } from "../components/ui.tsx";
import { HOME_SEARCH_ID } from "../search-launch.ts";

/** The collections Browse opens directly. */
const BROWSE: ReadonlyArray<{ label: string; to: string }> = [
  { label: "People", to: "/brain?tab=person" },
  { label: "Projects", to: "/brain?tab=project" },
  { label: "Decisions", to: "/brain?tab=decision" },
  { label: "Notes", to: "/brain?tab=note" },
  { label: "Recent saves", to: "/brain/recent" },
];

const DATE = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long" });

/** Today in the browser's zone, read again at local midnight and whenever the page is shown again. */
function useToday(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const timer = setTimeout(() => setNow(new Date()), midnight.getTime() - Date.now() + 1000);
    const onShow = () => {
      if (!document.hidden) setNow(new Date());
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [now]);
  return now;
}

/** The local calendar day as `datetime` wants it. */
function isoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Browse: the Brain's collections behind one disclosure beside the field. Open, the links take a line of their own
 * under the field; `Esc` on a link closes them and returns to the button.
 */
function Browse() {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    setOpen(false);
    button.current?.focus();
  };
  return (
    <>
      <button ref={button} type="button" className="browse-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
        Browse
        <Icon name="chevron" size={16} />
      </button>
      <ul id={listId} className="browse-links" hidden={!open} aria-label="Browse the Brain" onKeyDown={onKeyDown}>
        {BROWSE.map((b) => (
          <li key={b.to}>
            <Link to={b.to}>{b.label}</Link>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * Home's first area: a compact heading and today's date over Search the Brain and Browse. The field is not focused
 * on arrival; `Ctrl K`, `Cmd K` and `/` focus it. `recall` is the Search and recall feature, unknown while loading.
 */
export function HomeSearch({ recall }: { recall: boolean | undefined }) {
  const today = useToday();
  return (
    <div className="home-search">
      <div className="home-head">
        <h1 className="home-title">Home</h1>
        <span aria-hidden="true">/</span>
        <time dateTime={isoDay(today)}>{DATE.format(today)}</time>
      </div>
      {recall === false ? (
        <p className="home-search-off">
          Search is off. Turn on Search and recall in <Link to="/settings">Settings</Link>.
        </p>
      ) : (
        <div className="home-search-row">
          <SearchField id={HOME_SEARCH_ID} className="search-home" />
          <Browse />
        </div>
      )}
    </div>
  );
}
